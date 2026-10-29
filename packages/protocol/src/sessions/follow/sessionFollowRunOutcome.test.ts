import { expect, it } from 'vitest';
import { composeExecutionRunWorkerUpdateV1 } from '../relations/workerUpdateV1.js';
import { resolveExecutionRunFollowOccurrenceV1 } from './sessionFollowInputV1.js';
import { SessionFollowPendingObservationV1Schema } from './sessionFollowTransportV1.js';

it('carries a source-owned terminal Run outcome on its exact admitted observation without source-read authority', () => {
  const occurrence = resolveExecutionRunFollowOccurrenceV1({ sessionId: 'source', runId: 'failed-run',
    status: 'failed', terminalEventId: 'terminal' })!;
  const workerUpdate = composeExecutionRunWorkerUpdateV1({ runId: 'failed-run', sessionId: 'source', status: 'failed', canInspect: false });
  const observation = { kind: 'admitted_run_input', localInputId: 'follow-input', destinationSessionId: 'manager',
    delivery: { v: 1, ...occurrence, delivery: 'wake' }, effectiveDelivery: 'wake', workerUpdate };
  expect(SessionFollowPendingObservationV1Schema.safeParse(observation).success).toBe(true);
  const runtimeIssueV1 = { v: 1, scope: 'primary_session', status: 'failed', code: 'usage_limit', source: 'usage_limit',
    occurredAt: 1000, usageLimit: { v: 1, resetAtMs: 1_800_000, retryAfterMs: null, quotaScope: 'provider', recoverability: 'wait' } };
  expect(SessionFollowPendingObservationV1Schema.safeParse({ ...observation,
    workerUpdate: { ...workerUpdate, runtimeIssueV1 } }).success).toBe(true);
  for (const wrong of [
    { ...workerUpdate, workerId: 'another-run' },
    { ...workerUpdate, ownerState: 'succeeded', wake: 'finished' },
    { ...workerUpdate, canInspect: true },
    { ...workerUpdate, result: 'A content-free frontier cannot disclose a Run result' },
    { ...workerUpdate, transcriptPointer: { kind: 'execution_run', sessionId: 'another-source', runId: 'failed-run' } },
  ]) expect(SessionFollowPendingObservationV1Schema.safeParse({ ...observation, workerUpdate: wrong }).success).toBe(false);
  expect(SessionFollowPendingObservationV1Schema.safeParse({ ...observation,
    delivery: { ...observation.delivery, workerUpdate } }).success).toBe(false);
});
