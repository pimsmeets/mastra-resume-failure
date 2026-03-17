/**
 * Minimal reproduction: Mastra buildResumedBlockResult returns "suspended"
 * instead of "failed" when a step throws after resume inside a branch.
 *
 * Bug: buildResumedBlockResult in @mastra/core checks:
 *   all steps success? → "success"
 *   anything else?     → "suspended"   ← never checks for "failed"
 *
 * Run: npx tsx backend/ai-node/src/__tests__/integration/mastraBugRepro.ts
 *
 * @mastra/core v1.8.0
 */
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';
import { z } from 'zod';

const inputSchema = z.object({ query: z.string(), shouldBranch: z.boolean() });

// Step that suspends on first run, throws on resume
const suspendThenFailStep = createStep({
	id: 'suspendThenFail',
	inputSchema,
	outputSchema: z.object({ result: z.string() }),
	resumeSchema: z.object({ answer: z.string() }),
	execute: async ({ suspend, resumeData }) => {
		if (resumeData !== undefined) {
			throw new Error('Step failed after resume');
		}
		await suspend({ question: 'What is your answer?' });
		return undefined as never;
	},
});

// Simple passthrough (other branch)
const passthroughStep = createStep({
	id: 'passthrough',
	inputSchema,
	outputSchema: z.object({ result: z.string() }),
	execute: async ({ inputData }) => ({ result: inputData.query }),
});

// Nested workflow containing the failing step
const nestedWorkflow = createWorkflow({
	id: 'nestedWorkflow',
	inputSchema,
	outputSchema: z.object({ result: z.string() }),
})
	.then(suspendThenFailStep)
	.commit();

// Parent workflow with branch → nested workflow
const parentWorkflow = createWorkflow({
	id: 'parentWorkflow',
	inputSchema,
	outputSchema: z.object({ result: z.string() }),
	steps: [nestedWorkflow, passthroughStep],
})
	.branch([
		[async ({ inputData }) => inputData.shouldBranch === true, nestedWorkflow],
		[async ({ inputData }) => inputData.shouldBranch === false, passthroughStep],
	])
	.commit();

async function main() {
	// Register workflows
	const _mastra = new Mastra({
		workflows: { parentWorkflow, nestedWorkflow },
		storage: new LibSQLStore({ id: 'repro', url: ':memory:' }),
	});

	console.log('=== Step 1: Start workflow (will suspend) ===');
	const run = await parentWorkflow.createRun();
	const startStream = run.stream({
		inputData: { query: 'test', shouldBranch: true },
		closeOnSuspend: true,
	});

	for await (const _chunk of startStream.fullStream) {
		// drain
	}
	const startResult = await startStream.result;
	console.log('Start result status:', startResult.status);
	console.log('');

	console.log('=== Step 2: Resume workflow (step will throw) ===');
	const resumeStream = run.resumeStream({
		resumeData: { answer: 'my answer' },
	});

	const chunks: Array<{ type: string; payload?: Record<string, unknown> }> = [];
	for await (const chunk of resumeStream.fullStream) {
		chunks.push(chunk as { type: string; payload?: Record<string, unknown> });
	}
	const resumeResult = await resumeStream.result;

	// Show what the stream emitted
	const stepResults = chunks.filter((c) => c.type === 'workflow-step-result');
	console.log('Stream step-result chunks:');
	for (const c of stepResults) {
		console.log(`  ${c.payload?.id}: status=${c.payload?.status}`);
	}
	console.log('');

	// Show the final result
	console.log('stream.result.status:', resumeResult.status);
	console.log('step statuses:', JSON.stringify(
		Object.fromEntries(
			Object.entries(resumeResult.steps).map(([k, v]) => [
				k,
				(v as Record<string, unknown>)?.status,
			]),
		),
	));
	console.log('');

	// Verdict
	if (resumeResult.status === 'suspended') {
		console.log('BUG CONFIRMED: Mastra returned "suspended" but the step failed.');
		console.log('Expected: "failed"');
		process.exit(1);
	} else if (resumeResult.status === 'failed') {
		console.log('OK: Mastra correctly returned "failed".');
		process.exit(0);
	} else {
		console.log(`UNEXPECTED: Mastra returned "${resumeResult.status}"`);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error('Unhandled error:', err);
	process.exit(1);
});
