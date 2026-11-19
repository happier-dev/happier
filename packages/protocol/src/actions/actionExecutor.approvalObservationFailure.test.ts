import { expect, it } from 'vitest';
import { createActionExecuteFailureError } from './actionExecutionResult.js';
import { createActionExecutor } from './actionExecutor.js';

it.each(['approval.request.get', 'approval.request.list'] as const)(
  '%s returns a typed storage failure instead of rejecting the card Action', async actionId => {
    const failure = { ok: false as const, errorCode: 'artifact_read_unavailable', error: 'artifact_read_unavailable',
      failureCause: { phase: 'artifacts.read', errorClass: 'HttpStatusError' as const,
        errorCode: 'artifact_read_unavailable', httpStatus: 503 } };
    // Artifact HTTP storage is an external boundary; its typed failure is retained by the adapter.
    const unavailable = async () => { throw createActionExecuteFailureError(failure); };
    const executor = createActionExecutor({ approvalsGet: unavailable, approvalsList: unavailable });
    await expect(executor.execute(actionId, actionId === 'approval.request.get' ? { artifactId: 'approval' } : {},
      { surface: 'cli', serverId: 'home', runtimeAccountId: 'actor' }))
      .resolves.toMatchObject(failure);
  },
);
