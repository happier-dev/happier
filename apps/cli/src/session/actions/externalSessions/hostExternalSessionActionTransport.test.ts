import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountEncryptionCurrentnessResponseSchema, RPC_METHODS, V2SessionByIdResponseSchema,
  projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol';
import { createCurrentSessionProjectionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { loadPersistedLinkedExternalSession } from '@/api/session/external/takeover/loadLinkedExternalSession';
import { createHostExternalSessionActionTransport } from './hostExternalSessionActionTransport';
import { RpcError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { SessionMetadataTuplePatchV1Schema, SessionMetadataTuplePatchSuccessV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { createExternalSessionFollowLeaseManager } from '@/api/session/external/leases/createExternalSessionFollowLeaseManager';
import { createExternalSessionObservationReconciler } from '@/api/session/external/leases/createExternalSessionObservationReconciler';
import { createExternalSessionObservationProjection } from '@/api/session/external/leases/createExternalSessionObservationProjection';
import { startExternalSessionPassiveObservation } from '@/api/session/external/leases/startExternalSessionPassiveObservation';
import { executeExternalSessionFollowPolicySetAction } from './backgroundFollowAction';
import { executePluginExternalSessionAction } from './pluginExternalSessionActionExecutor';
import { registerActionSpecRpcHandlers } from '@/rpc/handlers/registerActionSpecRpcHandlers';

const boundary = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), rpc: vi.fn() }));
vi.mock('axios', async importOriginal => {
  const actual = await importOriginal<typeof import('axios')>();
  return { ...actual, default: { ...actual.default, get: boundary.get, patch: boundary.patch } };
});
vi.mock('@/persistence', async importOriginal => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readStoredCredentials: async () => credentials,
}));
// Only the outgoing Machine transport is replaced. Session access, encryption
// envelopes, linked identity, semantic admission and output projection stay real.
vi.mock('@/session/transport/rpc/machineRpc', () => ({ callExactMachineRpc: boundary.rpc }));

