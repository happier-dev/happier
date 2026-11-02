import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Console } from 'node:console';
import { createServer } from 'node:http';
import axios from 'axios';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import { socketRpcCodec, type SocketRpcContent } from '@happier-dev/sync-client';
import { requestSessionStop } from './requestSessionStop';
import { cleanupForkChildBestEffort } from '@/session/actions/lifecycle/fork/forkChildSessionRecovery';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { openSessionOwnerMetadataEnvelopeV1, sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { SessionMetadataTuplePatchV1Schema, StoredSessionSharedMetadataV1Schema,
  projectSessionOwnerCompatibilityViewV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { readSessionExplicitStopV1FromMetadata, resolveSessionAutoResumeAdmissionV1 } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';
import { createStopSession } from '@/daemon/sessions/stopSession';
import { createMachineSessionStopLifecycleActionExecutor } from '@/session/actions/sessionLifecycleActions';
import { accountSettingsParse } from '@happier-dev/protocol';
import { resolveCliAgentStartContextV1 } from '@/session/actions/resolveCliAgentStartContextV1';
import { logger } from '@/ui/logger';
import { configuration, reloadConfiguration } from '@/configuration';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createActionExecutor, type ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { resolveSessionResumeControlIntent } from './sessionExplicitStopIntent';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { SessionStopResultSchema } from '@happier-dev/protocol/sessions/control/contract';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';

const boundary = vi.hoisted(() => ({ socket: null as unknown, mode: 'timeout', connections: 0 }));
vi.mock('socket.io-client', () => ({ io: () => { boundary.connections++; return boundary.socket; } }));

describe('requestSessionStop machine transport', () => {
  const sessionId = 'cmuo0nwxt11bptmszygswp8g3';
  const secret = new Uint8Array(32).fill(1);
  const credentials = { token: 'test-token', encryption: { type: 'legacy' as const, secret } };
  const content: SocketRpcContent = { mode: 'e2ee', cipher: {
    encryptRaw: async (value) => encodeBase64(encrypt(secret, 'legacy', value)),
    decryptRaw: async (value) => decrypt(secret, 'legacy', decodeBase64(value)),
  } };
  let calls: string[];
  let events: EventEmitter;
  let forwardedTimeout: unknown;
  let issuedMethods: string[];
  let issuedRequestIds: string[];
  let active = false;
  let sessionMetadata: Record<string, unknown>;
  let metadataVersion: number;
  let afterPhysicalStop: (() => void) | undefined;

  function createDeleteExecutor() {
    const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId: '', mode: 'plain', ctx: null });
    return createActionExecutor({ ...createUnavailableActionTransportDeps(), ...createAccountServerActionDeps({ token: credentials.token, credentials,
      serverId: configuration.activeServerId, serverHttpBaseUrl: 'https://delete.test' }),
    sessionStop: deps.sessionStop });
  }

  function deleteContext(confirmed = true): ActionExecutorContext {
    return { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
      runtimeAccountId: 'delete-owner', actionRequestId: 'delete-request', serverId: configuration.activeServerId,
      externalActionTarget: { kind: 'session', sessionId }, actionsSettings: normalizeActionsSettingsV1({ v: 1 }),
      ...(confirmed ? { presentUserConfirmation: { actionId: 'session.delete' as const,
        accountId: 'delete-owner', requestId: 'delete-request', serverId: configuration.activeServerId,
        target: { kind: 'session' as const, sessionId },
        inputDigest: computeActionInputApprovalDigestV1('session.delete', { sessionId }) } } : {}),
    };
  }

  function mockDeleteHttp() {
    return vi.spyOn(axios, 'request').mockImplementation(async request => {
      expect(request.method).toBe('DELETE');
      expect(request.url).toBe(`https://delete.test/v1/sessions/${sessionId}`);
      calls.push('delete');
      return active ? { status: 409, data: { error: 'Session is active' } }
        : { status: 200, data: { success: true } };
    });
  }

  function readPersistedStop() {
    if (sessionMetadata.metadataLayoutVersion === 1) {
      const opened = openSessionOwnerMetadataEnvelopeV1({ accountMode: 'e2ee',
        material: { type: 'legacy', secret }, envelope: sessionMetadata.ownerMetadata });
      if (!opened.ok) throw new Error(`Fixture owner metadata unavailable: ${opened.reason}`);
      if (typeof sessionMetadata.metadata !== 'string') throw new Error('Fixture shared metadata unavailable');
      return readSessionExplicitStopV1FromMetadata(projectSessionOwnerCompatibilityViewV1({
        sharedMetadata: StoredSessionSharedMetadataV1Schema.parse(JSON.parse(sessionMetadata.metadata)),
        ownerMetadata: opened.ownerMetadata,
      }));
    }
    if (typeof sessionMetadata.metadata !== 'string') throw new Error('Fixture metadata unavailable');
    return readSessionExplicitStopV1FromMetadata(decrypt(secret, 'legacy', decodeBase64(sessionMetadata.metadata)));
  }

  beforeEach(() => {
    vi.useFakeTimers();
    boundary.connections = 0;
    calls = [];
    active = false;
    forwardedTimeout = undefined;
    issuedMethods = [];
    issuedRequestIds = [];
    metadataVersion = 0;
    afterPhysicalStop = undefined;
    sessionMetadata = {
      encryptionMode: 'plain', metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }), share: null,
      ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({
        material: { type: 'legacy', secret },
        ownerMetadata: { v: 1, workspace: { machineId: 'owning-machine' } },
        randomBytes: length => new Uint8Array(length).fill(17),
      }),
      machineId: 'owning-machine',
    };
    // Only the network adapters are replaced; resolution, encryption, request disposition,
    // and Stop outcome classification all execute through their production owners.
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'e2ee', version: 1, updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null,
      } };
      if (String(url).includes('/v1/machines/')) return { status: 200, data: { machine: {
        id: 'owning-machine', storageMode: 'e2ee', dataEncryptionKey: null,
      } } };
      return { status: 200, data: { session: {
        id: sessionId, seq: 0, createdAt: 0, updatedAt: 0, active, activeAt: 0,
        metadataVersion, agentState: null, agentStateVersion: 0, dataEncryptionKey: null,
        ...sessionMetadata,
      } } };
    });
    vi.spyOn(axios, 'patch').mockImplementation(async (url, body: unknown) => {
      expect(String(url)).toMatch(new RegExp(`/v2/sessions/${sessionId}$`));
      if (body && typeof body === 'object' && 'mode' in body) {
        const patch = SessionMetadataTuplePatchV1Schema.parse(body);
        if (patch.mode !== 'owner') throw new Error(`Unexpected fixture tuple mode: ${patch.mode}`);
        expect(patch.sharedMetadata.expectedVersion).toBe(metadataVersion);
        sessionMetadata = { ...sessionMetadata, metadata: patch.sharedMetadata.ciphertext,
          ownerMetadata: patch.ownerMetadata, metadataLayoutVersion: patch.metadataLayoutVersion };
        metadataVersion++;
        return { status: 200, data: { success: true, metadataLayoutVersion: 1,
          sharedMetadata: { version: metadataVersion }, agentState: { version: 1 } } };
      }
      if (!body || typeof body !== 'object' || !('metadata' in body)
        || !body.metadata || typeof body.metadata !== 'object'
        || !('ciphertext' in body.metadata) || typeof body.metadata.ciphertext !== 'string'
        || !('expectedVersion' in body.metadata)) throw new Error('Unexpected fixture metadata patch');
      expect(body.metadata.expectedVersion).toBe(metadataVersion);
      sessionMetadata = { ...sessionMetadata, metadata: body.metadata.ciphertext };
      metadataVersion++;
      return { status: 200, data: { success: true, metadata: { version: metadataVersion } } };
    });
    events = new EventEmitter();
    const pendingAcks = new Set<(error: Error) => void>();
    events.on('disconnect', () => {
      for (const reject of pendingAcks) reject(new Error('socket has been disconnected'));
      pendingAcks.clear();
    });
    const emit = async (event: string, payload: unknown, callback?: (response: unknown) => void) => {
      calls.push(event);
      if (event !== SOCKET_RPC_EVENTS.CALL) return;
      forwardedTimeout = (payload as { timeoutMs?: unknown }).timeoutMs;
      const request = payload as { method: string; params: unknown };
      if (payload && typeof payload === 'object' && 'requestId' in payload && typeof payload.requestId === 'string') {
        issuedRequestIds.push(payload.requestId);
      }
      issuedMethods.push(request.method);
      const decoded = await socketRpcCodec.decodeRequestParams(content, request.params, request.method);
      if (boundary.mode === 'no_runtime') {
        const executor = createMachineSessionStopLifecycleActionExecutor({ stopSession: createStopSession({
          pidToTrackedSession: new Map(),
          readHostAttachmentState: async () => ({ status: 'absent' }),
          readTerminalAttachmentInfo: async () => null,
        }) });
        const outcome = await executor.execute('session.stop', decoded.params);
        if (!outcome.ok) throw new Error(outcome.errorCode);
        callback?.({ ok: true, result: await socketRpcCodec.encodeResponse(content, outcome.result, decoded.callId) });
        return;
      }
      const stopped = { ok: true, result: await socketRpcCodec.encodeResponse(content, { status: 'stopped' }, decoded.callId) };
      if (boundary.mode === 'delete_stopped') { active = false; afterPhysicalStop?.(); callback?.(stopped); }
      if (boundary.mode === 'slow_stop') setTimeout(() => callback?.(stopped), 22_410);
      // Mirror the relay's existing finite forwarding deadline, not a caller-owned timer.
      if (boundary.mode === 'timeout') setTimeout(() => callback?.({ ok: false, error: 'RPC call timeout' }), 30_000);
      if (boundary.mode === 'stopped') callback?.(stopped);
      if (boundary.mode === 'action_refused') callback?.({ ok: true, result: await socketRpcCodec.encodeResponse(content,
        { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.stop',
          details: { cause: 'target_outside_led_subtree' } }, decoded.callId) });
      if (boundary.mode === 'action_unknown') callback?.({ ok: true, result: await socketRpcCodec.encodeResponse(content,
        { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown', details: { kind: 'outcomeUnknown' } }, decoded.callId) });
      if (boundary.mode === 'requester_foreign' || boundary.mode === 'requester_unconfirmed' || boundary.mode === 'requester_cleanup') {
        const result = SessionStopResultSchema.parse(boundary.mode === 'requester_foreign'
          ? { sessionId: 'another-session', stopped: true }
          : boundary.mode === 'requester_cleanup' ? { sessionId, stopped: false,
            stopOutcome: { status: 'stopped_cleanup_incomplete', reason: 'terminal_attachment_descriptor_retirement_failed' } }
          : { sessionId, stopped: false, stopOutcome: { status: 'physical_stop_unconfirmed', reason: 'transport_ambiguous' } });
        callback?.({ ok: true, result: await socketRpcCodec.encodeResponse(content, result, decoded.callId) });
      }
      if (boundary.mode === 'disconnect') events.emit('disconnect', 'transport close');
      if (boundary.mode === 'forbidden') callback?.({ ok: false, error: 'Forbidden', errorCode: 'RPC_FORBIDDEN' });
      if (boundary.mode === 'unavailable') callback?.({ ok: false, error: 'RPC method not available', errorCode: 'RPC_METHOD_NOT_AVAILABLE' });
    };
    boundary.socket = {
      io: { timeout: () => {}, on: () => {}, off: () => {} },
      on: events.on.bind(events), off: events.off.bind(events),
      connect: () => boundary.mode === 'connect_error'
        ? events.emit('connect_error', new Error('Connection refused'))
        : events.emit('connect'),
      disconnect: () => undefined, close: () => undefined,
      emit,
      // Socket.IO promise acknowledgements reject on disconnect even without an ack timer.
      emitWithAck: (event: string, payload: unknown) => new Promise((resolve, reject) => {
        pendingAcks.add(reject);
        void emit(event, payload, (response) => { pendingAcks.delete(reject); resolve(response); }).catch(reject);
      }),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each(['confirmed', 'unconfirmed', 'inactive-offline'] as const)(
    'composes confirmed Delete through real Home refusal and Stop transport (%s)', async outcome => {
      active = outcome !== 'inactive-offline';
      boundary.mode = outcome === 'confirmed' ? 'delete_stopped' : outcome === 'unconfirmed' ? 'requester_unconfirmed' : 'unavailable';
      const http = mockDeleteHttp();
      const result = createDeleteExecutor().execute('session.delete', { sessionId }, deleteContext());
      await vi.advanceTimersByTimeAsync(0);
      expect(await result).toMatchObject(outcome === 'unconfirmed'
        ? { ok: false, errorCode: 'session_stop_unconfirmed' } : { ok: true, result: { success: true } });
      expect(http).toHaveBeenCalledTimes(outcome === 'confirmed' ? 2 : 1);
      expect(issuedMethods).toEqual(outcome === 'inactive-offline' ? [] : ['owning-machine:stop-session']);
      if (outcome === 'inactive-offline') expect(axios.get).not.toHaveBeenCalled();
      expect(calls.filter(event => event === 'delete' || event === SOCKET_RPC_EVENTS.CALL))
        .toEqual(outcome === 'confirmed' ? ['delete', SOCKET_RPC_EVENTS.CALL, 'delete']
          : outcome === 'unconfirmed' ? ['delete', SOCKET_RPC_EVENTS.CALL] : ['delete']);
      if (outcome === 'confirmed') expect(readPersistedStop()).toMatchObject({ cause: 'explicit_stop' });
    },
  );

  it.each(['agent', 'stop-require'] as const)('keeps one real Delete review for %s before HTTP or Stop', async variant => {
    active = true;
    boundary.mode = 'delete_stopped';
    const http = mockDeleteHttp();
    let reviews = 0;
    const rows = new Map<string, Record<string, unknown>>();
    // Replace Artifact HTTP storage, preserving the real store, encryption,
    // versioned writes, review transitions and fresh origin admission.
    const get = vi.mocked(axios.get).getMockImplementation();
    vi.mocked(axios.get).mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'e2ee', updatedAt: 1 } };
      if (String(args[0]).includes('/v1/artifacts/')) {
        const row = rows.get(String(args[0]).split('/').at(-1)!);
        return { status: row ? 200 : 404, data: row };
      }
      if (!get) throw new Error('Missing HTTP boundary');
      return await get(...args);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown) => {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid Artifact HTTP body');
      const value = body as Record<string, unknown>;
      if (String(url).endsWith('/v1/artifacts')) {
        reviews++;
        const id = String(value.id);
        rows.set(id, { ...value, ownerAccountId: 'delete-owner', access: 'owner', encryptionMode: 'e2ee',
          headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
        return { status: 200, data: { id, headerVersion: 1, bodyVersion: 1 } };
      }
      const id = String(url).split('/').at(-1)!;
      const current = rows.get(id);
      if (!current) throw new Error('Missing Artifact row');
      if (value.expectedHeaderVersion !== undefined) expect(value.expectedHeaderVersion).toBe(current.headerVersion);
      if (value.body !== undefined) expect(value.expectedBodyVersion).toBe(current.bodyVersion);
      const headerVersion = Number(current.headerVersion) + (value.header === undefined ? 0 : 1);
      const bodyVersion = Number(current.bodyVersion) + (value.body === undefined ? 0 : 1);
      rows.set(id, { ...current, ...(value.header === undefined ? {} : { header: value.header }),
        ...(value.body === undefined ? {} : { body: value.body }), headerVersion, bodyVersion });
      return { status: 200, data: { success: true, headerVersion, bodyVersion } };
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ features: {},
      capabilities: { serverIdentity: { serverIdentityId: 'srv_delete_home' } } }));
    const requiringStop = normalizeActionsSettingsV1({ v: 1, actions: { 'session.stop': { approvalRequiredSurfaces: ['ui'] } },
      approvalWaivedSurfaces: { 'session.delete': ['ui'] } });
    const settings = variant === 'stop-require' ? requiringStop : normalizeActionsSettingsV1({ v: 1 });
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'delete-owner', session: 'delete-signin' })).toString('base64url')}.signature`;
    const executor = createCliActionExecutorFromCredentials({ credentials: { ...credentials, token, credentialProvenance: 'stored_session' },
      serverId: configuration.activeServerId, serverApiUrl: 'https://delete.test', serverIdentityId: 'srv_delete_home',
      pluginActionExecutionOwner: 'current_process',
      actionsSettingsProvider: { getActionsSettings: () => settings,
        getAccountSettings: () => accountSettingsParse({ actionsSettingsV1: settings }) },
    });
    const requested = variant === 'agent'
      ? { ...deleteContext(false), surface: 'agent' as const, authority: 'account_automation' as const }
      : { ...deleteContext(false), actionsSettings: requiringStop };
    const pending = await executor.execute('session.delete', { sessionId }, requested);
    expect(pending, pending.ok ? 'review created' : `${pending.errorCode}: ${pending.error}`)
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    if (!pending.ok || !pending.result || typeof pending.result !== 'object' || !('artifactId' in pending.result)
      || typeof pending.result.artifactId !== 'string') throw new Error('Missing Delete review');
    expect(http).not.toHaveBeenCalled();
    expect(issuedMethods).toEqual([]);
    const deciding = { ...deleteContext(false), surface: 'cli' as const,
      ...(variant === 'stop-require' ? { actionsSettings: requiringStop } : {}) };
    const decision = executor.execute('approval.request.decide', { artifactId: pending.result.artifactId, decision: 'approve' }, deciding);
    await vi.advanceTimersByTimeAsync(0);
    const settled = await decision;
    expect(settled, JSON.stringify(settled))
      .toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
    expect(reviews).toBe(1);
    expect(http).toHaveBeenCalledTimes(2);
    expect(issuedMethods).toEqual(['owning-machine:stop-session']);
  });

  it.each([
    { mode: 'forbidden', code: 'RPC_FORBIDDEN' },
    { mode: 'requester_foreign', code: 'session_stop_unconfirmed' },
    { mode: 'requester_cleanup', code: 'session_stop_unconfirmed' },
    { mode: 'hold-refused', code: 'metadata_tuple_conflict' },
    { mode: 'cancelled', code: 'cancelled' },
  ])('does not retry Home Delete after real Stop $mode', async ({ mode, code }) => {
    active = true;
    boundary.mode = mode === 'hold-refused' || mode === 'cancelled' ? 'delete_stopped' : mode;
    const lifetime = new AbortController();
    if (mode === 'cancelled') afterPhysicalStop = () => lifetime.abort();
    if (mode === 'hold-refused') vi.mocked(axios.patch).mockRejectedValue(new axios.AxiosError('Fixture metadata refusal', 'metadata_tuple_conflict'));
    const http = mockDeleteHttp();
    const result = createDeleteExecutor().execute('session.delete', { sessionId }, { ...deleteContext(), signal: lifetime.signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toMatchObject({ ok: false, errorCode: code });
    expect(http).toHaveBeenCalledTimes(1);
    expect(issuedMethods).toEqual(['owning-machine:stop-session']);
  });

  it('retries after the real empty runtime owner confirms the Session became inactive', async () => {
    active = true;
    boundary.mode = 'no_runtime';
    let attempts = 0;
    vi.spyOn(axios, 'request').mockImplementation(async () => {
      if (attempts++ === 0) { active = false; return { status: 409, data: { error: 'Session is active' } }; }
      return { status: 200, data: { success: true } };
    });
    const result = createDeleteExecutor().execute('session.delete', { sessionId }, deleteContext());
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toMatchObject({ ok: true, result: { success: true } });
    expect(attempts).toBe(2);
    expect(issuedMethods).toEqual(['owning-machine:stop-session']);
  });

  it.each([
    { status: 404, error: 'Session not found or not owned by user', code: 'session_absent' },
    { status: 409, error: 'Session delete condition was lost', code: 'session_delete_conflict' },
  ])('keeps the real Home refusal $code without invoking Stop', async ({ status, error, code }) => {
    const http = mockDeleteHttp().mockResolvedValue({ status, data: { error } });
    expect(await createDeleteExecutor().execute('session.delete', { sessionId }, deleteContext()))
      .toMatchObject({ ok: false, errorCode: code, details: { error } });
    expect(http).toHaveBeenCalledTimes(1);
    expect(issuedMethods).toEqual([]);
  });

  it('returns an active refusal after the one permitted Stop and Delete retry', async () => {
    active = true;
    boundary.mode = 'delete_stopped';
    const http = mockDeleteHttp().mockResolvedValue({ status: 409, data: { error: 'Session is active' } });
    const result = createDeleteExecutor().execute('session.delete', { sessionId }, deleteContext());
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toMatchObject({ ok: false, errorCode: 'session_active', details: { error: 'Session is active' } });
    expect(http).toHaveBeenCalledTimes(2);
    expect(issuedMethods).toEqual(['owning-machine:stop-session']);
  });

  it.each(['input', 'account', 'home', 'target', 'agent'] as const)('does not borrow a native Delete confirmation for another %s', async variant => {
    const http = mockDeleteHttp();
    const original = deleteContext();
    const context = variant === 'account' ? { ...original, runtimeAccountId: 'another-owner' }
      : variant === 'home' ? { ...original, serverId: 'another-home' }
      : variant === 'target' ? { ...original, externalActionTarget: { kind: 'session' as const, sessionId: 'another-session' } }
      : variant === 'agent' ? { ...original, surface: 'agent' as const, authority: 'account_automation' as const } : original;
    expect(await createDeleteExecutor().execute('session.delete', { sessionId: variant === 'input' ? 'another-session' : sessionId }, context))
      .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(http).not.toHaveBeenCalled();
    expect(issuedMethods).toEqual([]);
  });

  it.each(['owning-machine', 'another-machine'])('uses only the installed exact-Machine Stop receiver (%s)', async installedMachineId => {
    active = true;
    boundary.mode = 'unavailable';
    const stoppedSessions: string[] = [];
    const receiver = createMachineSessionStopLifecycleActionExecutor({ stopSession: async target => {
      // Physical process Stop is the OS boundary. Metadata intent, locality,
      // Action transport selection and the actual lifecycle receiver stay real.
      expect(readPersistedStop()).toMatchObject({ cause: 'explicit_stop' });
      stoppedSessions.push(target); active = false; return { status: 'stopped' };
    } });
    const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId: '', mode: 'plain', ctx: null,
      machineActionDirectTargetTransport: { machineId: installedMachineId, invoke: async (method, request) => {
        expect(method).toBe('stop-session');
        const result = await receiver.execute('session.stop', request);
        if (!result.ok) throw new Error(result.errorCode);
        return result.result;
      } },
    });
    const result = await deps.sessionStop!({ sessionId, stopIntent: 'explicit_stop', context: { surface: 'cli', authority: 'present_user' } });
    expect(result).toMatchObject(installedMachineId === 'owning-machine'
      ? { ok: true, sessionId, stopped: true }
      : { ok: true, sessionId, stopped: false, stopOutcome: { reason: 'target_daemon_unavailable' } });
    expect(stoppedSessions).toEqual(installedMachineId === 'owning-machine' ? [sessionId] : []);
    expect(issuedMethods).toEqual(installedMachineId === 'owning-machine' ? [] : ['owning-machine:stop-session']);
  });

  it('routes layout-one Stop through the Account-owned locality instead of caller-local control', async () => {
    boundary.mode = 'stopped';
    vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
    // Observe the real file logger; only HTTP and Socket.IO are replaced above.
    const diagnostic = vi.spyOn(logger, 'warnLocalFile');
    const actionRequestId = 'f2e910c0-0bdd-4f80-ad96-31dc574c701c';
    const result = requestSessionStop({ stopIntent: 'explicit_stop', credentials, idOrPrefix: sessionId,
      actionContext: { surface: 'cli', authority: 'present_user', actionRequestId } });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toContain(SOCKET_RPC_EVENTS.CALL);
      expect(issuedMethods).toEqual(['owning-machine:stop-session']);
      await expect(result).resolves.toEqual({
        ok: true, sessionId, stopped: true,
      });
      expect(calls.filter(event => event === SOCKET_RPC_EVENTS.CALL)).toHaveLength(1);
      expect(readPersistedStop()).toMatchObject({ v: 1, cause: 'explicit_stop' });
      expect(axios.get).toHaveBeenCalledWith(expect.stringContaining(`/v2/sessions/${sessionId}`),
        expect.objectContaining({ headers: expect.objectContaining({
          'X-Happier-Request-Purpose': 'session-detail:session-control',
        }) }));
      expect(issuedRequestIds).toHaveLength(1);
      expect(readPersistedStop()).toMatchObject({ requestId: issuedRequestIds[0] });
      expect(issuedRequestIds[0]).not.toBe(actionRequestId);
      for (const phase of ['stop.resolve_session', 'stop.owner_rpc', 'stop.inactive_projection']) {
        expect(diagnostic.mock.calls).toEqual(expect.arrayContaining([
          ['[external-action-stage]', expect.objectContaining({ actionId: 'session.stop',
            rootRequestId: actionRequestId, stage: `${phase}.begin` })],
          ['[external-action-stage]', expect.objectContaining({ actionId: 'session.stop',
            rootRequestId: actionRequestId, stage: `${phase}.end` })],
        ]));
      }
    } finally { vi.unstubAllEnvs(); }
  });

  it('completes explicit Stop after a real metadata PATCH outlives the generic HTTP cutoff', async () => {
    vi.useRealTimers();
    boundary.mode = 'stopped';
    active = false;
    const get = vi.mocked(axios.get).getMockImplementation()!;
    const patch = vi.mocked(axios.patch).getMockImplementation()!;
    vi.mocked(axios.get).mockRestore();
    vi.mocked(axios.patch).mockRestore();
    const previousTimeout = process.env.HAPPIER_SESSION_CONTROL_HTTP_TIMEOUT_MS;
    process.env.HAPPIER_SESSION_CONTROL_HTTP_TIMEOUT_MS = '1000';
    reloadConfiguration();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const url = `http://fixture${request.url}`;
      const result = request.method === 'PATCH'
        ? await new Promise<Awaited<ReturnType<typeof patch>>>((resolve, reject) => {
            const timer = setTimeout(() => {
              timers.delete(timer);
              const body = SessionMetadataTuplePatchV1Schema.parse(JSON.parse(Buffer.concat(chunks).toString()));
              if (body.mode === 'owner' && body.sharedMetadata.expectedVersion !== metadataVersion) {
                resolve({ status: 409, data: { code: 'session_metadata_version_conflict', metadataLayoutVersion: 1,
                  sharedMetadata: { version: metadataVersion }, agentState: { version: 1 } } });
                return;
              }
              void patch(url, body).then(resolve, reject);
            }, 1500);
            timers.add(timer);
          })
        : await get(url);
      if (!result || typeof result !== 'object' || !('status' in result) || typeof result.status !== 'number'
        || !('data' in result)) throw new Error('Stop fixture HTTP response is invalid');
      response.writeHead(result.status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(result.data));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing Stop fixture address');
    try {
      await expect(runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`, () =>
        requestSessionStop({ stopIntent: 'explicit_stop', credentials, idOrPrefix: sessionId }))).resolves.toMatchObject({
        ok: true, sessionId, stopped: true,
      });
      expect(readPersistedStop()).toMatchObject({ cause: 'explicit_stop' });
      expect(issuedMethods).toEqual(['owning-machine:stop-session']);
    } finally {
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      if (previousTimeout === undefined) delete process.env.HAPPIER_SESSION_CONTROL_HTTP_TIMEOUT_MS;
      else process.env.HAPPIER_SESSION_CONTROL_HTTP_TIMEOUT_MS = previousTimeout;
      reloadConfiguration();
    }
  });

  it('retains the persisted person Stop across a fresh automatic-admission read after an ambiguous acknowledgement', async () => {
    boundary.mode = 'disconnect';
    await expect(requestSessionStop({ stopIntent: 'explicit_stop', credentials, idOrPrefix: sessionId })).resolves.toMatchObject({
      ok: true, stopped: false, stopOutcome: { reason: 'transport_ambiguous' },
    });
    const stop = readPersistedStop();
    expect(stop).toMatchObject({ v: 1, cause: 'explicit_stop', requestId: expect.any(String) });
    expect(resolveSessionAutoResumeAdmissionV1({ metadata: { sessionExplicitStopV1: stop },
      archivedAt: null, machineAvailable: true, authorityAvailable: true })).toBe('held_by_person');
  });

  it('ends the issued physical Stop wait when the ordinary caller lifetime is cancelled', async () => {
    boundary.mode = 'slow_stop';
    const controller = new AbortController();
    const result = requestSessionStop({ stopIntent: 'explicit_stop', credentials, idOrPrefix: sessionId, ...{ signal: controller.signal } });
    await vi.advanceTimersByTimeAsync(0);
    expect(issuedMethods).toEqual(['owning-machine:stop-session']);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    // Cancellation after emission cannot prove whether the receiver stopped.
    const observed: unknown[] = [];
    void result.then(value => observed.push(value));
    await vi.advanceTimersByTimeAsync(0);
    expect(observed).toMatchObject([{
      ok: true, stopped: false, stopOutcome: { status: 'physical_stop_unconfirmed', reason: 'transport_ambiguous' },
    }]);
  });

  it('keeps incidental lifecycle cleanup outside the persisted person Stop contract', async () => {
    boundary.mode = 'stopped';
    await expect(requestSessionStop({ credentials, idOrPrefix: sessionId, stopIntent: 'lifecycle_control' }))
      .resolves.toMatchObject({ ok: true, stopped: true });
    expect(readPersistedStop()).toBeNull();
    expect(vi.mocked(axios.patch)).not.toHaveBeenCalled();
  });

  it.each(['explicit_stop', 'lifecycle_control'] as const)('classifies the session.stop front door before persisting its %s intent', async stopIntent => {
    boundary.mode = 'stopped';
    const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId: '', mode: 'plain', ctx: null });
    const executor = createActionExecutor({ ...deps, isActionApprovalRequired: () => false });
    const result = await executor.execute('session.stop', { sessionId, stopIntent },
      { surface: 'ui', authority: 'present_user' });
    expect(result).toMatchObject({ ok: true, result: { ok: true, stopped: true } });
    const metadata = { ...(readPersistedStop() ? { sessionExplicitStopV1: readPersistedStop() } : {}) };
    expect(resolveSessionAutoResumeAdmissionV1({ metadata, machineAvailable: true, authorityAvailable: true }))
      .toBe(stopIntent === 'explicit_stop' ? 'held_by_person' : 'eligible');
    expect(issuedMethods).toEqual(['owning-machine:stop-session']);
    if (stopIntent === 'lifecycle_control') expect(vi.mocked(axios.patch)).not.toHaveBeenCalled();
  });

  it.each(['automatic', 'own-child', 'grandchild', 'foreign-child', 'misbound-child', 'mismatched-child', 'self'] as const)(
    'retains physical cleanup but authors durable Stop only for an admitted lead on its own child (%s)', async caller => {
      const refused = caller === 'foreign-child' || caller === 'misbound-child' || caller === 'mismatched-child' || caller === 'self';
      boundary.mode = refused ? 'action_refused' : 'stopped';
      sessionMetadata.manager = { sessionId: caller === 'grandchild' ? 'intermediate-session' : 'lead-session' };
      const callerId = caller === 'self' ? sessionId : caller === 'foreign-child' ? 'foreign-session' : 'lead-session';
      const agentStartContext = resolveCliAgentStartContextV1({
        sessionId: caller === 'mismatched-child' ? 'different-caller' : callerId, machineId: 'owning-machine', directory: '/repo',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        metadata: {}, starterDepth: 0, turnDepth: 1, callerPermissionMode: 'default', settings: accountSettingsParse({}), roles: {},
      });
      if (!agentStartContext || 'ok' in agentStartContext) throw new Error('Expected admitted caller context');
      const actionContext = {
        surface: 'agent' as const, authority: 'account_automation' as const,
        defaultSessionId: callerId, sessionListAccess: 'led_subtree' as const, callerPermissionMode: 'default' as const,
        actionsSettings: normalizeActionsSettingsV1({ v: 1, actions: { 'session.stop': { disabledSurfaces: [] } } }),
        actionCaller: caller === 'automatic' ? { kind: 'host' as const }
          : { kind: 'session' as const, sessionId: callerId, starterDepth: 0, turnDepth: 1 },
        ...(caller !== 'automatic' && caller !== 'misbound-child' ? { agentStartContext } : {}),
      };
      // Home membership, metadata HTTP and Socket.IO are the boundaries. The real
      // Action scope guard, Stop service, provenance write and physical port run.
      vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown) => {
        expect(String(url)).toContain('/v2/sessions/read-batch');
        if (!body || typeof body !== 'object' || !('underSessionId' in body)
          || !('sessionIds' in body) || !Array.isArray(body.sessionIds)
          || !body.sessionIds.every(id => typeof id === 'string')) throw new Error('Expected exact membership read');
        const session = (await axios.get(`/v2/sessions/${sessionId}`)).data.session;
        return { status: 200, data: { results: body.sessionIds.map(id => ({ sessionId: id,
          detail: body.underSessionId === 'lead-session' && id === sessionId
            ? { status: 200, body: { session } } : { status: 404, body: { error: 'not_found' } },
        })) } };
      });
      const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId: '', mode: 'plain', ctx: null });
      const executor = createActionExecutor({ ...deps, isActionApprovalRequired: () => false });
      const result = caller === 'automatic' ? await requestSessionStop({ stopIntent: 'explicit_stop', credentials, idOrPrefix: sessionId, actionContext })
        : await executor.execute('session.stop', { sessionId }, actionContext);
      expect(result, JSON.stringify(result)).toMatchObject(refused ? { ok: false } : caller === 'automatic'
        ? { ok: true, stopped: true } : { ok: true, result: { ok: true, stopped: true } });
      if (caller === 'self') expect(result).toMatchObject({ errorCode: 'unsupported_action', error: 'self_stop_forbidden' });
      if (caller === 'own-child' || caller === 'grandchild') expect(readPersistedStop()).toMatchObject({ cause: 'explicit_stop', managerSessionId: 'lead-session' });
      else {
        expect(readPersistedStop()).toBeNull();
        expect(vi.mocked(axios.patch)).not.toHaveBeenCalled();
      }
      expect(issuedMethods).toEqual(refused ? [] : ['owning-machine:stop-session']);
      if (caller === 'own-child' || caller === 'grandchild') {
        const rawSession = await fetchSessionByIdCompat({ token: credentials.token, sessionId });
        expect(rawSession).not.toBeNull();
        if (!rawSession) throw new Error('Expected the exact stopped Session');
        const stop = readPersistedStop();
        expect(resolveSessionResumeControlIntent({ rawSession, actionContext, metadata: { sessionExplicitStopV1: stop } }))
          .toBe(caller === 'grandchild' ? 'authority_unavailable' : 'manager');
        if (stop && !('status' in stop)) {
          const { managerSessionId: _manager, ...personStop } = stop;
          expect(resolveSessionResumeControlIntent({ rawSession, actionContext, metadata: { sessionExplicitStopV1: personStop } }))
            .toBe(caller === 'grandchild' ? 'authority_unavailable' : 'held_by_person');
        }
      }
    });

  it.each([
    { mode: 'stopped', failureCode: 'metadata_tuple_conflict', expectedCode: 'metadata_tuple_conflict' },
    { mode: 'unavailable', failureCode: 'metadata_tuple_conflict', expectedCode: 'metadata_tuple_conflict' },
    { mode: 'stopped', failureCode: 'private-stop-error-payload', expectedCode: 'session_metadata_update_failed' },
  ])('still attempts physical Stop when hold persistence fails ($mode / $expectedCode)', async ({ mode, failureCode, expectedCode }) => {
    boundary.mode = mode;
    const diagnostic = vi.spyOn(logger, 'infoFile');
    const privatePayload = 'private-stop-error-payload';
    vi.mocked(axios.patch).mockRejectedValue(new axios.AxiosError(privatePayload, failureCode, {
      headers: new axios.AxiosHeaders({ Authorization: `Bearer ${privatePayload}` }),
      data: privatePayload,
    }));
    const result = await requestSessionStop({ stopIntent: 'explicit_stop', credentials, idOrPrefix: sessionId });
    expect(result).toMatchObject({ ok: false, errorCode: expectedCode, code: expectedCode,
      sessionId, stopped: mode === 'stopped',
      holdRecorded: false, holdFailure: expectedCode,
      ...(mode === 'unavailable' ? { stopOutcome: { status: 'physical_stop_unconfirmed', reason: 'target_daemon_unavailable' } } : {}),
    });
    expect(SessionStopResultSchema.parse(result)).toMatchObject({ holdRecorded: false, holdFailure: expectedCode });
    expect(result).toMatchObject({ details: { sessionId, stopped: mode === 'stopped',
      holdRecorded: false, holdFailure: expectedCode } });
    expect(readPersistedStop()).toBeNull();
    expect(issuedMethods).toEqual(['owning-machine:stop-session']);
    expect(axios.patch).toHaveBeenCalledTimes(1);
    expect(diagnostic).toHaveBeenCalledWith('[SESSION STOP] Stop hold not recorded', {
      sessionId, phase: 'write_stop_intent', code: expectedCode, classification: { kind: 'protocol_error', retryable: false },
    });
    expect(diagnostic).toHaveBeenCalledWith('[API] session_metadata_update_failed', expect.objectContaining({ code: expectedCode }));
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(privatePayload);
    expect(JSON.stringify(result)).not.toContain(privatePayload);
    expect(SessionStopResultSchema.safeParse({ sessionId, stopped: true,
      holdRecorded: false, holdFailure: privatePayload }).success).toBe(false);
  });

  it('carries a failed hold and confirmed physical Stop through the public Action failure', async () => {
    boundary.mode = 'stopped';
    vi.mocked(axios.patch).mockRejectedValue(new axios.AxiosError('Fixture metadata transport failure', 'metadata_tuple_conflict'));
    const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId: '', mode: 'plain', ctx: null });
    const executor = createActionExecutor({ ...deps, isActionApprovalRequired: () => false });
    const result = await executor.execute('session.stop', { sessionId, stopIntent: 'explicit_stop' },
      { surface: 'cli', authority: 'present_user' });
    expect(result).toMatchObject({ ok: false, errorCode: 'metadata_tuple_conflict',
      details: { sessionId, stopped: true, holdRecorded: false, holdFailure: 'metadata_tuple_conflict' } });
    expect(issuedMethods).toEqual(['owning-machine:stop-session']);
    expect(readPersistedStop()).toBeNull();
  });

  it('waits for inactive evidence without quiet rereads and catches it on reconnect', async () => {
    boundary.mode = 'stopped';
    active = true;
    const result = requestSessionStop({ stopIntent: 'explicit_stop', credentials, idOrPrefix: sessionId });
    await vi.advanceTimersByTimeAsync(0);
    const reads = vi.mocked(axios.get).mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_001);
    expect(vi.mocked(axios.get).mock.calls).toHaveLength(reads);
    active = false;
    events.emit('connect');
    await vi.advanceTimersByTimeAsync(0);
    await expect(result).resolves.toMatchObject({ ok: true, sessionId, stopped: true });
    expect(calls.filter((event) => event === SOCKET_RPC_EVENTS.CALL)).toHaveLength(1);
  });

  it('confirms a stopped Session without opening an unused observation connection', async () => {
    boundary.mode = 'stopped';
    await expect(requestSessionStop({ stopIntent: 'explicit_stop', credentials, idOrPrefix: sessionId })).resolves.toEqual({
      ok: true, sessionId, stopped: true,
    });
    // One Machine RPC connection is necessary. A fresh inactive HTTP row
    // already proves the wait predicate, so no observation socket is needed.
    expect(boundary.connections).toBe(1);
    expect(issuedMethods).toEqual(['owning-machine:stop-session']);
  });

  it('rechecks inactivity after subscribing when the projection changes before subscription', async () => {
    boundary.mode = 'stopped';
    active = true;
    const read = vi.mocked(axios.get).getMockImplementation()!;
    vi.mocked(axios.get).mockImplementation(async (...args) => {
      const response = await read(...args);
      if (String(args[0]).endsWith(`/v2/sessions/${sessionId}`) && issuedMethods.length > 0) {
        // The first post-acknowledgement read captures active=true. The next
        // read sees the transition even though its socket event was missed.
        active = false;
      }
      return response;
    });
    const result = requestSessionStop({ stopIntent: 'explicit_stop', credentials, idOrPrefix: sessionId });
    await vi.advanceTimersByTimeAsync(0);
    await expect(result).resolves.toEqual({ ok: true, sessionId, stopped: true });
    expect(boundary.connections).toBe(2);
  });

  it.each([false, true])('classifies a real empty Stop owner with session active=%s after decoding its acknowledgement', async (sessionActive) => {
    boundary.mode = 'no_runtime';
    active = sessionActive;
    await expect(requestSessionStop({ stopIntent: 'explicit_stop', credentials, idOrPrefix: sessionId })).resolves.toEqual({
      ok: true, sessionId, stopped: false,
      stopOutcome: sessionActive
        ? { status: 'physical_stop_unconfirmed', reason: 'target_session_not_found' }
        : { status: 'already_stopped', reason: 'no_runtime_session_inactive' },
    });
    expect(issuedMethods).toEqual(['owning-machine:stop-session']);
  });

  it.each(['timeout', 'disconnect'])('preserves ambiguous %s after emission even when session metadata is inactive', async (mode) => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    // Vitest buffers console.log; route it through the real Node console to observe
    // the stdout boundary without replacing the production logger.
    const nodeConsole = new Console(process.stdout, process.stderr);
    vi.spyOn(console, 'log').mockImplementation(nodeConsole.log.bind(nodeConsole));
    boundary.mode = mode;
    const result = requestSessionStop({ stopIntent: 'explicit_stop', credentials, idOrPrefix: sessionId });
    await vi.advanceTimersByTimeAsync(30_001);
    await expect(result).resolves.toEqual({
      ok: true, sessionId, stopped: false,
      stopOutcome: { status: 'physical_stop_unconfirmed', reason: 'transport_ambiguous' },
    });
    expect(calls.filter((event) => event === SOCKET_RPC_EVENTS.CALL)).toHaveLength(1);
    expect(stdout).not.toHaveBeenCalled();
  });

  it.each(['public', 'fork_cleanup'])('accepts a bounded %s Stop acknowledgement after the generic caller cutoff', async (entrypoint) => {
    boundary.mode = 'slow_stop';
    let settled = false;
    let fallbackUsed = false;
    const operation = entrypoint === 'public'
      ? requestSessionStop({ stopIntent: 'explicit_stop', credentials, idOrPrefix: sessionId })
      : cleanupForkChildBestEffort({ credentials, sessionId, fallbackStopSession: async () => {
        fallbackUsed = true;
        return true;
      } });
    const result = operation.then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(20_001);
    expect(settled).toBe(false);
    expect(calls).not.toContain(SOCKET_RPC_EVENTS.CANCEL);
    expect(forwardedTimeout).toBeNull();
    await vi.advanceTimersByTimeAsync(2_410);
    if (entrypoint === 'public') await expect(result).resolves.toMatchObject({ ok: true, sessionId, stopped: true });
    else await expect(result).resolves.toBeUndefined();
    expect(fallbackUsed).toBe(false);
    expect(calls.filter((event) => event === SOCKET_RPC_EVENTS.CALL)).toHaveLength(1);
  });

  it('retains a definitive authorization refusal', async () => {
    boundary.mode = 'forbidden';
    await expect(requestSessionStop({ stopIntent: 'explicit_stop', credentials, idOrPrefix: sessionId })).resolves.toMatchObject({
      ok: false, errorCode: 'RPC_FORBIDDEN',
    });
  });

  it('preserves a typed receiver Action refusal instead of reporting daemon unavailability', async () => {
    boundary.mode = 'action_refused';
    await expect(requestSessionStop({ stopIntent: 'explicit_stop', credentials, idOrPrefix: sessionId })).resolves.toMatchObject({
      ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.stop',
      details: { cause: 'target_outside_led_subtree' },
    });
    expect(issuedMethods).toEqual(['owning-machine:stop-session']);
  });

  it('retains a definitive unavailable-target response', async () => {
    boundary.mode = 'unavailable';
    await expect(requestSessionStop({ stopIntent: 'explicit_stop', credentials, idOrPrefix: sessionId })).resolves.toMatchObject({
      stopped: false,
      stopOutcome: { status: 'physical_stop_unconfirmed', reason: 'target_daemon_unavailable' },
    });
  });

  it.each(['requester_foreign', 'requester_unconfirmed'])('does not confirm a %s public Stop receipt', async mode => {
    boundary.mode = mode;
    await expect(requestSessionStop({ stopIntent: 'explicit_stop', credentials, idOrPrefix: sessionId })).resolves.toEqual({
      ok: true, sessionId, stopped: false, stopOutcome: { status: 'physical_stop_unconfirmed',
        reason: mode === 'requester_foreign' ? 'target_daemon_unavailable' : 'transport_ambiguous' },
    });
    expect(issuedMethods).toEqual(['owning-machine:stop-session']);
  });

  it('keeps a receiver Action outcome-unknown response ambiguous even with an inactive row', async () => {
    boundary.mode = 'action_unknown';
    const diagnostic = vi.spyOn(logger, 'infoFile');
    await expect(requestSessionStop({ stopIntent: 'explicit_stop', credentials, idOrPrefix: sessionId })).resolves.toMatchObject({
      ok: true, stopped: false, stopOutcome: { status: 'physical_stop_unconfirmed', reason: 'transport_ambiguous' },
    });
    expect(issuedMethods).toEqual(['owning-machine:stop-session']);
    expect(diagnostic).toHaveBeenCalledWith('[SESSION STOP] Owning-machine acknowledgement failed', {
      sessionId, machineId: 'owning-machine', disposition: 'outcomeUnknown', source: 'receiver_action',
    });
  });

  it('reports unavailable before emission without issuing Stop', async () => {
    boundary.mode = 'connect_error';
    await expect(requestSessionStop({ stopIntent: 'explicit_stop', credentials, idOrPrefix: sessionId })).resolves.toMatchObject({
      stopped: false,
      stopOutcome: { status: 'physical_stop_unconfirmed', reason: 'target_daemon_unavailable' },
    });
    expect(calls).toEqual([]);
  });
});
