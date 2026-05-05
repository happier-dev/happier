import { createExecutionRunRuntime } from '@/agent/executionRuns/runtime/createExecutionRunRuntime';

// The runtimeCore-backed factory remains the canonical execution-run domain
// entrypoint; the bridge consumes only that entrypoint after helper folding.
export const createExecutionRunBridgeRuntime = createExecutionRunRuntime;
