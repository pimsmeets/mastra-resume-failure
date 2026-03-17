# Bug: `buildResumedBlockResult` returns `"suspended"` instead of `"failed"` when a step throws after resume

## Summary

When a step throws an error after being resumed inside a nested workflow within a `.branch()`, the workflow result incorrectly returns `status: "suspended"` instead of `"failed"`.

The stream correctly emits `workflow-step-result` chunks with `status: "failed"` — the bug is only in the final execution result returned via `buildResumedBlockResult`.

## Affected version

`@mastra/core` 1.13.1

## Root cause

**File:** `packages/core/src/workflows/handlers/entry.ts`
**Function:** `buildResumedBlockResult`

The status resolution logic is binary — it checks whether all steps succeeded, and if not, unconditionally returns `"suspended"`. It never checks for `status === "failed"`:

```ts
const allComplete = stepsToCheck.every(s => {
  if (s.type === 'step') {
    const r = stepResults[s.step.id];
    return r && r.status === 'success';
  }
  return true;
});

if (allComplete) {
  result = { status: 'success', output: /* ... */ };
} else {
  // BUG: assumes anything non-success must be suspended
  const stillSuspended = entrySteps.find(/* ... */);
  result = { status: 'suspended', /* ... */ };
}
```

## Conditions to trigger

All three are required:

1. A **nested workflow** (workflow-as-step) inside a parent workflow's `.branch()`
2. A step inside the nested workflow that **suspends** (calls `suspend()`)
3. On **resume**, the step **throws an error** instead of returning successfully

## Reproduction

Self-contained repro script attached (`mastraBugRepro.ts`). Run with:

```bash
npx tsx mastraBugRepro.ts
```

Output:

```
=== Step 1: Start workflow (will suspend) ===
Start result status: suspended

=== Step 2: Resume workflow (step will throw) ===
Error executing step workflow.nestedWorkflow.step.suspendThenFail: Error: Step failed after resume
Error executing step workflow.parentWorkflow.step.nestedWorkflow: undefined
Stream step-result chunks:
  nestedWorkflow.suspendThenFail: status=failed
  nestedWorkflow: status=failed

stream.result.status: suspended       ← BUG: should be "failed"
step statuses: {"nestedWorkflow":"failed"}

BUG CONFIRMED: Mastra returned "suspended" but the step failed.
Expected: "failed"
```

## Suggested fix

Add a `"failed"` check before falling through to `"suspended"`:

```ts
} else {
  const failedStep = stepsToCheck.find(
    s => s.type === 'step' && stepResults[s.step.id]?.status === 'failed',
  );
  if (failedStep && failedStep.type === 'step') {
    const failedResult = stepResults[failedStep.step.id] as StepFailure<any, any, any, any> | undefined;
    result = {
      status: 'failed',
      error: failedResult?.error ?? new Error('Workflow step failed after resume'),
    };
  } else {
    // existing suspended logic
    const stillSuspended = entrySteps.find(/* ... */);
    result = { status: 'suspended', /* ... */ };
  }
}
```

This function is called from both the **parallel resume** and **conditional resume** paths in `executeEntry`, so the fix covers both.