const credentials = { token: 'fixture-token', encryption: null } as const;
const machineId = 'follow-machine';
const sessionId = 'follow-session';
const remoteSessionId = '  native\nremote/AB+cd==  ';
function installSession() {
  const fields = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'plain', storedContentMode: 'plain',
    agentState: null, metadata: { machineId, externalSessionV1: { v: 1, machineId, agentId: 'codex', remoteSessionId,
      source: { kind: 'codexHome', home: '/tmp/follow-home' }, linkedAtMs: 1 } } });
  const session = createCurrentSessionProjectionRecordFixture({ id: sessionId, encryptionMode: 'plain', share: null,
    metadataLayoutVersion: fields.metadataLayoutVersion, metadata: fields.sharedMetadata.ciphertext, ownerMetadata: fields.ownerMetadata,
    effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
      capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) } });
  let response = V2SessionByIdResponseSchema.parse({ session });
  boundary.patch.mockImplementation(async (_url: string, raw: unknown) => {
    const patch = SessionMetadataTuplePatchV1Schema.parse(raw);
    if (patch.mode === 'shared_editor') throw new Error('Follow policy requires owner metadata');
    const target = patch.mode === 'owner_migration' ? patch.target : patch;
    response = V2SessionByIdResponseSchema.parse({ session: { ...response.session, metadataLayoutVersion: 1,
      metadata: target.sharedMetadata.ciphertext, ownerMetadata: target.ownerMetadata,
      agentState: target.agentState.ciphertext, metadataVersion: response.session.metadataVersion + 1,
      agentStateVersion: (response.session.agentStateVersion ?? 0) + 1 } });
    return { status: 200, data: SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true, metadataLayoutVersion: 1,
      sharedMetadata: { version: response.session.metadataVersion }, agentState: { version: response.session.agentStateVersion } }) };
  });
  const currentness = AccountEncryptionCurrentnessResponseSchema.parse({ mode: 'plain', version: 1,
    signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
  boundary.get.mockImplementation(async (url: string) => {
    const path = new URL(url).pathname;
    if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: response };
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: currentness };
    throw new Error(`unexpected_http:${path}`);
  });
}
function transport() {
  return createHostExternalSessionActionTransport({ credentials, serverId: 'follow-home', serverHttpBaseUrl: 'https://follow.test',
    resolveSessionMachineId: async id => {
      const loaded = await loadPersistedLinkedExternalSession({ credentials, sessionId: id });
      return loaded.ok ? loaded.session.machineId : null;
    } });
}
beforeEach(() => {
  boundary.get.mockReset(); boundary.patch.mockReset(); boundary.rpc.mockReset(); installSession();
  boundary.rpc.mockResolvedValue({ ok: true, enabled: true, leaseActive: true, updatedAtMs: 42 });
});
describe('host External Session follow semantic continuation', () => {
  it('projects loose Machine output through the existing public follow result owner', async () => {
    boundary.rpc.mockResolvedValue({ ok: true, enabled: true, leaseActive: true, updatedAtMs: 42,
      privateNativeObservation: { path: '/private/native' } });
    expect(await transport()({ actionId: 'sessions.external.backgroundFollow.set', input: { sessionId, enabled: true },
      context: { surface: 'cli' } })).toEqual({ ok: true, result: { ok: true, enabled: true, leaseActive: true, updatedAtMs: 42 } });
  });
  it('applies semantic daemon recovery through the real metadata tuple writer and retains raw exact-link refusals', async () => {
    const followLeaseManager = createExternalSessionFollowLeaseManager();
    const reconciler = createExternalSessionObservationReconciler({ acquireObserver: async () => {
      throw new Error('Disabling follow must not acquire an Agent observer');
    } });
    const observationProjection = createExternalSessionObservationProjection({ reconciler,
      publishField: async () => { throw new Error('Disabling an unobserved link must not publish an observation'); } });
    const passiveObservation = startExternalSessionPassiveObservation({ machineId, projection: observationProjection,
      followLeaseManager, startPaused: true, isRestoreEnabled: () => false });
    await passiveObservation.resume();
    const context = { followLeaseManager, observationProjection,
      reconcilePassiveFollowSession: (id: string) => passiveObservation.reconcileSession(id) };
    const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
    registerActionSpecRpcHandlers({
      rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } },
      actionIds: ['sessions.external.backgroundFollow.set'],
      actionExecutor: { execute: async (_actionId, input) => ({
        ok: true, result: await executeExternalSessionFollowPolicySetAction(input, context),
      }) },
    });
    boundary.rpc.mockImplementation(async (request: Readonly<{ method: string; request: unknown }>) => {
      const handler = handlers.get(request.method);
      if (!handler) throw new Error('missing_follow_rpc_registration');
      return await handler(request.request);
    });
    try {
      expect(await transport()({ actionId: 'sessions.external.backgroundFollow.set', input: { sessionId, enabled: false },
        context: { surface: 'cli' } })).toMatchObject({ ok: true, result: { ok: true, enabled: false, leaseActive: false } });
      const visible = await loadPersistedLinkedExternalSession({ credentials, sessionId });
      expect(visible).toMatchObject({ ok: true, session: { metadata: { externalSessionV1: {
        remoteSessionId, followPolicyV1: { policy: 'attached_only' } } } } });
      expect(boundary.patch).toHaveBeenCalledTimes(1);
      expect(await handlers.get(RPC_METHODS.DAEMON_EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET)?.({
        sessionId, enabled: false, machineId, agentId: 'codex', remoteSessionId: 'stale-remote',
        source: { kind: 'codexHome', home: '/tmp/follow-home' },
      })).toEqual({ ok: false, errorCode: 'invalid_request', error: 'linked_session_identity_mismatch' });
      expect(boundary.patch).toHaveBeenCalledTimes(1);
    } finally { await passiveObservation.dispose(); await observationProjection.dispose(); await reconciler.dispose(); await followLeaseManager.dispose(); }
  });
  it.each(['host', 'plugin'] as const)('routes semantic intent to the Machine that owns link admission for %s', async caller => {
    const result = caller === 'host'
      ? await transport()({ actionId: 'sessions.external.backgroundFollow.set', input: { sessionId, enabled: true }, context: { surface: 'cli' } })
      : await executePluginExternalSessionAction({ actionId: 'sessions.external.backgroundFollow.set',
          input: { sessionId, enabled: true }, credentials, pluginId: 'acme.follow' });
    expect(result).toEqual({ ok: true, result: { ok: true, enabled: true, leaseActive: true, updatedAtMs: 42 } });
    expect(boundary.rpc).toHaveBeenCalledWith(expect.objectContaining({ machineId,
      method: RPC_METHODS.DAEMON_EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET,
      request: { sessionId, enabled: true } }));
  });
  it('retains the exact-route fence before any effect', async () => {
    expect(await transport()({ actionId: 'sessions.external.backgroundFollow.set', input: { sessionId, enabled: true },
      context: { surface: 'cli', externalActionTarget: { kind: 'machine', machineId: 'other-machine' } } }))
      .toMatchObject({ ok: false, errorCode: 'target_not_local' });
    expect(boundary.rpc).not.toHaveBeenCalled();
  });
  it('typed-refuses predecessor enable without invoking the retired legacy data plane', async () => {
    boundary.rpc.mockRejectedValue(new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND));
    expect(await transport()({ actionId: 'sessions.external.backgroundFollow.set', input: { sessionId, enabled: true },
      context: { surface: 'cli' } })).toEqual({ ok: true, result: {
        ok: false, errorCode: 'agent_unavailable', error: 'background_follow_not_supported' } });
    expect(boundary.rpc).toHaveBeenCalledTimes(1);
  });
  it('preserves predecessor disable and typed transport failure without replay', async () => {
    boundary.rpc.mockRejectedValueOnce(new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND))
      .mockResolvedValueOnce({ ok: true, enabled: false, leaseActive: false, updatedAtMs: 84 });
    expect(await transport()({ actionId: 'sessions.external.backgroundFollow.set', input: { sessionId, enabled: false },
      context: { surface: 'cli' } })).toEqual({ ok: true, result: { ok: true, enabled: false, leaseActive: false, updatedAtMs: 84 } });
    expect(boundary.rpc).toHaveBeenLastCalledWith(expect.objectContaining({
      method: RPC_METHODS.DAEMON_DIRECT_SESSION_FOLLOW_POLICY_SET_LEGACY,
      request: { sessionId, enabled: false, machineId, providerId: 'codex', remoteSessionId,
        source: { kind: 'codexHome', home: '/tmp/follow-home' } } }));
    boundary.rpc.mockClear();
    boundary.rpc.mockRejectedValue(new RpcError('Method unavailable', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE));
    expect(await transport()({ actionId: 'sessions.external.backgroundFollow.set', input: { sessionId, enabled: false },
      context: { surface: 'cli' } })).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
    expect(boundary.rpc).toHaveBeenCalledTimes(1);
  });
});
