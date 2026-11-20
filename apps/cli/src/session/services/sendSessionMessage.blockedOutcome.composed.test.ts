import fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { SESSION_MESSAGE_SEND_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { SessionPendingEnqueueByMachineRequestV1Schema } from '@happier-dev/protocol/sessions/messages/sessionPendingMachineAdmissionV1';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createLocalMachineActionTransportFixture } from '@/testkit/apiMachineTransport';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { sendSessionMessage, waitForSessionInputResult } from './sendSessionMessage';

// Only the Home HTTP and Machine/Session transport boundaries are substituted. Session lookup,
// authoring, Pending admission/status parsing and waiting remain production code.
const sockets = vi.hoisted(() => ({
  createUserScopedSocket: vi.fn(),
  createSessionScopedSocketConnection: vi.fn(),
}));
vi.mock('@/api/session/sockets', () => sockets);

describe('Send preserves the effect uncertainty of blocked accepted input', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    { target: 'session', reason: 'delivery_outcome_uncertain', uncertain: true },
    { target: 'execution_run', reason: 'delivery_outcome_uncertain', uncertain: true },
    { target: 'session', reason: 'team_access_removed', uncertain: true },
    { target: 'session', reason: 'team_access_removed', uncertain: true, committedRefusal: true },
    { target: 'execution_run', reason: 'team_access_removed', uncertain: true },
    { target: 'session', reason: 'session_input_target_unavailable', uncertain: false },
    { target: 'execution_run', reason: 'session_input_target_unavailable', uncertain: false },
  ] as const)('$target: projects $reason (committed refusal: $committedRefusal) with the original effect uncertainty', async row => {
    const { target, reason, uncertain } = row;
    const inputDeliveryIssue: SessionRuntimeIssueV1 | undefined = 'committedRefusal' in row ? {
      v: 1, scope: 'primary_session', status: 'failed', code: 'team_access_removed',
      source: 'team_credential', occurredAt: 2,
      failureCause: { phase: 'turn_start', failureReason: 'permission_denied', providerErrorCode: 'team_access_removed' },
    } : undefined;
    const app = fastify();
    const origin = 'http://send-blocked.test';
    const sessionId = 'c123456789012345678901234';
    const localId = 'ed5e8f72-d963-47f3-90b8-19f6324df8e8';
    const recipient = target === 'execution_run' ? { kind: 'execution_run' as const, runId: 'run-a' } : undefined;
    const pendingPath = `/v2/sessions/${sessionId}${recipient ? `/execution-runs/${recipient.runId}` : ''}/pending`;
    const accepted = new Set<string>();
    sockets.createSessionScopedSocketConnection.mockImplementation(() => {
      const socket = createApiSessionSocketStub();
      return { socket, transport: createSocketTransportAdapter(socket) };
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      features: {}, capabilities: { session: { pendingInput: { protocolVersion: 3 } } },
    }), { status: 200 })));
    app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
    app.get(`/v2/sessions/${sessionId}`, async () => ({ session: createSessionRecordFixture({
      id: sessionId, active: true, encryptionMode: 'plain', dataEncryptionKey: null,
      metadata: JSON.stringify({ machineId: 'machine-a' }),
    }) }));
    app.post<{ Body: { localId: string; requestedAction: unknown } }>(pendingPath, async request => {
      accepted.add(request.body.localId);
      return { didWrite: true, pending: { localId: request.body.localId }, requestedAction: request.body.requestedAction };
    });
    app.get(`/v2/sessions/${sessionId}/messages/by-local-id/:localId`, async () => {
      expect(accepted.has(localId)).toBe(true);
      // The incident's user row was already committed when Turn publication
      // failed after native acceptance; a committed row cannot decide effects.
      return { message: { id: 'committed-input', seq: 3, localId, createdAt: 1, updatedAt: 1,
        sidechainId: recipient ? 'sidechain-a' : null,
        ...(inputDeliveryIssue ? { inputDeliveryIssue } : {}),
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Run pwd' } } } } };
    });
    app.get(`/v2/sessions/${sessionId}/messages/by-local-id/:localId/reply`, async () => ({ v: 1, status: 'unavailable' }));
    app.get(`/v2/sessions/${sessionId}/messages/reply-capability`, async () => ({ v: 1, protocolVersions: [1] }));
    app.get(pendingPath, async () => ({ ...(recipient ? { recipient } : {}), pending: [{
      localId, status: 'queued', requestedAction: { v: 1, kind: 'send_now' },
      deliveryState: 'blocked', deliveryBlockedReason: reason,
    }] }));
    await app.ready();
    const restore = installAxiosFastifyAdapter({ app, origin });
    try {
      const send = (wait: boolean, inputId: string) => runWithServerHttpBaseUrl(origin, () => sendSessionMessage({
        credentials: { token: 'requester', encryption: null }, idOrPrefix: sessionId,
        message: 'Run pwd', localId: inputId, ...(recipient ? { recipient } : {}),
        requestedAction: { v: 1, kind: 'send_now' }, wait, timeoutMs: 1000,
      }));
      // The same real admission path must work before its blocked observation
      // can count as evidence about the projection.
      expect(await send(false, 'admission-control')).toMatchObject({ ok: true,
        admissionResult: { status: 'accepted', localId: 'admission-control' } });
      const admissionResult = uncertain
        ? { status: 'outcomeUnknown', localId, code: 'session_input_turn_outcome_unknown' }
        : { status: 'rejected', code: reason };
      const settlementResult = {
        status: 'failed', localId, code: 'session_input_turn_failed', runtimeIssueV1: inputDeliveryIssue,
      };
      const sent = await send(true, localId);
      expect(sent).toMatchObject({ ok: false, code: 'wait_failed', admissionResult });
      if (inputDeliveryIssue) {
        const credentials = { token: 'requester', encryption: null };
        const deps = createCliActionDeps({
          credentials, token: credentials.token, mode: 'plain', ctx: null, sessionId, serverHttpBaseUrl: origin,
          machineActionDirectTargetTransport: createLocalMachineActionTransportFixture('machine-a'),
          machineAdmissionTransport: async request => {
            const admitted = SessionPendingEnqueueByMachineRequestV1Schema.parse(request);
            expect(admitted.targetMachineId).toBe('machine-a');
            accepted.add(admitted.localId);
            return { status: 'accepted', localId: admitted.localId };
          },
        });
        const executor = createActionExecutor({
          ...deps,
          readActionsSettings: () => ActionsSettingsV1Schema.parse({
            v: 1, approvalWaivedSurfaces: { [SESSION_MESSAGE_SEND_ACTION_ID_V1]: ['cli'] },
          }),
        });
        const execute = (observation: { wait: boolean } | { reply: 'wait' }, inputId: string) => runWithServerHttpBaseUrl(origin, () => executor.execute(SESSION_MESSAGE_SEND_ACTION_ID_V1,
          { sessionId, localId: inputId, message: 'Run pwd', ...observation, timeoutSeconds: 1, requestedAction: { v: 1, kind: 'send_now' } },
          { surface: 'cli', authority: 'present_user', defaultSessionId: sessionId }));
        const control = await execute({ wait: false }, 'action-admission-control');
        expect(control, JSON.stringify(control)).toMatchObject({ ok: true, result: {
          status: 'accepted', localId: 'action-admission-control',
        } });
        expect.soft(sent).toMatchObject({ settlementResult });
        for (const observation of [{ wait: true }, { reply: 'wait' }] as const) {
          const action = await execute(observation, localId);
          expect.soft(action, JSON.stringify({ observation, action })).toMatchObject({ ok: true, result: { ...admissionResult, settlementResult } });
        }
      }
      if (!recipient) {
        for (const observeReply of [false, true]) {
          expect(await runWithServerHttpBaseUrl(origin, () => waitForSessionInputResult({
            credentials: { token: 'requester', encryption: null }, idOrPrefix: sessionId,
            localId, observeReply, observation: { kind: 'absolute_deadline', deadlineMs: Date.now() },
          }))).toMatchObject({ ok: true, sessionId, localId,
            result: inputDeliveryIssue ? { kind: 'failed', runtimeIssueV1: inputDeliveryIssue }
              : { kind: uncertain ? 'pending' : 'failed' } });
        }
      }
    } finally {
      restore();
      await app.close();
    }
  });
});
