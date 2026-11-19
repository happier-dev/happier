import { afterEach, expect, it, vi } from 'vitest';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/executor/types';
import { WorkflowInvocationListResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { V2SessionByIdResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { readWorkflowChildSession, waitForWorkflowChildSession } from './workflowChildSession';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('observes public child correspondence after a valid Session startup exceeds the generic wait', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const runId = '11111111-1111-4111-8111-111111111111';
  const invocationId = '22222222-2222-4222-8222-222222222222';
  const index = { id: invocationId, runId, sequence: '0', parentRecordId: null,
    memberOrdinal: '0', attempt: '0', contentRevision: '1', lifecycle: 'running',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
  const page = WorkflowInvocationListResultV1Schema.parse({ invocations: [index], parentRevision: 1,
    invocationDetails: [{ index, parentRevision: 1, progress: {
      kind: 'happier.workflow-progress.v1', blockKind: 'step', invocationPath: { blockId: 'diagnose', scope: [] },
      attempt: '0', logicalInvocationRecordId: invocationId,
      execution: { kind: 'session', sessionId: 'child-session', localInputId: 'input-1' },
    } }] });
  const response = V2SessionByIdResponseSchema.parse({ session: {
    id: 'child-session', origin: { kind: 'run_step', runId }, seq: 0, createdAt: 0, updatedAt: 0,
    active: true, activeAt: 0, metadata: '', metadataVersion: 0, agentState: null,
    agentStateVersion: 0, dataEncryptionKey: null,
  } });
  // Action execution and HTTP are process boundaries; the progress reader,
  // schema validation and containing wait remain real.
  const execute = async (): Promise<ActionExecuteResult> => ({ ok: true,
    result: Date.now() >= 20_000 ? page : { invocations: [], invocationDetails: [], parentRevision: 0 } });
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(response)));
  let session: Awaited<ReturnType<typeof readWorkflowChildSession>> = null;
  const outcome = waitForWorkflowChildSession(async () => {
    session = await readWorkflowChildSession({ execute, serverBaseUrl: 'http://localhost',
      token: 'fixture-token', runId, blockId: 'diagnose' });
    return session !== null;
  }, 'Run admission and public diagnosis child').then(() => ({ kind: 'observed' }),
    (error: unknown) => ({ kind: 'failed', error }));
  await vi.advanceTimersByTimeAsync(20_050);
  expect(await outcome).toEqual({ kind: 'observed' });
  expect(session).toMatchObject({ id: 'child-session', origin: { kind: 'run_step', runId } });
});

it('fails immediately when public invocation history refuses the child read', async () => {
  const execute = async (): Promise<ActionExecuteResult> => ({ ok: false, errorCode: 'storage_unavailable' });
  await expect(waitForWorkflowChildSession(async () => await readWorkflowChildSession({
    execute, serverBaseUrl: 'http://localhost', token: 'fixture-token', runId: 'run', blockId: 'diagnose',
  }) !== null, 'Refused public child')).rejects.toThrow('storage_unavailable');
});
