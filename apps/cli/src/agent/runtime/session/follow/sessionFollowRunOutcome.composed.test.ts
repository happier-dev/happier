import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { resolveExecutionRunFollowOccurrenceV1, SessionFollowInputV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { composeExecutionRunWorkerUpdate } from '@/agent/runtime/bridges/executionRun/executionRunWorkerUpdate';
import type { ExecutionRunState } from '@/agent/runtime/bridges/executionRun/executionRunTypes';
import { projectExecutionRunHostLoss } from '@/agent/runtime/bridges/executionRun/retainedState';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { prepareSessionInputForProviderDispatch } from '@/agent/runtime/turns/prepareSessionInputForProviderDispatch';
import { createSessionFollowSourceHydrator } from './sessionFollowSourceHydrator';
import { createSessionFollowContextReconciler } from './sessionFollowContextReconciler';

afterEach(() => vi.restoreAllMocks());

it.each(['host_loss', 'usage_limit'] as const)('delivers a followed Run %s outcome at final input without a native source read or early ACK', async cause => {
  const state = { runId: 'failed-run', callId: 'call', sidechainId: 'sidechain', sessionId: 'source', depth: 0,
    intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, backendId: 'codex', instructions: '',
    permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'request_response',
    status: 'running', startedAtMs: 1, notifyParentOnCompletion: true } satisfies ExecutionRunState;
  const lost = projectExecutionRunHostLoss({ state, ownerPid: 123 }, 2);
  const runtimeIssueV1 = { v: 1, scope: 'primary_session', status: 'failed', code: 'usage_limit', source: 'usage_limit',
    occurredAt: 1000, usageLimit: { v: 1, resetAtMs: 1_800_000, retryAfterMs: null, quotaScope: 'provider', recoverability: 'wait' } } as const;
  const failed = cause === 'host_loss' ? lost.state : { ...state, status: 'failed' as const, finishedAtMs: 2,
    error: { code: 'usage_limit', runtimeIssueV1 } };
  const terminalEventId = cause === 'host_loss' ? lost.terminalEventId! : 'usage-limit-terminal';
  const source = composeExecutionRunWorkerUpdate(failed, terminalEventId)!;
  const occurrence = resolveExecutionRunFollowOccurrenceV1({ sessionId: 'source', runId: state.runId,
    status: failed.status, terminalEventId })!;
  const delivery = SessionFollowInputV1Schema.parse({ v: 1, ...occurrence, delivery: 'wake' });
  const { result: _result, ...outcome } = source.update;
  const workerUpdate = { ...outcome, canInspect: false };
  let provideOutcome = true;
  const reads = vi.spyOn(axios, 'get').mockRejectedValue(new Error('Follow is not native Run-read authority'));
  const posts = vi.spyOn(axios, 'post').mockRejectedValue(new Error('No content read is needed for the delivered outcome'));
  const acknowledgements: unknown[] = [];
  const session = createMutableApiSessionClientFixture({ sessionId: 'manager', overrides: {
    observePendingSessionFollow: async () => ({ ok: true, v: 1, sessionId: 'manager', publisherGeneration: '1',
      currentSourceSessionIds: [], observations: [{ kind: 'admitted_run_input', localInputId: 'follow-input',
        destinationSessionId: 'manager', delivery, effectiveDelivery: 'wake', ...(provideOutcome ? { workerUpdate } : {}) }] }),
    acknowledgeSessionFollow: async request => { acknowledgements.push(request); return {
      ok: true, v: 1, destinationSessionId: 'manager', localInputId: 'follow-input', original: occurrence.original,
    }; },
  } });
  const reconcile = createSessionFollowContextReconciler({ session, maxFollowContextUtf8Bytes: 8192,
    hydrateObservation: createSessionFollowSourceHydrator({ session, credentials: { token: 'token', encryption: null } }) });
  const followDeliveries = [{ delivery, localInputId: 'follow-input', userMessageSeq: 1 }];
  const prepared = await reconcile({ signal: new AbortController().signal, followDeliveries });
  expect(prepared?.workerUpdates).toEqual([workerUpdate]);
  expect(prepared?.workerUpdateEvents).toMatchObject([{ update: { workerKind: 'execution_run', workerId: 'failed-run',
    ownerState: 'failed', canInspect: false }, followInputLocalId: 'follow-input' }]);
  const dispatch = await prepareSessionInputForProviderDispatch({ prompt: { text: 'Followed Run changed.', followDeliveries },
    transformedUserText: 'Followed Run changed.', providerNativeCommand: false, localId: 'follow-input', signal: new AbortController().signal });
  const text = dispatch.renderPrompt({ workerUpdates: prepared!.workerUpdates, runFollowDeliveries: followDeliveries });
  expect(text).toContain('<worker_update>');
  expect(text).toContain('failed-run');
  expect(text).toContain('owner_state="failed"');
  expect(text).not.toContain('Read the original Run result.');
  if (cause === 'usage_limit') expect(text).toContain('"resetAtMs":1800000');
  else expect(text).not.toContain('runtime_issue=');
  expect(reads).not.toHaveBeenCalled();
  expect(posts).not.toHaveBeenCalled();
  expect(acknowledgements).toEqual([]);
  expect(await prepared!.recheckAdmission(new AbortController().signal)).toBe(true);
  expect(await reconcile({ signal: new AbortController().signal, followDeliveries, maxFollowContextUtf8Bytes: 1 })).toBeNull();
  provideOutcome = false;
  expect(await prepared!.recheckAdmission(new AbortController().signal)).toBe(false);
  expect(await reconcile({ signal: new AbortController().signal, followDeliveries })).toBeNull();
  expect(acknowledgements).toEqual([]);
  provideOutcome = true;
  prepared!.acknowledgeAccepted({ kind: 'admitted_input', localInputId: 'follow-input', userMessageSeq: 1 });
  await vi.waitFor(() => expect(acknowledgements).toHaveLength(1));
});
