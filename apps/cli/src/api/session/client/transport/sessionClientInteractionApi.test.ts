import { AxiosError, AxiosHeaders } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createManagedConnectionSupervisor, DEFAULT_MANAGED_CONNECTION_POLICY } from '@happier-dev/connection-supervisor';

import { logger } from '@/ui/logger';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createDeferred } from '@/testkit/async/deferred';
import { createSessionClientInteractionApi } from './sessionClientInteractionApi';
import { createSessionClientMaterializationRuntime } from '../lifecycle/createSessionClientMaterializationRuntime';
import { createSessionClientRecoveryRuntime } from '../lifecycle/createSessionClientRecoveryRuntime';
import { encodeBase64, encrypt } from '../../../encryption';
import { runPermissionModePromptLoop, type PermissionModePromptLoopTurnOperations } from '@/agent/runtime/runPermissionModePromptLoop';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { combinePermissionModeQueuedPrompts, type PermissionModeQueuedPrompt, type PermissionModeQueuedPromptMode } from '@/agent/runtime/permissions/queuedPrompt';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { registerPermissionModeMessageQueueBinding } from '@/agent/runtime/permissions/bindModeQueue';
import type { UserMessage } from '@/api/types';
import { assertSessionInputAdmissionReceiptForAuthorityV1, readSessionInputRequest, settleSessionInputRequestV1, withSessionInputAuthority } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import * as sessionEncryption from '@/session/transport/encryption/sessionEncryptionContext';
import { encryptSessionPayload } from '@/session/transport/encryption/sessionEncryptionContext';
import { SessionPendingAdmissionSettlementRequestV1Schema } from '@happier-dev/protocol/sessions/messages/sessionPendingAdmissionSettlementV1';
import { resolveAutonomousExchangeAfterTurnsV1 } from '@happier-dev/protocol/sessions/messages/autonomousExchangeV1';
import type { SessionMessageContent } from '@/api/types';
import { PassThrough } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SessionAttachmentHandleV1Schema } from '@happier-dev/protocol';
import { createEncryptedTransferChunkEnvelope } from '@happier-dev/transfers/node';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { RpcRequest } from '@/api/rpc/types';
import { createSessionRpcAuthorization } from '../sessionRpcAuthorization';
import { registerSessionHandlers } from '@/rpc/handlers/registerSessionHandlers';
import { runFilesystemEffectInternal } from '@/rpc/handlers/fileSystem/filesystemEffectInternal';
import { createFilesystemEffectChannel, initializeFilesystemEffectChannel } from '@/rpc/handlers/fileSystem/filesystemEffectChannel';
import type { SessionAttachmentNativeRuntime } from '@/rpc/handlers/fileSystem/sessionAttachmentIntake';
import { withTempDir } from '@/testkit/fs/tempDir';

const axiosGetMock = vi.hoisted(() => vi.fn());
const axiosPostMock = vi.hoisted(() => vi.fn());
const socketAckMock = vi.hoisted(() => vi.fn());

vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return {
    ...actual,
    default: {
      ...actual.default,
      get: axiosGetMock,
      post: axiosPostMock,
      isAxiosError: actual.default.isAxiosError,
    },
    get: axiosGetMock,
    post: axiosPostMock,
    isAxiosError: actual.isAxiosError,
  };
});

function createSecretAxiosError(): AxiosError {
  return new AxiosError('Initial catch-up failed Authorization: Bearer MESSAGE_SECRET', 'ERR_BAD_RESPONSE', {
    method: 'get',
    url: 'https://api.example.test/v1/sessions/s1/messages?token=QUERY_SECRET',
    headers: new AxiosHeaders({ Authorization: 'Bearer HEADER_SECRET' }),
    data: { access_token: 'BODY_SECRET' },
  });
}

function createSocketStub() {
  const handlers = new Map<string, Set<(...args: any[]) => void>>();
  const socket = {
    connected: true,
    emit: vi.fn(),
    emitWithAck: socketAckMock,
    timeout: vi.fn(() => socket),
    volatile: { emit: vi.fn() },
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
    }),
    off: vi.fn((event: string, handler: (...args: any[]) => void) => {
      handlers.get(event)?.delete(handler);
    }),
    trigger: (event: string, ...args: any[]) => {
      for (const handler of handlers.get(event) ?? []) {
        handler(...args);
      }
    },
    disconnect: vi.fn(),
  };
  return socket;
}

function mockProviderSocketAck(response: { data: unknown }) {
  socketAckMock.mockResolvedValueOnce(response.data);
}

describe('createSessionClientInteractionApi diagnostics', () => {
  beforeEach(() => {
    axiosGetMock.mockReset();
    axiosPostMock.mockReset();
    socketAckMock.mockReset();
    vi.restoreAllMocks();
  });

  function createApi(overrides: Partial<Parameters<typeof createSessionClientInteractionApi>[0]> = {}) {
    const socket = createSocketStub();
    const defaultContractResult = {
      mode: 'session_sync_v2_pending_input_v1' as const,
      runtimeActivity: 'v2' as const,
      pendingInput: 'v1' as const,
      publisherAuthority: 'indeterminate' as const,
      sessionConnectionEpoch: 1,
      socket: overrides.getSocket?.() ?? socket,
    };
    return createSessionClientInteractionApi({
      serverId: 'home',
      getServerIdentityId: () => 'home',
      sessionId: 's1',
      token: 'token-1',
      getClosed: () => false,
      setClosed: vi.fn(),
      getSocket: () => socket as never,
      getSessionConnectionEpoch: () => 1,
      getSessionSyncPendingInputServerContractResult: () => defaultContractResult,
      getUserSocket: () => socket as never,
      getSessionConnectionSupervisor: () => null,
      getRpcHandlerManager: () => ({ handleRequest: vi.fn(async () => null) }),
      getMetadata: () => null,
      updateMetadata: vi.fn(async () => {}),
      setMetadata: vi.fn(),
      getMetadataVersion: () => 0,
      setMetadataVersion: vi.fn(),
      onMetadataUpdated: vi.fn(),
      offMetadataUpdated: vi.fn(),
      getAgentStateVersion: () => 0,
      getPendingClaimForegroundState: () => 'ready',
      getPendingWakeSeq: () => 0,
      getProviderInputBacklog: () => [],
      setProviderInputConsumer: vi.fn(),
      getProviderInputConsumerAttachedAtMs: () => null,
      setProviderInputConsumerAttachedAtMs: vi.fn(),
      wakePendingMaterialization: vi.fn(),
      kickUserSocketConnect: vi.fn(),
      catchUpSessionMessages: vi.fn(async () => {}),
      getLastObservedMessageSeq: () => 0,
      getStartupMessageCatchUpExplicitAfterSeq: () => null,
      getStartedByDaemonProcess: () => true,
      getMetadataStartedBy: () => null,
      getMetadataStartedFromDaemon: () => null,
      getStartupMessageCatchUpStarted: () => false,
      setStartupMessageCatchUpStarted: vi.fn(),
      enqueueSessionUserMessage: vi.fn(),
      syncSessionSnapshotFromServer: vi.fn(),
      reconcileTurnStatusBeforePendingMaterialization: vi.fn(async () => true),
      maybeScheduleUserSocketDisconnect: vi.fn(),
      handleSessionScopedUpdate: vi.fn(),
      clearPendingMaterializedState: vi.fn(),
      getPendingQueueMaterializedLocalIdsSize: () => 0,
      markPendingQueueMaterializedLocalId: vi.fn(),
      shouldAttemptPendingMaterialization: () => true,
      getPendingQueueState: () => ({ known: false as const }),
      applyPendingQueueState: vi.fn(() => false),
      onPendingQueueStateChanged: vi.fn(),
      getStoredContentCryptoContext: () => ({
        mode: 'e2ee' as const,
        ctx: {
          encryptionKey: new Uint8Array(32),
          encryptionVariant: 'legacy' as const,
        },
      }),
      ...overrides,
    });
  }

  it.each(['owner', 'member'] as const)('uploads and resolves a native %s attachment through the authenticated Session socket', async actor => {
    const installation = await readOrCreateInstallationIdentity();
    await withTempDir('session-socket-attachment-', async directory => {
      const socket = createSocketStub();
      const accountId = actor === 'owner' ? 'machine-owner' : 'member-b';
      const requester = { sessionId: 's1', homeServerIdentityId: 'home', identity: {
        kind: 'isolated' as const, separationRequired: actor === 'member', requester: {
          serverId: 'home-profile', accountId, machineId: 'machine', installationId: installation.installationId,
        },
      } };
      let runtime: SessionAttachmentNativeRuntime | null = {
        requester, workingDirectory: directory,
        async prepareFilesystemEffect(configuration) {
          // Only the OS worker pipe is substituted; native transfer admission,
          // encrypted chunks, filesystem writes and handle issuance stay real.
          const input = new PassThrough();
          const output = new PassThrough();
          const running = runFilesystemEffectInternal(input, output);
          const channel = createFilesystemEffectChannel({ input, output, dispose: async () => { await running; } });
          await initializeFilesystemEffectChannel(channel, configuration);
          return channel;
        },
      };
      let registration: ReturnType<typeof registerSessionHandlers>;
      const authorize = createSessionRpcAuthorization({ sessionId: 's1', localMachineId: 'machine',
        serverUrl: 'https://attachment-home.test', isClosed: () => false,
        readHomeServerIdentityId: () => 'home',
        readSessionAttachmentRequester: method => registration.readSessionAttachmentRequester(method) });
      const rpc = new RpcHandlerManager({ scopePrefix: 's1', scopeKind: 'session', localMachineId: 'machine',
        encryptionMode: 'plain', authorizeRequest: authorize, logger: () => {} });
      registration = registerSessionHandlers(rpc, directory, {
        sessionId: 's1', readSessionAttachmentNativeRuntime: () => runtime,
      });
      const api = createApi({ getSocket: () => socket as never, getRpcHandlerManager: () => rpc });
      api.installSessionSocketEventHandlers(socket as never);
      const invoke = (method: string, params: unknown, admitted = true) => new Promise<unknown>(resolve => {
        const request: RpcRequest = { method: `s1:${method}`, params, callerAuthority: 'present_user',
          ...(admitted ? { machineAdmission: { actorAccountId: accountId, custodianAccountId: 'machine-owner',
            machineId: 'machine', installationId: installation.installationId, role: 'use', encryptionMode: 'plain' } } : {}) };
        socket.trigger(SOCKET_RPC_EVENTS.REQUEST, request, resolve);
      });
      try {
        const bytes = Buffer.from('member attachment');
        const request = { t: 'session_attachment_upload_v1', sessionId: 's1', messageLocalId: 'message',
          fileName: 'notes.txt', sizeBytes: bytes.length, uploadLocation: 'workspace',
          workspaceRelativeDir: '.happier/attachments', vcsIgnoreStrategy: 'none', vcsIgnoreWritesEnabled: false };
        const init = await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, request);
        expect(init).toMatchObject({ success: true });
        if (!init || typeof init !== 'object' || !('uploadId' in init) || typeof init.uploadId !== 'string'
          || !('recipientPublicKeyBase64' in init) || typeof init.recipientPublicKeyBase64 !== 'string') throw new Error('Upload unavailable');
        const chunk = createEncryptedTransferChunkEnvelope({ transferId: init.uploadId, sequence: 0,
          payload: bytes, recipientPublicKeyBase64: init.recipientPublicKeyBase64 });
        expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK, { uploadId: init.uploadId, index: 0, ...chunk }))
          .toMatchObject({ success: true });
        const finalized = await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE, { uploadId: init.uploadId });
        expect(finalized).toMatchObject({ success: true });
        const handle = SessionAttachmentHandleV1Schema.parse(finalized && typeof finalized === 'object'
          && 'attachmentHandle' in finalized ? finalized.attachmentHandle : null);
        const issued = registration.resolveSessionAttachment(handle);
        expect(issued).toBeTruthy();
        expect(await readFile(issued!.filePath)).toEqual(bytes);
        // A withdrawn member receives no new Home admission. Custody alone
        // must not grant the next upload, even while its native worker survives.
        expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, request, false))
          .toMatchObject({ errorCode: 'agent_isolation_unavailable', effectAttempted: false });
        runtime = null;
        expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, request))
          .toMatchObject({ errorCode: 'agent_isolation_unavailable', effectAttempted: false });
        expect(axiosPostMock).not.toHaveBeenCalled();
        expect(axiosGetMock).not.toHaveBeenCalled();
      } finally { await registration.dispose(); }
    });
  });

  it('projects editing-socket liveness into the Pending wake and retires it on disconnect without reads', async () => {
    const socket = createSocketStub();
    let currentSocket = socket;
    const waiters = new Set<() => void>();
    let wakeSequence = 0;
    const api = createApi({
      getSocket: () => currentSocket as never,
      getPendingWakeSeq: () => wakeSequence,
      onMetadataUpdated: handler => { waiters.add(handler); },
      offMetadataUpdated: handler => { waiters.delete(handler); },
      onPendingMessageEditHoldIdsChanged: () => {
        wakeSequence++;
        for (const handler of [...waiters]) handler();
      },
    });
    api.installSessionSocketEventHandlers(socket as never);
    expect(api.getPendingMessageEditHoldIds()).toBeNull();
    socket.trigger('connect');
    expect(socket.emit).toHaveBeenCalledWith('session-human-presence:visible-replace', {
      v: 1, sessionIds: ['s1'], pendingMessageEdits: [],
    }, expect.any(Function));
    const snapshot = (ids: string[]) => ({ v: 1, sessionId: 's1', observedAt: 1, viewers: [], pendingMessageEditHoldIds: ids });
    socket.trigger('session-human-presence:snapshot', { ...snapshot(['other-session']), sessionId: 's2' });
    socket.trigger('session-human-presence:snapshot', { ...snapshot(['malformed']), viewers: 'invalid' });
    expect(api.getPendingMessageEditHoldIds()).toBeNull();
    socket.trigger('session-human-presence:snapshot', snapshot(['editing']));
    expect(api.getPendingMessageEditHoldIds()).toEqual(['editing']);
    const live = api.getPendingMessageEditHoldIds();
    socket.trigger('session-human-presence:snapshot', snapshot(['editing']));
    expect(api.getPendingMessageEditHoldIds()).toBe(live);
    expect(wakeSequence).toBe(1);
    const waiting = api.waitForMetadataUpdate();
    socket.trigger('session-human-presence:snapshot', snapshot([]));
    await expect(waiting).resolves.toBe(true);
    expect(api.getPendingMessageEditHoldIds()).toEqual([]);
    expect(wakeSequence).toBe(2);
    socket.trigger('disconnect');
    expect(api.getPendingMessageEditHoldIds()).toBeNull();
    currentSocket = createSocketStub();
    api.installSessionSocketEventHandlers(currentSocket as never);
    socket.trigger('session-human-presence:snapshot', snapshot(['retired-device']));
    expect(api.getPendingMessageEditHoldIds()).toBeNull();
    currentSocket.trigger('session-human-presence:snapshot', snapshot([]));
    expect(api.getPendingMessageEditHoldIds()).toEqual([]);
    expect(axiosGetMock).not.toHaveBeenCalled();
    expect(axiosPostMock).not.toHaveBeenCalled();
  });

  it.each(['INVALID_REQUEST', 'UNSUPPORTED_VERSION', 'UNAVAILABLE'] as const)(
    'settles refused edit observation only when the server establishes unsupported input (%s)', (errorCode) => {
      const socket = createSocketStub();
      const api = createApi({ getSocket: () => socket as never });
      api.installSessionSocketEventHandlers(socket as never);
      socket.trigger('connect');
      const acknowledge = socket.emit.mock.calls.at(-1)?.[2];
      if (typeof acknowledge !== 'function') throw new Error('Presence declaration did not expose its acknowledgement');
      acknowledge({ v: 1, ok: false, errorCode });
      expect(api.getPendingMessageEditHoldIds()).toEqual(errorCode === 'UNAVAILABLE' ? null : []);
    },
  );

  it.each(['empty', 'transport', 'internal', 'forbidden'] as const)('preserves released Pending %s outcome at the public consumer', async (outcome) => {
    const socket = createSocketStub();
    const contract = { mode: 'released_server_v0_2_1' as const, runtimeActivity: 'legacy' as const,
      pendingInput: 'released_server_v0_2_1' as const, publisherAuthority: 'indeterminate' as const,
      sessionConnectionEpoch: 1, socket: socket as never };
    const supervisor = { getState: () => ({ phase: 'online' }), reportProbeResult: vi.fn() };
    const api = createApi({ getSocket: () => socket as never,
      getSessionSyncPendingInputServerContractResult: () => contract,
      getSessionConnectionSupervisor: () => supervisor as never,
      getPendingQueueState: () => ({ known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 }),
    });
    if (outcome === 'transport') socketAckMock.mockRejectedValueOnce(new Error('socket disconnected'));
    else socketAckMock.mockResolvedValueOnce(outcome === 'empty' ? { ok: true, didMaterialize: false }
      : { ok: false, error: outcome });
    const result = api.materializeNextPendingMessageSafely();
    if (outcome === 'forbidden') await expect(result).rejects.toMatchObject({ code: 'forbidden', response: { status: 403 } });
    else await expect(result).resolves.toEqual({ type: outcome === 'empty' ? 'no_pending' : 'retryable_transport' });
    expect(socketAckMock).toHaveBeenCalledTimes(1);
    expect(axiosGetMock).not.toHaveBeenCalled();
  });

  it('reports planned server restart events to the connection supervisor', () => {
    const socket = createSocketStub();
    const reportProbeResult = vi.fn();
    const api = createApi({
      getSocket: () => socket as never,
      getSessionConnectionSupervisor: () => ({ reportProbeResult }) as never,
    });

    api.installSessionSocketEventHandlers(socket as never);
    socket.trigger('server:restarting', { retryAfterMs: 7_000 });

    expect(reportProbeResult).toHaveBeenCalledWith({
      status: 'retry_later',
      retryAfterMs: 7_000,
      reason: 'server_restarting',
      errorMessage: 'Server restart in progress',
    });
  });

  it.each([true, false])('preserves a newer pending hint when an accepted materialization ACK omits its projection (materialized: %s)', async (didMaterialize) => {
    const runtime = createSessionClientMaterializationRuntime({
      onKeepAliveStateMayHaveChanged: () => undefined,
      initialPendingQueueState: { known: true, pendingCount: 2, pendingBlockedCount: 0, pendingVersion: 1 },
    });
    const queue = new MessageQueue2<null, UserMessage>(() => 'mode');
    const socket = createSocketStub();
    // Only the socket transport is stubbed; supervision and queue ownership stay real.
    const supervisor = createManagedConnectionSupervisor({
      ...DEFAULT_MANAGED_CONNECTION_POLICY,
      probeReadiness: async () => ({ status: 'ready' }),
      createTransport: () => ({
        connect: async () => { socket.connected = true; },
        disconnect: async () => { socket.connected = false; },
        destroy: async () => undefined,
        isConnected: () => socket.connected,
        onConnected: (listener) => {
          socket.on('connect', listener);
          return () => { socket.off('connect', listener); };
        },
        onDisconnected: (listener) => {
          socket.on('disconnect', listener);
          return () => { socket.off('disconnect', listener); };
        },
        onError: (listener) => {
          socket.on('connect_error', listener);
          return () => { socket.off('connect_error', listener); };
        },
      }),
    });
    socketAckMock.mockImplementationOnce(async () => {
      runtime.applyPendingQueueState({ known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 2 });
      return didMaterialize ? {
        ok: true, didMaterialize: true, didWrite: false, localId: 'projection-less-claim',
        message: {
          id: null, seq: null, localId: 'projection-less-claim', messageRole: 'user',
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Claimed prompt' } } },
          createdAt: 1_000, updatedAt: 1_000,
          providerAction: 'send', deliveryState: { mode: 'provider', unresolved: true },
        },
      } : { ok: true, didMaterialize: false };
    });
    if (didMaterialize) socketAckMock.mockResolvedValueOnce({ v: 1,
      result: { status: 'accepted', localId: 'projection-less-claim' } });
    const api = createApi({
      getSocket: () => socket as never,
      getSessionConnectionSupervisor: () => supervisor,
      getStoredContentCryptoContext: () => ({ mode: 'plain', ctx: null }),
      getPendingQueueState: runtime.getPendingQueueState,
      applyPendingQueueState: runtime.applyPendingQueueState,
      shouldAttemptPendingMaterialization: runtime.shouldAttemptPendingMaterialization,
      deliverMaterializedUserMessageToAgentQueue: (message) => {
        queue.push(message, null);
        return true;
      },
    });

    try {
      await supervisor.start();
      await expect(api.materializeNextPendingMessageSafely()).resolves.toMatchObject({
        type: didMaterialize ? 'materialized' : 'no_pending',
      });
      expect(queue.queue.map(({ message }) => ({ localId: message.localId, content: message.content }))).toEqual(
        didMaterialize ? [{ localId: 'projection-less-claim', content: { type: 'text', text: 'Claimed prompt' } }] : [],
      );
      expect(runtime.getPendingQueueState()).toEqual({ known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 2 });
      expect(runtime.shouldAttemptPendingMaterialization()).toBe(true);
    } finally {
      await supervisor.stop();
      queue.close();
    }
  });

  it('retains Pending custody before claim until the authenticated Home is available, then derives portable requester attribution', async () => {
    let serverIdentityId: string | null | undefined;
    const deliver = vi.fn<(message: UserMessage) => boolean>(() => true);
    const markCustody = vi.fn();
    socketAckMock.mockResolvedValue({ ok: true, didMaterialize: true, didWrite: true, localId: 'home-original',
      pendingCount: 0, pendingVersion: 2, message: {
        id: 'home-message', seq: 7, localId: 'home-original', messageRole: 'user',
        inputAdmissionReceipt: { v: 1, issuer: 'authenticatedAccount', actorAccountId: 'person', sessionRelationship: 'owner' },
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Preserve this original' } } },
        createdAt: 1_000, updatedAt: 1_000, providerAction: 'send', deliveryState: { mode: 'provider', unresolved: true },
      } });
    const api = createApi({ serverId: 'local-routing-profile', getServerIdentityId: () => serverIdentityId,
      getSessionConnectionSupervisor: () => ({ getState: () => ({ phase: 'online' }) }) as never,
      getPendingQueueState: () => ({ known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 }),
      getStoredContentCryptoContext: () => ({ mode: 'plain', ctx: null }),
      deliverMaterializedUserMessageToAgentQueue: deliver, markPendingQueueMaterializedLocalId: markCustody,
    });
    await expect(api.materializeNextPendingMessageSafely()).resolves.toEqual({ type: 'retryable_transport' });
    expect(socketAckMock).not.toHaveBeenCalled();
    expect(markCustody).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    serverIdentityId = 'authenticated-home';
    await expect(api.materializeNextPendingMessageSafely()).resolves.toMatchObject({ type: 'materialized', localId: 'home-original' });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]?.[0]).toMatchObject({ actionRequestAttributionV1: {
      requestRef: 'home-original', requester: { serverId: serverIdentityId, accountId: 'person' },
      persona: { serverId: serverIdentityId, sessionId: 's1' },
      origin: { kind: 'session', session: { serverId: serverIdentityId, sessionId: 's1' }, messageId: 'home-message' },
    } });
    expect(markCustody).toHaveBeenCalledWith('home-original');
    // The recognized older Home contract is different from a missing probe:
    // valid input still delivers, but no local profile becomes portable identity.
    const legacyDelivery = vi.fn<(message: UserMessage) => boolean>(() => true);
    const legacy = createApi({ serverId: 'older-local-profile', getServerIdentityId: () => null,
      getSessionConnectionSupervisor: () => ({ getState: () => ({ phase: 'online' }) }) as never,
      getPendingQueueState: () => ({ known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 }),
      getStoredContentCryptoContext: () => ({ mode: 'plain', ctx: null }),
      deliverMaterializedUserMessageToAgentQueue: legacyDelivery,
    });
    await expect(legacy.materializeNextPendingMessageSafely()).resolves.toMatchObject({ type: 'materialized', localId: 'home-original' });
    expect(legacyDelivery.mock.calls[0]?.[0]).toMatchObject({ content: { type: 'text', text: 'Preserve this original' } });
    expect(legacyDelivery.mock.calls[0]?.[0]?.actionRequestAttributionV1).toBeUndefined();
  });

  it.each(['indeterminate', 'auth_failed'] as const)('delivers zero provider input for %s compatibility', async (mode) => {
    const socket = createSocketStub();
    const contractResult = {
      mode,
      runtimeActivity: 'indeterminate' as const,
      pendingInput: 'indeterminate' as const,
      publisherAuthority: 'indeterminate' as const,
      sessionConnectionEpoch: 1,
      socket,
    };
    const deliver = vi.fn(() => true);
    const api = createApi({
      getSocket: () => socket as never,
      getSessionConnectionEpoch: () => 1,
      getSessionSyncPendingInputServerContractResult: () => contractResult,
      getSessionConnectionSupervisor: () => ({ getState: () => ({ phase: 'online' }) }) as never,
      getPendingQueueState: () => ({ known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 }),
      deliverMaterializedUserMessageToAgentQueue: deliver,
    });

    await expect(api.materializeNextPendingMessageSafely()).resolves.toEqual(
      mode === 'auth_failed' ? { type: 'auth_failure' } : { type: 'retryable_transport' },
    );
    expect(socketAckMock).not.toHaveBeenCalled();
    expect(axiosGetMock).not.toHaveBeenCalled();
    expect(axiosPostMock).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('holds retained-context materialization on a pre-V5 Home without disabling ordinary input', async () => {
    // Moving 0.2 at 077db90d advertises Pending revision 2 and ignores new request fields.
    const socket = createSocketStub();
    const contractResult = { mode: 'session_sync_v2_pending_input_v1' as const,
      runtimeActivity: 'v2' as const, pendingInput: 'v1' as const, pendingInputProtocolVersion: 2,
      publisherAuthority: 'indeterminate' as const, sessionConnectionEpoch: 1, socket };
    let retained: string[] = ['quiet-original'];
    const api = createApi({ getSocket: () => socket as never,
      getSessionSyncPendingInputServerContractResult: () => contractResult,
      getSessionConnectionSupervisor: () => ({ getState: () => ({ phase: 'online' }) }) as never,
      readRetainedContextLocalIds: () => retained,
    });
    await expect(api.materializeNextPendingMessageSafely()).resolves.toEqual({
      type: 'unsupported', code: 'session_input_target_update_required',
    });
    expect(socketAckMock).not.toHaveBeenCalled();
    retained = [];
    socketAckMock.mockResolvedValueOnce({ ok: true, didMaterialize: false,
      pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1 });
    await expect(api.materializeNextPendingMessageSafely()).resolves.toEqual({ type: 'no_pending' });
    expect(socketAckMock.mock.calls[0]?.[1]).not.toHaveProperty('retainedContext');
  });

  it('returns the operation-scoped update result for a Run target on a pre-V3 Pending server while main Pending remains usable', async () => {
    const socket = createSocketStub();
    const contractResult = {
      mode: 'session_sync_v2_pending_input_v1' as const,
      runtimeActivity: 'v2' as const,
      pendingInput: 'v1' as const,
      pendingInputProtocolVersion: 2,
      publisherAuthority: 'indeterminate' as const,
      sessionConnectionEpoch: 1,
      socket,
    };
    const api = createApi({
      getSocket: () => socket as never,
      getSessionConnectionEpoch: () => 1,
      getSessionSyncPendingInputServerContractResult: () => contractResult,
      getSessionConnectionSupervisor: () => ({ getState: () => ({ phase: 'online' }) }) as never,
    });

    await expect(api.materializeNextExecutionRunPendingMessageSafely({
      recipient: { kind: 'execution_run', runId: 'run-1' },
      sidechainId: 'sidechain-1',
      isCurrent: () => true,
      foregroundState: () => 'ready',
      getMetadataSnapshot: () => null,
      consume: () => false,
      hasCustody: () => false,
      markCustody: () => undefined,
    })).resolves.toEqual({ type: 'unsupported', code: 'session_input_target_update_required' });
    expect(socketAckMock).not.toHaveBeenCalled();

    socketAckMock.mockResolvedValueOnce({
      ok: true,
      didMaterialize: false,
      pendingCount: 0,
      pendingBlockedCount: 0,
      pendingVersion: 2,
    });
    await expect(api.materializeNextPendingMessageSafely()).resolves.toEqual({ type: 'no_pending' });
    expect(socketAckMock).toHaveBeenCalledTimes(1);
  });

  it('does not let an old auth result poison a replacement connection epoch', async () => {
    const oldSocket = createSocketStub();
    const newSocket = createSocketStub();
    const staleAuthResult = {
      mode: 'auth_failed' as const,
      runtimeActivity: 'indeterminate' as const,
      pendingInput: 'indeterminate' as const,
      publisherAuthority: 'indeterminate' as const,
      sessionConnectionEpoch: 1,
      socket: oldSocket,
    };
    const api = createApi({
      getSocket: () => newSocket as never,
      getSessionConnectionEpoch: () => 2,
      getSessionSyncPendingInputServerContractResult: () => staleAuthResult,
      getSessionConnectionSupervisor: () => ({ getState: () => ({ phase: 'online' }) }) as never,
      getPendingQueueState: () => ({ known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 }),
    });

    await expect(api.materializeNextPendingMessageSafely()).resolves.toEqual({ type: 'retryable_transport' });
    expect(socketAckMock).not.toHaveBeenCalled();
    expect(axiosGetMock).not.toHaveBeenCalled();
    expect(axiosPostMock).not.toHaveBeenCalled();
  });

  it('rejoins an ambiguous frozen claim at the canonical connection retry delay', async () => {
    const socket = createSocketStub();
    const contractResult = {
      mode: 'session_sync_v2_pending_input_v1' as const,
      runtimeActivity: 'v2' as const,
      pendingInput: 'v1' as const,
      publisherAuthority: 'indeterminate' as const,
      sessionConnectionEpoch: 1,
      socket,
    };
    const transportError = Object.assign(new Error('materialize acknowledgement timed out'), {
      diagnosticCode: 'pending_queue_materialization_ack_timeout',
      classification: 'ack_timeout',
    });
    socketAckMock.mockRejectedValueOnce(transportError);
    const infoFileSpy = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const api = createApi({
      getSocket: () => socket as never,
      getSessionSyncPendingInputServerContractResult: () => contractResult,
      getSessionConnectionSupervisor: () => ({ getState: () => ({ phase: 'online' }) }) as never,
      getPendingQueueState: () => ({ known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 }),
    });

    await expect(api.materializeNextPendingMessageSafely()).resolves.toEqual({
      type: 'retryable_transport',
      retryAfterMs: DEFAULT_MANAGED_CONNECTION_POLICY.backoffMinMs,
    });
    expect(infoFileSpy).toHaveBeenCalledWith(
      '[pendingQueue] materialize request failed',
      expect.objectContaining({
        sessionId: 's1',
        error: expect.objectContaining({
          diagnosticCode: 'pending_queue_materialization_ack_timeout',
          classification: 'ack_timeout',
          message: 'materialize acknowledgement timed out',
        }),
      }),
    );
    expect(infoFileSpy).toHaveBeenCalledTimes(1);
    expect(axiosPostMock).not.toHaveBeenCalled();
  });

  it('classifies a pending row it cannot open as undecryptable once, warns, and stops retrying until the key changes', async () => {
    const socket = createSocketStub();
    const contractResult = {
      mode: 'session_sync_v2_pending_input_v1' as const,
      runtimeActivity: 'v2' as const,
      pendingInput: 'v1' as const,
      publisherAuthority: 'v1' as const,
      sessionConnectionEpoch: 1,
      socket,
    };
    const claim = {
      ok: true, didMaterialize: true, localId: 'sealed-local', didWrite: false, pendingCount: 1, pendingVersion: 2,
      message: {
        id: null, seq: null, localId: 'sealed-local', messageRole: 'user',
        // Sealed with another key: deterministic failure under this Session's key.
        content: { t: 'encrypted', c: encodeBase64(encrypt(new Uint8Array(32).fill(7), 'legacy', { role: 'user' })) },
        inputAdmissionReceipt: null, createdAt: 1_000, updatedAt: 1_000, providerAction: 'send',
        deliveryState: { mode: 'provider', unresolved: true },
      },
    };
    socketAckMock.mockResolvedValue(claim);
    axiosPostMock.mockResolvedValue({ data: { ok: true, pendingCount: 1, pendingBlockedCount: 1, pendingVersion: 3 } });
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    let crypto = { mode: 'e2ee' as const, ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' as const } };
    const deliver = vi.fn(() => true);
    const api = createApi({
      getSocket: () => socket as never,
      getSessionSyncPendingInputServerContractResult: () => contractResult,
      getSessionConnectionSupervisor: () => ({ getState: () => ({ phase: 'online' }) }) as never,
      getStoredContentCryptoContext: () => crypto,
      getPendingQueueState: () => ({ known: true as const, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 }),
      deliverMaterializedUserMessageToAgentQueue: deliver,
    } as any);

    const results = [];
    for (let attempt = 0; attempt < 3; attempt += 1) results.push(await api.materializeNextPendingMessageSafely());
    expect(results.filter(result => result.type === 'retryable_transport')).toHaveLength(0);
    const undecryptableWarnings = () => warnSpy.mock.calls.filter(([message]) => message === '[pendingQueue] pending input is undecryptable with the Session key');
    expect(undecryptableWarnings()).toHaveLength(1);
    expect(undecryptableWarnings()[0]?.[1]).toEqual({ sessionId: 's1', localId: 'sealed-local', mode: 'e2ee' });
    expect(deliver).not.toHaveBeenCalled();
    // Surfaced through the existing blocked-delivery presentation, once: the queue moves past it.
    expect(axiosPostMock.mock.calls.map(([url, body]) => [String(url).replace(/^.*\/v2\//, '/v2/'), body]))
      .toEqual([['/v2/sessions/s1/pending/sealed-local/delivery/block', { reason: 'invalid_prompt_text' }]]);

    // A different Session key is the only fact that can open the same row.
    crypto = { mode: 'e2ee' as const, ctx: { encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'legacy' as const } };
    await api.materializeNextPendingMessageSafely();
    expect(undecryptableWarnings()).toHaveLength(2);
  });

  it('identifies the server-claim subphase before awaiting an unsettled materialization transport', async () => {
    const socket = createSocketStub();
    const transport = createDeferred<{
      ok: true;
      didMaterialize: false;
      pendingCount: 0;
      pendingBlockedCount: 0;
      pendingVersion: 2;
    }>();
    socketAckMock.mockImplementationOnce(async () => await transport.promise);
    const observedPhases: string[] = [];
    const api = createApi({
      getSocket: () => socket as never,
      getSessionConnectionSupervisor: () => ({ getState: () => ({ phase: 'online' }) }) as never,
      getPendingQueueState: () => ({
        known: true,
        pendingCount: 1,
        pendingBlockedCount: 0,
        pendingVersion: 1,
      }),
    });
    const pending = api.materializeNextPendingMessageSafely({
      reconcileWhenEmpty: 'force',
      onDiagnosticPhase: (phase) => observedPhases.push(phase),
    });

    try {
      await vi.waitFor(() => expect(socketAckMock).toHaveBeenCalledTimes(1));
      expect(observedPhases.at(-1)).toBe('materialize.server_claim');
    } finally {
      transport.resolve({
        ok: true,
        didMaterialize: false,
        pendingCount: 0,
        pendingBlockedCount: 0,
        pendingVersion: 2,
      });
      await pending;
    }
  });

  it('keeps diagnostic callback failures outside pending materialization behavior', async () => {
    socketAckMock.mockResolvedValueOnce({
      ok: true,
      didMaterialize: false,
      pendingCount: 0,
      pendingBlockedCount: 0,
      pendingVersion: 2,
    });
    const api = createApi({
      getSessionConnectionSupervisor: () => ({ getState: () => ({ phase: 'online' }) }) as never,
      getPendingQueueState: () => ({
        known: true,
        pendingCount: 1,
        pendingBlockedCount: 0,
        pendingVersion: 1,
      }),
    });

    await expect(api.materializeNextPendingMessageSafely({
      reconcileWhenEmpty: 'force',
      onDiagnosticPhase: () => {
        throw new Error('diagnostic callback failed');
      },
    })).resolves.toEqual({ type: 'no_pending' });
    expect(socketAckMock).toHaveBeenCalledTimes(1);
  });

  it.each(['plain', 'e2ee'] as const)('uses only the strict released-server adapter in old mode for %s content', async (mode) => {
    const socket = createSocketStub();
    const contractResult = {
      mode: 'released_server_v0_2_1' as const,
      runtimeActivity: 'legacy' as const,
      pendingInput: 'released_server_v0_2_1' as const,
      publisherAuthority: 'indeterminate' as const,
      sessionConnectionEpoch: 3,
      socket,
    };
    socketAckMock.mockResolvedValueOnce({
      ok: true,
      didMaterialize: true,
      didWrite: true,
      message: { id: 'old-message', seq: 8, localId: 'old-local' },
    });
    axiosGetMock.mockResolvedValueOnce({
      status: 200,
      data: {
        message: {
          id: 'old-message', seq: 8, localId: 'old-local', sidechainId: null,
          createdAt: 100, updatedAt: 101,
          content: mode === 'plain'
            ? { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'old prompt' } } }
            : { t: 'encrypted', c: encodeBase64(encrypt(new Uint8Array(32), 'legacy', { role: 'user', content: { type: 'text', text: 'old prompt' } })) },
        },
      },
    });
    const deliver = vi.fn(() => true);
    const observedPhases: string[] = [];
    const supervisor = { getState: () => ({ phase: 'online' }) };
    const api = createApi({
      getSocket: () => socket as never,
      getSessionConnectionEpoch: () => 3,
      ...(mode === 'plain' ? { getStoredContentCryptoContext: () => ({ mode: 'plain' as const, ctx: null }) } : {}),
      getSessionSyncPendingInputServerContractResult: () => contractResult,
      getSessionConnectionSupervisor: () => supervisor as never,
      getPendingQueueState: () => ({ known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 }),
      deliverMaterializedUserMessageToAgentQueue: deliver,
    });

    await expect(api.materializeNextPendingMessageSafely({
      onDiagnosticPhase: (phase) => observedPhases.push(phase),
    })).resolves.toMatchObject({
      type: 'materialized', localId: 'old-local', seq: 8,
    });
    expect(observedPhases).toContain('materialize.server_claim');
    expect(observedPhases).toContain('materialize.compatibility_transcript_lookup');
    expect(socketAckMock).toHaveBeenCalledWith('pending-materialize-next', { sid: 's1' });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(axiosPostMock).not.toHaveBeenCalled();
  });

  it('does not fall back to HTTP when current materialization has no bound socket', async () => {
    const disconnectedSocket = { connected: false };
    const contractResult = {
      mode: 'session_sync_v2_pending_input_v1' as const,
      runtimeActivity: 'v2' as const,
      pendingInput: 'v1' as const,
      publisherAuthority: 'indeterminate' as const,
      sessionConnectionEpoch: 1,
      socket: disconnectedSocket,
    };
    const api = createApi({
      getSocket: () => disconnectedSocket as never,
      getSessionSyncPendingInputServerContractResult: () => contractResult,
      getSessionConnectionSupervisor: () => ({
        getState: () => ({ phase: 'online' }),
      } as never),
      getPendingQueueState: () => ({ known: true as const, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 }),
    });

    await expect(api.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toEqual({
      type: 'retryable_transport',
    });

    expect(axiosPostMock).not.toHaveBeenCalled();
    expect(socketAckMock).not.toHaveBeenCalled();
  });

  it('propagates non-auth pending-queue list failures', async () => {
    axiosGetMock.mockRejectedValueOnce(new Error('pending list failed'));
    const api = createApi();

    await expect(api.listPendingMessageQueueV2LocalIds()).rejects.toThrow('pending list failed');
  });

  it('propagates non-auth pending-queue discard failures', async () => {
    axiosGetMock.mockResolvedValueOnce({
      data: { pending: [{ localId: 'pending-1' }] },
    });
    axiosPostMock.mockRejectedValueOnce(new Error('pending discard failed'));
    const api = createApi({
      getPendingQueueState: () => ({ known: true as const, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 3 }),
    });

    await expect(api.discardPendingMessageQueueV2All({ reason: 'manual' })).rejects.toThrow('pending discard failed');
  });

  it('does not force a session-detail reconciliation for passive known-empty pending peeks', async () => {
    const syncSessionSnapshotFromServer = vi.fn();
    const api = createApi({
      shouldAttemptPendingMaterialization: () => false,
      getPendingQueueState: () => ({ known: true as const, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 4 }),
      syncSessionSnapshotFromServer,
    });

    await expect(api.peekPendingMessageQueueV2Count()).resolves.toBe(0);

    expect(syncSessionSnapshotFromServer).not.toHaveBeenCalled();
  });

  it('reports pending queue reconciliation changes when only the blocked count changes', async () => {
    let pendingQueueState = { known: true as const, pendingCount: 2, pendingBlockedCount: 0, pendingVersion: 4 };
    const api = createApi({
      shouldAttemptPendingMaterialization: () => false,
      getPendingQueueState: () => pendingQueueState,
      syncSessionSnapshotFromServer: vi.fn(async () => {
        pendingQueueState = { known: true as const, pendingCount: 2, pendingBlockedCount: 1, pendingVersion: 4 };
        return true;
      }),
    });

    await expect(api.reconcilePendingQueueState({ force: true })).resolves.toBe(true);
  });

  it.each([
    { deferredReason: 'waiting_for_runtime_activity', reason: 'runtime_activity_active' },
    { deferredReason: 'waiting_for_quota_reset', reason: 'waiting_for_quota_reset' },
  ])('keeps server-owned $deferredReason deferral queued without claiming input', async ({ deferredReason, reason }) => {
    const socket = createSocketStub();
    socketAckMock.mockResolvedValueOnce({
        ok: true,
        didMaterialize: false,
        pendingCount: 1,
        pendingBlockedCount: 0,
        pendingVersion: 7,
        deferredReason,
        localId: 'runtime-idle-head',
    });
    const handleSessionScopedUpdate = vi.fn();
    const api = createApi({
      getSocket: () => socket as never,
      getSessionConnectionSupervisor: () => ({
        getState: () => ({ phase: 'online' }),
      } as never),
      getPendingQueueState: () => ({ known: true as const, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 6 }),
      applyPendingQueueState: vi.fn(() => true),
      onPendingQueueStateChanged: vi.fn(),
      handleSessionScopedUpdate,
    } as any);

    await expect(api.materializeNextPendingMessageSafely({
      reconcileWhenEmpty: 'force',
      deliveryTiming: 'after_runtime_idle',
    } as Parameters<typeof api.materializeNextPendingMessageSafely>[0] & { deliveryTiming: 'after_runtime_idle' })).resolves.toEqual({
      type: 'deferred',
      reason,
    });

    expect(socketAckMock).toHaveBeenCalledWith('pending-materialize-next', expect.objectContaining({
      sid: 's1', pendingVersion: 6, deliveryTiming: 'after_runtime_idle', foregroundState: 'ready',
    }));
    expect(axiosPostMock).not.toHaveBeenCalled();
    expect(handleSessionScopedUpdate).not.toHaveBeenCalled();
  });

  it('carries held custody localIds on the claim and hands their delivery statuses from the claim reply to the custody owner', async () => {
    const socket = createSocketStub();
    socketAckMock.mockResolvedValueOnce({
      ok: true, didMaterialize: false, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 7,
      custodyDeliveryStatuses: [
        { localId: 'held-blocked', deliveryStatus: { status: 'blocked', reason: 'team_access_removed' } },
        { localId: 'held-archived', deliveryStatus: { status: 'discarded', reason: 'dismissed_uncertain' } },
      ],
    });
    const applyPendingCustodyDeliveryStatuses = vi.fn(async () => {});
    const api = createApi({
      getSocket: () => socket as never,
      getSessionConnectionSupervisor: () => ({ getState: () => ({ phase: 'online' }) } as never),
      getPendingQueueState: () => ({ known: true as const, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 6 }),
      readPendingCustodyLocalIdsForClaim: () => ['held-blocked', 'held-archived', 'held-absent'],
      applyPendingCustodyDeliveryStatuses,
    });

    await api.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });

    expect(socketAckMock).toHaveBeenCalledWith('pending-materialize-next', expect.objectContaining({
      sid: 's1', custodyLocalIds: ['held-blocked', 'held-archived', 'held-absent'],
    }));
    expect(axiosGetMock).not.toHaveBeenCalled();
    expect(applyPendingCustodyDeliveryStatuses).toHaveBeenCalledWith(['held-blocked', 'held-archived', 'held-absent'], [
      { localId: 'held-blocked', deliveryStatus: { status: 'blocked', reason: 'team_access_removed' } },
      { localId: 'held-archived', deliveryStatus: { status: 'discarded', reason: 'dismissed_uncertain' } },
    ]);
  });

  it('ignores the retired local Activity veto and asks the server Pending owner', async () => {
    const socket = createSocketStub();
    socketAckMock.mockResolvedValueOnce({
        ok: true,
        didMaterialize: false,
        pendingCount: 1,
        pendingBlockedCount: 0,
        pendingVersion: 7,
        deferredReason: 'waiting_for_runtime_activity',
        localId: 'runtime-idle-head',
    });
    const api = createApi({
      getSocket: () => socket as never,
      getSessionConnectionSupervisor: () => ({ getState: () => ({ phase: 'online' }) } as never),
      getPendingQueueState: () => ({ known: true as const, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 6 }),
      shouldDeferPendingQueueDrainForRuntimeActivity: ({ deliveryTiming }) => deliveryTiming === 'after_runtime_idle',
    });

    await expect(api.materializeNextPendingMessageSafely({
      reconcileWhenEmpty: 'force',
      deliveryTiming: 'after_runtime_idle',
    } as Parameters<typeof api.materializeNextPendingMessageSafely>[0] & { deliveryTiming: 'after_runtime_idle' })).resolves.toEqual({
      type: 'deferred',
      reason: 'runtime_activity_active',
    });

    expect(socketAckMock).toHaveBeenCalledWith('pending-materialize-next', expect.objectContaining({
      sid: 's1', pendingVersion: 6, deliveryTiming: 'after_runtime_idle', foregroundState: 'ready',
    }));
    expect(axiosPostMock).not.toHaveBeenCalled();
  });

  it('materializes queued rows when Pending Input is supported independently of other session capabilities', async () => {
    const socket = createSocketStub();
    const contractResult = {
      mode: 'indeterminate' as const,
      runtimeActivity: 'indeterminate' as const,
      pendingInput: 'v1' as const,
      publisherAuthority: 'indeterminate' as const,
      sessionConnectionEpoch: 1,
      socket,
    };
    socketAckMock.mockResolvedValueOnce({
        ok: true,
        didMaterialize: true,
        localId: 'legacy-local',
        didWrite: true,
        pendingCount: 0,
        pendingVersion: 3,
        message: {
          id: 'm-legacy',
          seq: 1810,
          localId: 'legacy-local',
          messageRole: 'user',
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'next prompt after stale row' },
              localId: 'legacy-local',
            },
          },
          createdAt: 1_000,
          updatedAt: 1_000,
          providerAction: 'send',
          deliveryState: { mode: 'provider', unresolved: true },
        },
    });
    const api = createApi({
      getSocket: () => socket as never,
      getStoredContentCryptoContext: () => ({ mode: 'plain' as const, ctx: null }),
      getSessionSyncPendingInputServerContractResult: () => contractResult,
      getSessionConnectionSupervisor: () => ({
        getState: () => ({ phase: 'online' }),
      } as never),
      getPendingQueueState: () => ({ known: true as const, pendingCount: 2, pendingVersion: 1 }),
      applyPendingQueueState: vi.fn(() => true),
      onPendingQueueStateChanged: vi.fn(),
    } as any);

    await expect(api.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'legacy-local',
      seq: 1810,
    });

    expect(socketAckMock).toHaveBeenCalledWith('pending-materialize-next', expect.objectContaining({
      sid: 's1',
      pendingVersion: 1,
      deliveryState: 'provider',
      deliveryTiming: 'after_foreground_ready',
      foregroundState: 'ready',
    }));
    expect(axiosPostMock).not.toHaveBeenCalled();
  });

  it.each([
    ['e2ee', 'plain', false],
    ['plain', 'encrypted', false],
    ['e2ee', 'corrupt', false],
    ['plain', 'plain', true],
    ['e2ee', 'encrypted', true],
  ] as const)('opens a %s Session claim with %s content before provider delivery (accepted: %s)', async (mode, envelope, accepted) => {
    const payload = { role: 'user', content: { type: 'text', text: 'pending prompt' } };
    const content = envelope === 'plain'
      ? { t: 'plain', v: payload }
      : { t: 'encrypted', c: envelope === 'corrupt' ? 'invalid' : encodeBase64(encrypt(new Uint8Array(32), 'legacy', payload)) };
    socketAckMock.mockImplementation(async (event: string) => event === 'session-pending-admission-settlement-v1'
      ? { v: 1, result: { status: 'accepted', localId: 'pending-local' } }
      : {
      ok: true, didMaterialize: true, didWrite: false, localId: 'pending-local',
      pendingCount: 1, pendingVersion: 2,
      message: {
        id: null, seq: null, localId: 'pending-local', messageRole: 'user', content,
        createdAt: 1_000, updatedAt: 1_000, providerAction: 'send',
        deliveryState: { mode: 'provider', unresolved: true },
      },
    });
    const delivered: unknown[] = [];
    const projected: unknown[] = [];
    const custody = new Set<string>();
    const api = createApi({
      getSessionConnectionSupervisor: () => ({ getState: () => ({ phase: 'online' }) }) as never,
      getPendingQueueState: () => ({ known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 }),
      ...(mode === 'plain' ? { getStoredContentCryptoContext: () => ({ mode: 'plain' as const, ctx: null }) } : {}),
      deliverMaterializedUserMessageToAgentQueue: (message) => { delivered.push(message); return true; },
      handleSessionScopedUpdate: (update) => { projected.push(update); },
      markPendingQueueMaterializedLocalId: (localId) => { custody.add(localId); },
    });

    axiosPostMock.mockResolvedValue({ data: { ok: true } });
    const result = await api.materializeNextPendingMessageSafely();
    if (accepted) {
      expect(result).toMatchObject({ type: 'materialized', localId: 'pending-local' });
      expect(delivered).toEqual([{ ...payload, localId: 'pending-local', createdAt: 1_000 }]);
      expect(custody.has('pending-local')).toBe(true);
    } else {
      // Opening is deterministic under one key: no timed retry; the row is surfaced as blocked.
      expect(result).toEqual({ type: 'no_pending' });
      expect(axiosPostMock).toHaveBeenCalledTimes(1);
      expect(delivered).toEqual([]);
      expect(projected).toEqual([]);
      expect(custody.size).toBe(0);
      expect(socketAckMock).toHaveBeenCalledTimes(1);
      // Rejoining the same claim remains possible; failed opening takes no custody.
      await expect(api.materializeNextPendingMessageSafely()).resolves.toEqual(result);
      expect(delivered).toEqual([]);
      socketAckMock.mockResolvedValueOnce({
        ok: true, didMaterialize: true, didWrite: false, localId: 'pending-local',
        pendingCount: 1, pendingVersion: 2,
        message: {
          id: null, seq: null, localId: 'pending-local', messageRole: 'user',
          content: mode === 'plain'
            ? { t: 'plain', v: payload }
            : { t: 'encrypted', c: encodeBase64(encrypt(new Uint8Array(32), 'legacy', payload)) },
          createdAt: 1_000, updatedAt: 1_000, providerAction: 'send',
          deliveryState: { mode: 'provider', unresolved: true },
        },
      });
      await expect(api.materializeNextPendingMessageSafely()).resolves.toMatchObject({ type: 'materialized', localId: 'pending-local' });
      expect(delivered).toEqual([{ ...payload, localId: 'pending-local', createdAt: 1_000 }]);
      expect(custody.has('pending-local')).toBe(true);
    }
    expect(axiosPostMock).toHaveBeenCalledTimes(accepted ? 0 : 1);
  });

  it.each(['wait', 'human-origin', 'legacy-prompt'] as const)('settles collaborator provenance and protected authority before projection or provider delivery (%s)', async kind => {
    const callerInputConstraints = { models: [{ agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'A' }], permissionModes: null };
    const socket = createSocketStub();
    const contractResult = {
      mode: 'session_sync_v2_pending_input_v1' as const,
      runtimeActivity: 'v2' as const,
      pendingInput: 'v1' as const,
      publisherAuthority: 'v1' as const,
      sessionConnectionEpoch: 1,
      socket,
    };
    const replyIntent = kind === 'human-origin'
      ? { mode: 'return' as const, humanOrigin: { sessionId: 'composer-session' } }
      : { mode: 'wait' as const };
    const request = {
      v: 1 as const,
      producer: 'happierApp' as const,
      caller: { kind: 'host' as const },
      replyIntent,
      permission: { requestedPermissionCeiling: 'read-only' as const },
    };
    const requestContent = {
      t: 'plain' as const,
      v: {
        role: 'user',
        callerInputConstraints: { models: null, permissionModes: null },
        content: kind === 'legacy-prompt' ? 'protected prompt' : { type: 'text', text: 'protected prompt' },
        localId: 'protected-local',
        meta: {
          happierProvenanceV1: { v: 1, kind: 'host', producer: 'happierApp' },
          happierInputRequestV1: request,
        },
      },
    };
    socketAckMock
      .mockResolvedValueOnce({
        ok: true,
        didMaterialize: true,
        localId: 'protected-local',
        didWrite: false,
        pendingCount: 1,
        pendingVersion: 2,
        message: {
          id: null,
          seq: null,
          localId: 'protected-local',
          messageRole: 'user',
          content: requestContent,
          inputAdmissionReceipt: {
            v: 1,
            issuer: 'authenticatedAccount',
            callerInputConstraints,
            actorAccountId: 'collaborator-account',
            sessionRelationship: 'sharedEditor',
          },
          createdAt: 1_000,
          updatedAt: 1_000,
          providerAction: 'send',
          deliveryState: { mode: 'provider', unresolved: true },
        },
      })
      .mockResolvedValueOnce({
        v: 1,
        result: { status: 'accepted', localId: 'protected-local' },
      });
    const deliver = vi.fn(() => true);
    const handleSessionScopedUpdate = vi.fn();
    const markPendingQueueMaterializedLocalId = vi.fn();
    const api = createApi({
      getSocket: () => socket as never,
      readCurrentAutonomousCheckIn: async () => null,
      getSessionSyncPendingInputServerContractResult: () => contractResult,
      getSessionConnectionSupervisor: () => ({ getState: () => ({ phase: 'online' }) }) as never,
      getMetadata: () => createTestMetadata({ permissionMode: 'safe-yolo' }),
      getStoredContentCryptoContext: () => ({ mode: 'plain' as const, ctx: null }),
      getPendingQueueState: () => ({ known: true as const, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 }),
      applyPendingQueueState: vi.fn(() => true),
      deliverMaterializedUserMessageToAgentQueue: deliver,
      handleSessionScopedUpdate,
      markPendingQueueMaterializedLocalId,
    } as any);

    const outcome = await api.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });

    expect(socketAckMock).toHaveBeenNthCalledWith(2, 'session-pending-admission-settlement-v1', expect.objectContaining({
      decision: expect.objectContaining({ kind: 'admit', validation: { reply: replyIntent } }),
    }));
    expect(outcome).toMatchObject({
      type: 'materialized',
      localId: 'protected-local',
      seq: null,
    });

    expect(socketAckMock).toHaveBeenNthCalledWith(2, 'session-pending-admission-settlement-v1', expect.objectContaining({
      v: 1,
      sessionId: 's1',
      localId: 'protected-local',
      decision: expect.objectContaining({
        kind: 'admit',
        finalContent: expect.objectContaining({
          t: 'plain',
          v: expect.objectContaining({
            meta: expect.objectContaining({
              happierInputAuthorityV1: expect.objectContaining({
                permission: {
                  requestedPermissionCeiling: 'read-only',
                  admittedPermissionCeiling: 'read-only',
                },
              }),
              happierProvenanceV1: {
                v: 1,
                kind: 'happierApp',
                actor: { kind: 'sharedCollaborator' },
              },
            }),
          }),
        }),
      }),
    }));
    expect(handleSessionScopedUpdate).toHaveBeenCalledTimes(1);
    expect(handleSessionScopedUpdate).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        message: expect.objectContaining({
          content: expect.objectContaining({
            v: expect.objectContaining({
              meta: expect.not.objectContaining({ happierInputRequestV1: expect.anything() }),
            }),
          }),
        }),
      }),
    }));
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({
      inputAdmissionReceipt: {
        v: 1,
        issuer: 'authenticatedAccount',
        callerInputConstraints,
        actorAccountId: 'collaborator-account',
        sessionRelationship: 'sharedEditor',
      },
      callerInputConstraints,
      actionRequestAttributionV1: {
        requestRef: 'protected-local',
        requester: { serverId: expect.any(String), accountId: 'collaborator-account' },
        persona: { serverId: expect.any(String), sessionId: 's1' },
        // A pre-provider Pending claim has no committed message yet.
        origin: null,
      },
      meta: expect.objectContaining({
        happierProvenanceV1: {
          v: 1,
          kind: 'happierApp',
          actor: { kind: 'sharedCollaborator' },
        },
        happierInputAuthorityV1: expect.objectContaining({
          permission: expect.objectContaining({ admittedPermissionCeiling: 'read-only' }),
        }),
      }),
    }), 'send', { v: 1, kind: 'enqueue' });
    expect(markPendingQueueMaterializedLocalId).toHaveBeenCalledWith('protected-local');
  });

  it.each(['plain', 'e2ee'] as const)('rejects malformed protected authority in a %s Pending original instead of treating it as legacy', async mode => {
    const socket = createSocketStub();
    const payload = { role: 'user', content: { type: 'text', text: 'Retained protected original' }, meta: { happierInputAuthorityV1: null } };
    const content = mode === 'plain' ? { t: 'plain', v: payload } as const
      : { t: 'encrypted', c: encodeBase64(encrypt(new Uint8Array(32), 'legacy', payload)) } as const;
    socketAckMock.mockResolvedValueOnce({ ok: true, didMaterialize: true, localId: 'invalid-authority', didWrite: false,
      pendingCount: 1, pendingVersion: 2, message: { id: null, seq: null, localId: 'invalid-authority', messageRole: 'user',
        content, inputAdmissionReceipt: { v: 1, issuer: 'authenticatedAccount', actorAccountId: 'owner', sessionRelationship: 'owner' },
        createdAt: 1_000, updatedAt: 1_000, providerAction: 'send', deliveryState: { mode: 'provider', unresolved: true } },
    }).mockResolvedValueOnce({ v: 1, result: { status: 'rejected', code: 'session_input_invalid' } });
    const deliver = vi.fn(() => true);
    const api = createApi({ getSocket: () => socket as never,
      getSessionConnectionSupervisor: () => ({ getState: () => ({ phase: 'online' }) }) as never,
      ...(mode === 'plain' ? { getStoredContentCryptoContext: () => ({ mode: 'plain' as const, ctx: null }) } : {}),
      getPendingQueueState: () => ({ known: true as const, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 }),
      deliverMaterializedUserMessageToAgentQueue: deliver,
    });
    await api.materializeNextPendingMessageSafely();
    expect(deliver).not.toHaveBeenCalled();
    expect(socketAckMock).toHaveBeenNthCalledWith(2, 'session-pending-admission-settlement-v1', expect.objectContaining({
      decision: { kind: 'reject', code: 'session_input_invalid' },
    }));
  });

  it('keeps a restored custody-only Discussion original out of native delivery without manufacturing permission', async () => {
    const socket = createSocketStub();
    const discussionAddressing = { discussionId: 'discussion', messageId: 'question', throughSeq: 3, participantSessionId: 's1' };
    socketAckMock.mockResolvedValueOnce({ ok: true, didMaterialize: true, localId: 'custody-only', didWrite: false,
      pendingCount: 1, pendingVersion: 2, message: { id: null, seq: null, localId: 'custody-only', messageRole: 'user',
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Shared question' } } },
        inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine', discussionAddressing,
          admittedTarget: { homeId: 'home', accountId: 'owner', sessionId: 's1', machineId: 'machine', installationId: 'installation' } },
        createdAt: 1_000, updatedAt: 1_000, providerAction: 'send', deliveryState: { mode: 'provider', unresolved: true } },
    }).mockResolvedValueOnce({ v: 1, result: { status: 'held', localId: 'custody-only', code: 'session_input_target_unavailable' } });
    const deliver = vi.fn(() => true);
    const contractResult = { mode: 'session_sync_v2_pending_input_v1' as const,
      runtimeActivity: 'v2' as const, pendingInput: 'v1' as const, publisherAuthority: 'v1' as const,
      sessionConnectionEpoch: 1, socket };
    const api = createApi({ getSocket: () => socket as never,
      getSessionSyncPendingInputServerContractResult: () => contractResult,
      getSessionConnectionSupervisor: () => ({ getState: () => ({ phase: 'online' }) }) as never,
      getStoredContentCryptoContext: () => ({ mode: 'plain' as const, ctx: null }),
      getPendingQueueState: () => ({ known: true as const, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 }),
      applyPendingQueueState: vi.fn(() => true), deliverMaterializedUserMessageToAgentQueue: deliver,
    });
    await api.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    expect(deliver).not.toHaveBeenCalled();
    expect(socketAckMock).toHaveBeenNthCalledWith(2, 'session-pending-admission-settlement-v1', expect.objectContaining({
      decision: { kind: 'reject', code: 'session_input_untrusted_assertion' },
    }));
  });

  it.each(['active-turn', 'returned-answer', 'unavailable', 'malformed', 'attribution-only',
    'discussion-source', 'discussion-sender', 'discussion-other-source', 'discussion-unavailable'] as const)('enforces receiver mute for a protected source (%s) before provider delivery', async kind => {
    const socket = createSocketStub();
    const discussionAddressing = kind.startsWith('discussion-') ? {
      discussionId: 'discussion', messageId: 'question', throughSeq: 3, participantSessionId: 's1',
    } : undefined;
    const hasSender = kind === 'active-turn' || kind === 'unavailable' || kind === 'malformed' || kind === 'discussion-sender';
    const request = { v: 1 as const, producer: 'sessionAction' as const,
      caller: { kind: 'host' as const },
      ...(discussionAddressing ? { discussionAddressing, replyIntent: { mode: 'return' as const } } : {}),
      ...(hasSender
        ? { sourceSession: { sourceSessionId: 'sender', sourceTurnId: 'turn', via: 'action' as const } }
        : discussionAddressing ? {} : { returnedAnswer: { requestSessionId: 'original', requestLocalId: 'original-local', outcome: 'cancelled' as const,
            delivery: 'wake' as const, ...(kind === 'attribution-only'
              ? { answeredBy: { v: 1 as const, kind: 'happierSession' as const, sourceSessionId: 'sender', via: 'action' as const } }
              : { senderSessionId: 'sender' }) } }),
      permission: { requestedPermissionCeiling: 'read-only' as const } };
    const unavailable = kind === 'unavailable' || kind === 'malformed' || kind === 'discussion-unavailable';
    const unmuted = kind === 'attribution-only' || kind === 'discussion-other-source';
    axiosGetMock.mockResolvedValue({ status: kind === 'unavailable' || kind === 'discussion-unavailable' ? 503 : 200,
      data: kind === 'malformed' ? { scopes: null } : { scopes: [
      kind === 'discussion-source' || kind === 'discussion-other-source'
        ? { kind: 'source', source: { kind: 'discussion', discussionId: kind === 'discussion-source' ? 'discussion' : 'different-discussion' } }
        : { kind: 'sender_session', sessionId: 'sender' },
    ] } });
    socketAckMock.mockResolvedValueOnce({ ok: true, didMaterialize: true, localId: 'muted-local',
      didWrite: false, pendingCount: 1, pendingVersion: 2,
      message: { id: null, seq: null, localId: 'muted-local', messageRole: 'user',
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'muted request' },
          meta: { happierProvenanceV1: { v: 1, kind: 'host', producer: 'sessionAction' },
            happierInputRequestV1: request } } },
        inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine', ...(discussionAddressing ? {
          discussionAddressing, admittedTarget: { homeId: 'home', accountId: 'owner', sessionId: 's1', machineId: 'machine', installationId: 'installation' },
        } : {}) },
        createdAt: 1_000, updatedAt: 1_000, providerAction: 'send',
        deliveryState: { mode: 'provider', unresolved: true } },
    }).mockResolvedValueOnce({ v: 1, result: unmuted
      ? { status: 'accepted', localId: 'muted-local' }
      : { status: 'rejected', code: 'session_input_muted' } });
    const deliver = vi.fn(() => true);
    const contractResult = { mode: 'session_sync_v2_pending_input_v1' as const,
      runtimeActivity: 'v2' as const, pendingInput: 'v1' as const, publisherAuthority: 'v1' as const,
      sessionConnectionEpoch: 1, socket };
    const api = createApi({ getSocket: () => socket as never,
      getSessionSyncPendingInputServerContractResult: () => contractResult,
      getSessionConnectionSupervisor: () => ({ getState: () => ({ phase: 'online' }) }) as never,
      getStoredContentCryptoContext: () => ({ mode: 'plain' as const, ctx: null }),
      getPendingQueueState: () => ({ known: true as const, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 }),
      applyPendingQueueState: vi.fn(() => true),
      deliverMaterializedUserMessageToAgentQueue: deliver,
    });
    const outcome = await api.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    if (unmuted) {
      expect(outcome).toMatchObject({ type: 'materialized', localId: 'muted-local' });
      if (kind === 'attribution-only') expect(axiosGetMock).not.toHaveBeenCalled();
      else expect(axiosGetMock).toHaveBeenCalledWith(expect.stringContaining('/v2/sessions/s1/delivery-mutes'), expect.any(Object));
      expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ localId: 'muted-local' }), 'send', { v: 1, kind: 'enqueue' });
      return;
    }
    expect(axiosGetMock).toHaveBeenCalledWith(expect.stringContaining('/v2/sessions/s1/delivery-mutes'), expect.any(Object));
    expect(deliver).not.toHaveBeenCalled();
    if (unavailable) {
      expect(outcome).toMatchObject({ type: 'retryable_transport' });
      expect(socketAckMock).toHaveBeenCalledTimes(1);
      return;
    }
    expect(outcome).toMatchObject({ type: 'no_pending' });
    expect(socketAckMock).toHaveBeenNthCalledWith(2, 'session-pending-admission-settlement-v1',
      expect.objectContaining({ decision: expect.objectContaining({ kind: 'reject', code: 'session_input_muted' }) }));
  });

  it('opens a protected encrypted row once during final readmission', async () => {
    const socket = createSocketStub();
    const localId = 'owned-action-input';
    const ctx = { encryptionKey: new Uint8Array(32).fill(9), encryptionVariant: 'dataKey' as const };
    const inputAdmissionReceipt = { v: 1 as const, issuer: 'authenticatedMachine' as const };
    const request = { v: 1 as const, producer: 'sessionAction' as const, caller: { kind: 'host' as const },
      replyIntent: { mode: 'wait' as const }, permission: {} };
    const authority = settleSessionInputRequestV1({ request, inputAdmissionReceipt, currentSessionPermissionCeiling: 'default' });
    const content = { t: 'encrypted' as const, c: encryptSessionPayload({ ctx, payload: {
      role: 'user', content: { type: 'text', text: 'Send through the owned Action' },
      meta: withSessionInputAuthority({}, authority),
    } }) };
    axiosGetMock.mockResolvedValueOnce({ status: 200, data: { message: {
      id: 'owned-action-message', seq: 9, localId, messageRole: 'user', createdAt: 1000, updatedAt: 1000,
      inputAdmissionReceipt, content,
    } } });
    socketAckMock.mockResolvedValueOnce({ v: 1, result: { status: 'alreadyAccepted', localId } });
    const api = createApi({ getSocket: () => socket as never, getStoredContentCryptoContext: () => ({ mode: 'e2ee', ctx }) });
    const open = vi.spyOn(sessionEncryption, 'openSessionMessageContent');
    try {
      await expect(api.reconcileSessionInputForProviderDispatch({ localId, signal: new AbortController().signal }))
        .resolves.toBe('admitted');
      expect(open).toHaveBeenCalledTimes(1);
      expect(socketAckMock).toHaveBeenCalledWith('session-pending-admission-settlement-v1', expect.objectContaining({
        localId, decision: expect.objectContaining({ kind: 'admit', finalContent: content }),
      }));
    } finally {
      open.mockRestore();
    }
  });

  it('preserves local cancellation during the retained input lookup', async () => {
    const abort = new AbortController();
    const cancellation = new DOMException('Input cancelled', 'AbortError');
    axiosGetMock.mockImplementation(async () => {
      abort.abort(cancellation);
      throw new AxiosError('request cancelled', 'ERR_CANCELED');
    });
    const socket = createSocketStub();
    const api = createApi({ getSocket: () => socket as never });
    await expect(api.reconcileSessionInputForProviderDispatch({ localId: 'retained-input', signal: abort.signal }))
      .rejects.toBe(cancellation);
  });

  it.each((['valid', 'revoked', 'muted', 'held', 'unavailable', 'changed-cutoff', 'missing-service',
    'invalid-receipt', 'invalid-authority', 'settlement-unknown', 'permission-broadened', 'permission-narrowed',
    'admitted-mute-changed', 'admitted-check-in-unavailable', 'unadmitted-check-in-unavailable', 'transport-abort'] as const)
    .flatMap(state => (['normal', 'steer'] as const).flatMap(delivery =>
      (state === 'valid' || state === 'permission-narrowed' || state === 'admitted-mute-changed'
        || state === 'admitted-check-in-unavailable' || state === 'unadmitted-check-in-unavailable'
        ? ['plain', 'e2ee'] as const : ['plain'] as const).map(mode => ({ state, delivery, mode }))))) (
    'rechecks the original queued Discussion input after checkpoint preparation ($state, $delivery, $mode)', async ({ state, delivery, mode }) => {
      const discussionAddressing = { discussionId: 'discussion', messageId: 'question', throughSeq: 3, participantSessionId: 's1' };
      const localId = 'original-discussion-input';
      const originatingDiscussion = { serverId: 'home', discussionId: 'originating-discussion' };
      const socket = createSocketStub();
      let checkpointFinished = false;
      let readBeforePreparationFinished = false;
      const requestedOriginal = { id: 'committed-input', seq: 9, localId, createdAt: 1_000, updatedAt: 1_000, messageRole: 'user',
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Answer the original question' }, meta: {
          happierProvenanceV1: { v: 1, kind: 'host', producer: 'sessionAction' },
          happierInputRequestV1: { v: 1, producer: 'sessionAction', caller: { kind: 'host' }, discussionAddressing,
            ...(state === 'admitted-check-in-unavailable' || state === 'unadmitted-check-in-unavailable'
              ? { sourceSession: { sourceSessionId: 'sender', sourceTurnId: 'turn', via: 'action' as const } } : {}),
            ...(delivery === 'steer' ? { actionRequestAttributionV1: { requestRef: 'origin-input', requester: null,
              persona: { serverId: 'home', sessionId: 's1' }, origin: { kind: 'discussion',
                discussion: originatingDiscussion, messageId: 'origin-message' } } } : {}),
            replyIntent: { mode: 'return' }, permission: state === 'permission-broadened' ? {}
              : { requestedPermissionCeiling: state === 'permission-narrowed' ? 'default' : 'read-only' } },
        } } }, inputAdmissionReceipt: { v: 1 as const, issuer: 'authenticatedMachine' as const, discussionAddressing,
          admittedTarget: { homeId: 'home', accountId: 'owner', sessionId: 's1', machineId: 'machine', installationId: 'installation' } } };
      const request = readSessionInputRequest(requestedOriginal.content.v.meta, 'stored');
      if (!request || request.v !== 1) throw new Error('Expected the original protected request fixture');
      const authority = settleSessionInputRequestV1({ request,
        currentSessionPermissionCeiling: state === 'permission-broadened' ? 'read-only' : 'default',
        inputAdmissionReceipt: requestedOriginal.inputAdmissionReceipt });
      // This is the actual target materialization producer: committed input has
      // immutable authority and deliberately no caller request metadata.
      const settledMeta: Record<string, unknown> = state === 'unadmitted-check-in-unavailable'
        ? requestedOriginal.content.v.meta : withSessionInputAuthority(requestedOriginal.content.v.meta, authority);
      const settledPayload = { ...requestedOriginal.content.v, meta: settledMeta };
      if (state !== 'unadmitted-check-in-unavailable') expect(settledPayload.meta).not.toHaveProperty('happierInputRequestV1');
      if (state === 'invalid-authority') settledPayload.meta.happierInputAuthorityV1 = { ...authority,
        permission: { admittedPermissionCeiling: 'invalid' } };
      const ctx = { encryptionKey: new Uint8Array(32).fill(9), encryptionVariant: 'dataKey' as const };
      const original = { ...requestedOriginal, content: mode === 'e2ee'
        ? { t: 'encrypted', c: encryptSessionPayload({ ctx, payload: settledPayload }) }
        : { t: 'plain', v: settledPayload },
        inputAdmissionReceipt: state === 'invalid-receipt' ? { ...requestedOriginal.inputAdmissionReceipt,
          discussionAddressing: { ...discussionAddressing, throughSeq: 4 } } : requestedOriginal.inputAdmissionReceipt };
      const transportAbort = new AxiosError('connection aborted', 'ECONNABORTED');
      axiosGetMock.mockImplementation(async (url: string) => {
        if (state === 'transport-abort' && url.includes('/messages/by-local-id/')) throw transportAbort;
        if (!checkpointFinished) readBeforePreparationFinished = true;
        if (url.includes('/messages/by-local-id/')) return { status: state === 'unavailable' ? 503 : 200, data: { message: original } };
        if (url.includes('/delivery-mutes')) return { status: 200, data: { scopes: state === 'muted' || state === 'admitted-mute-changed'
          ? [{ kind: 'source', source: { kind: 'discussion', discussionId: 'discussion' } }] : [] } };
        throw new Error(`Unexpected transport URL: ${url}`);
      });
      socketAckMock.mockImplementation(async () => {
        return { v: 1, result: state === 'revoked' ? { status: 'rejected', code: 'session_input_cancelled' }
          : state === 'muted' ? { status: 'rejected', code: 'session_input_muted' }
          : state === 'held' ? { status: 'held', localId, code: 'autonomous_check_in' }
          : state === 'settlement-unknown' ? { status: 'outcomeUnknown', localId, code: 'settlement_unavailable' }
          : { status: 'alreadyAccepted', localId } };
      });
      const api = createApi({ getSocket: () => socket as never,
        getStoredContentCryptoContext: () => mode === 'e2ee' ? { mode, ctx } : { mode, ctx: null },
        getMetadata: () => createTestMetadata({ permissionMode: state === 'permission-narrowed' ? 'read-only' : 'default' }),
        // Only a new admission needs the current preference. Retained input
        // already carries its immutable authority and admission receipt.
        readCurrentAutonomousCheckIn: async origin => {
          if (state === 'admitted-check-in-unavailable' || state === 'unadmitted-check-in-unavailable') return null;
          const configuredDiscussion = delivery === 'steer' ? originatingDiscussion
            : { serverId: 'home', discussionId: discussionAddressing.discussionId };
          return { afterTurns: resolveAutonomousExchangeAfterTurnsV1(5,
            origin?.serverId === configuredDiscussion.serverId && origin.discussionId === configuredDiscussion.discussionId
              ? { afterTurns: 10 } : undefined) };
        },
      });
      let receiveUserMessage: ((message: UserMessage) => boolean | void) | undefined;
      const observeProviderInputSettlement = vi.fn(async () => false);
      const confirmUserMessageLocallyConsumed = vi.fn();
      const rejectSteerBeforeProvider = vi.fn();
      const published: unknown[] = [];
      const onPromptFailure = vi.fn();
      const session = createMutableApiSessionClientFixture({ sessionId: 's1',
        metadata: createTestMetadata({ permissionMode: 'default', permissionModeUpdatedAt: 0 }), overrides: {
          onUserMessage: handler => { receiveUserMessage = handler; },
          observeProviderInputSettlement,
          confirmUserMessageLocallyConsumed,
          // The original Discussion carries no attachment sources; hydration of its cutoff resolves to nothing.
          materializeDiscussionAttachmentsForDispatch: async () => null,
          enqueueSessionEventCommitted: async () => ({ persisted: true, delivered: false }),
          enqueueAgentMessageCommitted: async (_provider, body) => {
            published.push(body);
            return { persisted: true, delivered: false };
          },
          ...(state === 'missing-service' ? {} : {
            reconcileSessionInputForProviderDispatch: input => api.reconcileSessionInputForProviderDispatch(input),
          }),
        } });
      const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(mode => JSON.stringify(mode), { batcher: combinePermissionModeQueuedPrompts });
      const queuedAddressing = state === 'changed-cutoff' ? { ...discussionAddressing, throughSeq: 4 } : discussionAddressing;
      const nativeSend = vi.fn(async (_text: string) => {});
      const nativeSteer = vi.fn(async () => {});
      // The native provider is the only runtime boundary replaced; host preparation and receiver settlement stay real.
      const runtime = { beginTurnLifecycle() {}, sendTurnPrompt: nativeSend, steerInFlightTurn: nativeSteer,
        waitForTurnCompletion: async () => {}, subscribeRuntimeEvents: () => () => {}, respondToPermission: async () => {},
        cancelTurn: async () => {}, readSessionIdentity: () => ({ sessionId: 'native' }), updateSessionRuntimeConfig: async () => {},
        resetOrDisposeRuntime: async () => {}, shouldResumeAfterPermissionModeChange: () => true } as unknown as PermissionModePromptLoopTurnOperations;
      let shouldExit = false;
      if (delivery === 'steer') {
        assertSessionInputAdmissionReceiptForAuthorityV1({ authority, inputAdmissionReceipt: requestedOriginal.inputAdmissionReceipt });
        registerPermissionModeMessageQueueBinding({ session, queue, getCurrentPermissionMode: () => 'default', setCurrentPermissionMode() {},
          inFlightSteer: { isTurnInFlight: () => true, supportsInFlightSteer: () => true, steerText: nativeSteer,
            readActivePermissionMode: () => 'read-only',
            applyConfigDeltaInFlight: async () => ({ status: 'applied' }),
            rejectPromptBeforeProvider: rejectSteerBeforeProvider,
            registerProviderAcceptedEffect() {}, prepareHostContext: async () => { checkpointFinished = true; return null; },
            readStructuredInputDispatchServices: () => ({ sessionId: 's1', materializeDiscussionAttachmentsForDispatch: async () => null, ...(state === 'missing-service' ? {} : {
              reconcileSessionInputForProviderDispatch: input => api.reconcileSessionInputForProviderDispatch(input),
            }) }),
          },
        });
        receiveUserMessage?.({ role: 'user', localId, content: { type: 'text', text: 'Answer the original question' },
          inputAdmissionReceipt: requestedOriginal.inputAdmissionReceipt,
          pendingProviderAction: 'steer', pendingRequestedAction: { v: 1, kind: 'steer_if_active' }, meta: {
            happierInputAuthorityV1: { ...authority, discussionAddressing: queuedAddressing },
          } });
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(nativeSteer).not.toHaveBeenCalled();
        expect(nativeSend).not.toHaveBeenCalled();
        expect(checkpointFinished).toBe(false);
        if (state === 'changed-cutoff') {
          expect(queue.size()).toBe(0);
          expect(axiosGetMock).not.toHaveBeenCalled();
          return;
        }
        expect(rejectSteerBeforeProvider).not.toHaveBeenCalled();
        expect(queue.queue).toMatchObject([{ isolate: true, message: { localId, discussionAddressing } }]);
      } else {
        queue.push({ text: 'Answer the original question', localId, discussionAddressing: queuedAddressing }, { permissionMode: 'default' });
      }
      if (state === 'revoked' || state === 'transport-abort') queue.pushIsolate({ text: 'UNRELATED_ORDINARY_INPUT', localId: 'ordinary-after-removal' }, { permissionMode: 'default' });
      await runPermissionModePromptLoop({ providerName: 'Test', agentMessageType: 'codex', explicitPermissionMode: undefined,
        session, messageQueue: queue, permissionHandler: { setPermissionMode() {}, reset() {} }, runtime,
        createOverrideSynchronizer: () => ({ syncFromMetadata() {}, flushPendingAfterStart: async () => {} }),
        messageBuffer: new MessageBuffer(), shouldExit: () => shouldExit, getAbortSignal: () => new AbortController().signal,
        keepAlive() {}, setThinking() {}, sendReady() {
          shouldExit = (state !== 'revoked' && state !== 'transport-abort') || nativeSend.mock.calls.some(([text]) => text.includes('UNRELATED_ORDINARY_INPUT'));
        }, currentPermissionModeUpdatedAt: 0,
        setCurrentPermissionMode() {}, setCurrentPermissionModeUpdatedAt() {}, formatPromptErrorMessage: String,
        onPromptFailure,
        registerProviderAcceptedEffect() {}, checkpointLifecycle: { onBeforePromptDispatch: async () => { checkpointFinished = true; } },
      });
      expect(checkpointFinished).toBe(true);
      expect(readBeforePreparationFinished).toBe(false);
      if (state === 'transport-abort') {
        expect(onPromptFailure).toHaveBeenCalledWith(expect.objectContaining({
          code: 'session_input_admission_unavailable', retryable: true, cause: transportAbort,
        }), expect.anything());
        expect(observeProviderInputSettlement).toHaveBeenCalledWith(expect.objectContaining({
          localId, kind: 'rejected_before_effect', retryable: true, retireLocalCustodyAfterDurableBlock: true,
        }));
        expect(nativeSend).toHaveBeenCalledWith(expect.stringContaining('UNRELATED_ORDINARY_INPUT'), expect.anything());
        expect(queue.size()).toBe(0);
      }
      expect(nativeSteer).not.toHaveBeenCalled();
      // The original's immutable authority already admitted this bounded input.
      // A later policy change applies to the next natural request.
      const admitted = state === 'valid' || state === 'permission-broadened' || state === 'permission-narrowed'
        || state === 'admitted-mute-changed' || state === 'admitted-check-in-unavailable';
      expect(nativeSend).toHaveBeenCalledTimes(admitted || state === 'revoked' || state === 'transport-abort' ? 1 : 0);
      if (state === 'revoked') {
        expect(nativeSend).toHaveBeenCalledWith(expect.stringContaining('UNRELATED_ORDINARY_INPUT'), expect.anything());
        expect(nativeSend.mock.calls.some(([text]) => text.includes('Answer the original question'))).toBe(false);
        expect(published).not.toContainEqual(expect.objectContaining({ type: 'turn_failed' }));
        expect(onPromptFailure).not.toHaveBeenCalled();
        expect(observeProviderInputSettlement).not.toHaveBeenCalled();
      } else if (!admitted) {
        const retryable = state === 'held' || state === 'unavailable' || state === 'missing-service' || state === 'settlement-unknown'
          || state === 'unadmitted-check-in-unavailable' || state === 'transport-abort';
        expect(observeProviderInputSettlement).toHaveBeenCalledWith(expect.objectContaining({
          kind: 'rejected_before_effect', localId, retryable,
          // Admission owns this code; the shared runtime classifier owns the
          // surrounding host/provider failure taxonomy.
          diagnostic: expect.objectContaining({ code: state === 'held' ? 'session_input_held'
            : retryable ? 'session_input_admission_unavailable' : 'session_input_rejected' }),
        }));
        expect(confirmUserMessageLocallyConsumed).not.toHaveBeenCalled();
      }
      if (state === 'missing-service') expect(axiosGetMock).not.toHaveBeenCalled();
      else expect(axiosGetMock).toHaveBeenCalledWith(expect.stringContaining(`/messages/by-local-id/${localId}`), expect.any(Object));
      if (admitted) expect(axiosGetMock.mock.calls.some(([url]) => String(url).includes('/delivery-mutes'))).toBe(false);
      if (admitted || state === 'revoked' || state === 'muted' || state === 'held' || state === 'settlement-unknown') {
        expect(socketAckMock).toHaveBeenCalledWith('session-pending-admission-settlement-v1',
          expect.objectContaining({ sessionId: 's1', localId,
            decision: expect.objectContaining({ validation: { reply: { mode: 'return', discussion: discussionAddressing,
              ...(request.actionRequestAttributionV1 ? { actionRequestAttributionV1: request.actionRequestAttributionV1 } : {}),
              ...(request.sourceSession ? { sourceSession: request.sourceSession } : {}) },
              ...(request.sourceSession ? { sourceSession: request.sourceSession } : {}) } }) }));
        expect(socketAckMock).toHaveBeenCalledWith('session-pending-admission-settlement-v1',
          expect.objectContaining({ decision: expect.objectContaining({ kind: 'admit', finalContent: original.content }) }));
      } else expect(socketAckMock).not.toHaveBeenCalled();
    });

  it.each([
    { state: 'valid', mode: 'plain' }, { state: 'valid', mode: 'e2ee' },
    { state: 'discarded', mode: 'plain' }, { state: 'discarded', mode: 'e2ee' },
    { state: 'discarded-with-peer', mode: 'plain' },
    { state: 'discarded-during-host-commit', mode: 'plain' },
    { state: 'discarded-during-steer-commit', mode: 'plain' },
    { state: 'missing-service', mode: 'plain' },
    { state: 'wrong-binding', mode: 'plain' },
  ] as const)('rechecks materialized Workflow input custody after host preparation ($state, $mode)', async ({ state, mode }) => {
    const socket = createSocketStub();
    const localId = 'workflow-input-v2:queued-original';
    const request = { v: 2 as const, producer: 'workflow' as const, caller: { kind: 'host' as const },
      replyIntent: { mode: 'wait' as const }, workflow: { purpose: 'invocation' as const,
        runId: 'workflow-run', invocationRecordId: 'invocation' },
      permission: { requestedPermissionCeiling: 'read-only' as const } };
    const ctx = { encryptionKey: new Uint8Array(32).fill(9), encryptionVariant: 'dataKey' as const };
    const payload = { role: 'user', content: { type: 'text', text: 'Run the original input' },
      meta: { happierInputRequestV1: request, happierProvenanceV1: { v: 2, kind: 'workflow_invocation',
        runId: request.workflow.runId, invocationRecordId: request.workflow.invocationRecordId } } };
    const content: SessionMessageContent = mode === 'plain' ? { t: 'plain', v: payload }
      : { t: 'encrypted', c: encryptSessionPayload({ ctx, payload }) };
    let finalContent: SessionMessageContent | undefined;
    let admittedMessage: UserMessage | undefined;
    let peerMessage: UserMessage | undefined;
    let discarded = false;
    let finalAdmissionRead = false;
    socketAckMock.mockImplementation(async (event: string, input: unknown) => {
      if (event === 'session-pending-admission-settlement-v1') {
        const settlement = SessionPendingAdmissionSettlementRequestV1Schema.parse(input);
        if (settlement.decision.kind !== 'admit') throw new Error('Expected real receiver admission');
        if (!finalContent) {
          finalContent = settlement.decision.finalContent;
          return { v: 1, result: { status: 'accepted', localId } };
        }
        finalAdmissionRead = true;
        return { v: 1, result: discarded && settlement.localId === localId ? { status: 'rejected', code: 'session_input_cancelled' }
          : { status: 'alreadyAccepted', localId: state === 'wrong-binding' ? 'foreign-input' : settlement.localId } };
      }
      return { ok: true, didMaterialize: true, localId, didWrite: false,
        pendingCount: 1, pendingVersion: 2, message: { id: null, seq: null, localId, messageRole: 'user',
          content, inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' },
          createdAt: 1_000, updatedAt: 1_000, providerAction: 'send', deliveryState: { mode: 'provider', unresolved: true } } };
    });
    axiosGetMock.mockImplementation(async (url: string) => {
      if (!url.includes('/messages/by-local-id/') || !finalContent) throw new Error(`Unexpected transport URL: ${url}`);
      const requestedLocalId = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
      return { status: 200, data: { message: { id: 'committed-original', seq: 9, localId: requestedLocalId,
        messageRole: 'user', content: requestedLocalId === peerMessage?.localId ? { t: 'plain', v: {
          role: peerMessage.role, content: peerMessage.content, meta: peerMessage.meta,
        } } : finalContent, inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' },
        createdAt: 1_000, updatedAt: 1_000 } } };
    });
    let receive: ((message: UserMessage) => boolean | void) | undefined;
    const observeProviderInputSettlement = vi.fn(async () => false);
    let shouldExit = false;
    const published: unknown[] = [];
    const contract = { mode: 'session_sync_v2_pending_input_v1' as const,
      runtimeActivity: 'v2' as const, pendingInput: 'v1' as const, publisherAuthority: 'v1' as const,
      sessionConnectionEpoch: 1, socket };
    const api = createApi({ getSocket: () => socket as never,
      getSessionSyncPendingInputServerContractResult: () => contract,
      getSessionConnectionSupervisor: () => ({ getState: () => ({ phase: 'online' }) }) as never,
      getMetadata: () => createTestMetadata({ permissionMode: 'default' }),
      getStoredContentCryptoContext: () => mode === 'plain' ? { mode, ctx: null } : { mode, ctx },
      getPendingQueueState: () => ({ known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 }),
      applyPendingQueueState: () => true,
      deliverMaterializedUserMessageToAgentQueue: message => { admittedMessage = message; return receive?.(message) === true; },
    });
    const session = createMutableApiSessionClientFixture({ sessionId: 's1',
      metadata: createTestMetadata({ permissionMode: 'default', permissionModeUpdatedAt: 0 }), overrides: {
        onUserMessage: handler => { receive = handler; }, observeProviderInputSettlement,
        enqueueSessionEventCommitted: async () => ({ persisted: true, delivered: false }),
        enqueueAgentMessageCommitted: async (_provider, body) => {
          published.push(body);
          return { persisted: true, delivered: false };
        },
        ...(state === 'missing-service' ? {} : { reconcileSessionInputForProviderDispatch: async input => {
          const status = await api.reconcileSessionInputForProviderDispatch(input);
          if (status === 'withdrawn' && queue.size() === 0) shouldExit = true;
          return status;
        } }),
      } });
    const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(() => 'same-mode',
      { batcher: combinePermissionModeQueuedPrompts });
    const nativeSteer = vi.fn(async () => {});
    const rejectSteer = vi.fn();
    registerPermissionModeMessageQueueBinding({ session, queue, getCurrentPermissionMode: () => 'default', setCurrentPermissionMode() {},
      ...(state === 'discarded-during-steer-commit' ? { inFlightSteer: {
        isTurnInFlight: () => true, supportsInFlightSteer: () => true, readActivePermissionMode: () => 'default' as const,
        steerText: nativeSteer, registerProviderAcceptedEffect() {}, rejectPromptBeforeProvider: rejectSteer,
        prepareHostContext: async () => ({ updates: [], acknowledgeAccepted() {},
          commitWorkerUpdateEvents: async () => { discarded = true; } }),
        readStructuredInputDispatchServices: () => ({ sessionId: 's1',
          reconcileSessionInputForProviderDispatch: input => api.reconcileSessionInputForProviderDispatch(input) }),
      } } : {}),
    });
    await expect(api.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({ type: 'materialized', localId });
    if (state === 'discarded-during-steer-commit') {
      await vi.waitFor(() => expect(discarded).toBe(true));
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(nativeSteer).not.toHaveBeenCalled();
      expect(rejectSteer).not.toHaveBeenCalled();
      expect(queue.size()).toBe(0);
      return;
    }
    expect(queue.queue).toMatchObject([{ message: { localId, causalPermissionAuthority: { admittedPermissionCeiling: 'read-only' } } }]);
    if (state === 'discarded-with-peer') {
      const original = queue.queue[0].message;
      if (!admittedMessage) throw new Error('Expected the real materialization producer to supply its admitted input');
      peerMessage = { ...admittedMessage, localId: 'valid-peer', content: { type: 'text', text: 'Preserve this peer' } };
      receive?.(peerMessage);
      expect(queue.size()).toBe(2);
      expect(queue.queue[0].message).toBe(original);
    }
    const nativeSend = vi.fn(async () => {});
    const runtime = { beginTurnLifecycle() {}, sendTurnPrompt: nativeSend, waitForTurnCompletion: async () => {},
      subscribeRuntimeEvents: () => () => {}, respondToPermission: async () => {}, cancelTurn: async () => {},
      readSessionIdentity: () => ({ sessionId: 'native' }), updateSessionRuntimeConfig: async () => {},
      resetOrDisposeRuntime: async () => {}, shouldResumeAfterPermissionModeChange: () => true } as unknown as PermissionModePromptLoopTurnOperations;
    await runPermissionModePromptLoop({ providerName: 'External Agent', agentMessageType: 'plugin:external-agent/agent', explicitPermissionMode: undefined,
      session, messageQueue: queue, permissionHandler: { setPermissionMode() {}, reset() {} }, runtime,
      createOverrideSynchronizer: () => ({ syncFromMetadata() {}, flushPendingAfterStart: async () => {} }),
      messageBuffer: new MessageBuffer(), shouldExit: () => shouldExit, getAbortSignal: () => new AbortController().signal,
      keepAlive() {}, setThinking() {}, sendReady() { shouldExit = queue.size() === 0; }, currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode() {}, setCurrentPermissionModeUpdatedAt() {}, formatPromptErrorMessage: String,
      registerProviderAcceptedEffect() {}, checkpointLifecycle: { onBeforePromptDispatch: async () => {
        discarded = state === 'discarded' || state === 'discarded-with-peer';
      } },
      prepareHostContext: async () => state === 'discarded-during-host-commit'
        ? { updates: [], acknowledgeAccepted() {}, commitWorkerUpdateEvents: async () => { discarded = true; } } : null,
    });
    expect(nativeSend).toHaveBeenCalledTimes(state === 'valid' || state === 'discarded-with-peer' ? 1 : 0);
    if (state === 'discarded-with-peer') expect(nativeSend).toHaveBeenCalledWith(expect.stringContaining('Preserve this peer'),
      expect.objectContaining({ localId: 'valid-peer', localIds: ['valid-peer'] }));
    expect(finalAdmissionRead).toBe(state !== 'missing-service');
    if (state === 'missing-service' || state === 'wrong-binding') expect(observeProviderInputSettlement).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'rejected_before_effect', localId, retryable: state === 'missing-service' || state === 'wrong-binding',
    }));
    else {
      expect(observeProviderInputSettlement).not.toHaveBeenCalled();
      expect(published).not.toContainEqual(expect.objectContaining({ type: 'turn_failed' }));
    }
  });

  it('settles Workflow V2 provenance, reply and authority through the existing Session permission owner', async () => {
    const socket = createSocketStub();
    const contractResult = {
      mode: 'session_sync_v2_pending_input_v1' as const,
      runtimeActivity: 'v2' as const,
      pendingInput: 'v1' as const,
      publisherAuthority: 'v1' as const,
      sessionConnectionEpoch: 1,
      socket,
    };
    const request = {
      v: 2 as const,
      producer: 'workflow' as const,
      caller: { kind: 'host' as const },
      replyIntent: { mode: 'wait' as const },
      workflow: {
        purpose: 'invocation' as const,
        runId: 'workflow-run-1',
        invocationRecordId: 'invocation-1',
      },
      permission: { requestedPermissionCeiling: 'read-only' as const },
    };
    socketAckMock
      .mockResolvedValueOnce({
        ok: true,
        didMaterialize: true,
        localId: 'workflow-local',
        didWrite: false,
        pendingCount: 1,
        pendingVersion: 2,
        message: {
          id: null,
          seq: null,
          localId: 'workflow-local',
          messageRole: 'user',
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'run workflow step' },
              meta: {
                happierProvenanceV1: {
                  v: 2,
                  kind: 'workflow_invocation',
                  runId: 'workflow-run-1',
                  invocationRecordId: 'invocation-1',
                },
                happierInputRequestV1: request,
              },
            },
          },
          inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' },
          createdAt: 1_000,
          updatedAt: 1_000,
          providerAction: 'send',
          deliveryState: { mode: 'provider', unresolved: true },
        },
      })
      .mockResolvedValueOnce({
        v: 1,
        result: { status: 'accepted', localId: 'workflow-local' },
      });
    const deliver = vi.fn(() => true);
    const handleSessionScopedUpdate = vi.fn();
    const api = createApi({
      getSocket: () => socket as never,
      getSessionSyncPendingInputServerContractResult: () => contractResult,
      getSessionConnectionSupervisor: () => ({ getState: () => ({ phase: 'online' }) }) as never,
      getMetadata: () => createTestMetadata({ permissionMode: 'safe-yolo' }),
      getStoredContentCryptoContext: () => ({ mode: 'plain' as const, ctx: null }),
      getPendingQueueState: () => ({ known: true as const, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 }),
      applyPendingQueueState: vi.fn(() => true),
      deliverMaterializedUserMessageToAgentQueue: deliver,
      handleSessionScopedUpdate,
    } as any);

    await expect(api.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'workflow-local',
    });
    expect(socketAckMock).toHaveBeenNthCalledWith(2, 'session-pending-admission-settlement-v1', expect.objectContaining({
      decision: expect.objectContaining({
        kind: 'admit',
        validation: { reply: { mode: 'wait', workflow: request.workflow } },
        finalContent: expect.objectContaining({
          t: 'plain',
          v: expect.objectContaining({
            meta: expect.objectContaining({
              happierInputAuthorityV1: expect.objectContaining({
                v: 2,
                producer: 'workflow',
                replyIntent: { mode: 'wait' },
                workflow: request.workflow,
                permission: {
                  requestedPermissionCeiling: 'read-only',
                  admittedPermissionCeiling: 'read-only',
                },
              }),
              happierProvenanceV1: {
                v: 2,
                kind: 'workflow_invocation',
                runId: 'workflow-run-1',
                invocationRecordId: 'invocation-1',
              },
            }),
          }),
        }),
      }),
    }));
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({
        happierInputAuthorityV1: expect.objectContaining({ v: 2, producer: 'workflow' }),
        happierProvenanceV1: expect.objectContaining({ v: 2, kind: 'workflow_invocation' }),
      }),
    }), 'send', { v: 1, kind: 'enqueue' });
  });

  it('never projects or delivers a protected input rejected by target settlement', async () => {
    const socket = createSocketStub();
    const contractResult = {
      mode: 'session_sync_v2_pending_input_v1' as const,
      runtimeActivity: 'v2' as const,
      pendingInput: 'v1' as const,
      publisherAuthority: 'v1' as const,
      sessionConnectionEpoch: 1,
      socket,
    };
    socketAckMock
      .mockResolvedValueOnce({
        ok: true,
        didMaterialize: true,
        localId: 'rejected-local',
        didWrite: false,
        pendingCount: 1,
        pendingVersion: 2,
        message: {
          id: null,
          seq: null,
          localId: 'rejected-local',
          messageRole: 'user',
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'reject me' },
              meta: {
                happierInputRequestV1: {
                  v: 1,
                  producer: 'pluginSession',
                  caller: { kind: 'plugin', pluginId: 'example.plugin', contributionLocalId: 'send' },
                  permission: { requestedPermissionCeiling: 'yolo' },
                },
              },
            },
          },
          inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' },
          createdAt: 1_000,
          updatedAt: 1_000,
          providerAction: 'send',
          deliveryState: { mode: 'provider', unresolved: true },
        },
      })
      .mockResolvedValueOnce({
        v: 1,
        result: { status: 'rejected', code: 'session_input_permission_ceiling_rejected' },
      });
    const deliver = vi.fn(() => true);
    const handleSessionScopedUpdate = vi.fn();
    const api = createApi({
      getSocket: () => socket as never,
      getSessionSyncPendingInputServerContractResult: () => contractResult,
      getSessionConnectionSupervisor: () => ({ getState: () => ({ phase: 'online' }) }) as never,
      getMetadata: () => createTestMetadata({ permissionMode: 'read-only' }),
      getStoredContentCryptoContext: () => ({ mode: 'plain' as const, ctx: null }),
      getPendingQueueState: () => ({ known: true as const, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 }),
      applyPendingQueueState: vi.fn(() => true),
      deliverMaterializedUserMessageToAgentQueue: deliver,
      handleSessionScopedUpdate,
    } as any);

    await expect(api.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toEqual({
      type: 'no_pending',
    });

    expect(handleSessionScopedUpdate).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('rejects an Account-admitted plugin assertion before projection or provider delivery', async () => {
    const socket = createSocketStub();
    const contractResult = {
      mode: 'session_sync_v2_pending_input_v1' as const,
      runtimeActivity: 'v2' as const,
      pendingInput: 'v1' as const,
      publisherAuthority: 'v1' as const,
      sessionConnectionEpoch: 1,
      socket,
    };
    socketAckMock
      .mockResolvedValueOnce({
        ok: true,
        didMaterialize: true,
        localId: 'forged-receipt-local',
        didWrite: false,
        pendingCount: 1,
        pendingVersion: 2,
        message: {
          id: null,
          seq: null,
          localId: 'forged-receipt-local',
          messageRole: 'user',
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'forged provenance' },
              meta: {
                happierInputRequestV1: {
                  v: 1,
                  producer: 'pluginSession',
                  caller: { kind: 'plugin', pluginId: 'example.plugin', contributionLocalId: 'send' },
                  permission: {},
                },
              },
            },
          },
          inputAdmissionReceipt: {
            v: 1,
            issuer: 'authenticatedAccount',
            actorAccountId: 'account-1',
            sessionRelationship: 'owner',
          },
          createdAt: 1_000,
          updatedAt: 1_000,
          providerAction: 'send',
          deliveryState: { mode: 'provider', unresolved: true },
        },
      })
      .mockResolvedValueOnce({
        v: 1,
        result: { status: 'rejected', code: 'session_input_untrusted_assertion' },
      });
    const deliver = vi.fn(() => true);
    const handleSessionScopedUpdate = vi.fn();
    const api = createApi({
      getSocket: () => socket as never,
      getSessionSyncPendingInputServerContractResult: () => contractResult,
      getSessionConnectionSupervisor: () => ({ getState: () => ({ phase: 'online' }) }) as never,
      getMetadata: () => createTestMetadata({ permissionMode: 'default' }),
      getStoredContentCryptoContext: () => ({ mode: 'plain' as const, ctx: null }),
      getPendingQueueState: () => ({ known: true as const, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 }),
      applyPendingQueueState: vi.fn(() => true),
      deliverMaterializedUserMessageToAgentQueue: deliver,
      handleSessionScopedUpdate,
    } as any);

    await expect(api.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toEqual({
      type: 'no_pending',
    });

    expect(socketAckMock).toHaveBeenNthCalledWith(2, 'session-pending-admission-settlement-v1', expect.objectContaining({
      decision: expect.objectContaining({
        kind: 'reject',
        code: 'session_input_untrusted_assertion',
      }),
    }));
    expect(handleSessionScopedUpdate).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('treats user-scoped socket connect as a best-effort snapshot wake boundary', async () => {
    const userSocket = createSocketStub();
    userSocket.connected = false;
    const syncSessionSnapshotFromServer = vi.fn(async () => true);
    const api = createApi({
      getUserSocket: () => userSocket as never,
      getMetadataVersion: () => 0,
      getAgentStateVersion: () => 0,
      getPendingWakeSeq: () => 0,
      syncSessionSnapshotFromServer,
    });

    const waitPromise = api.waitForMetadataUpdate();
    userSocket.connected = true;
    userSocket.trigger('connect');
    await expect(waitPromise).resolves.toBe(true);

    expect(syncSessionSnapshotFromServer).toHaveBeenCalledWith({ reason: 'waitForMetadataUpdate' });
  });

  it('does not force a direct metadata-wait detail refresh when only agent state is unknown', async () => {
    const syncSessionSnapshotFromServer = vi.fn(async () => true);
    const api = createApi({
      getMetadataVersion: () => 2,
      getAgentStateVersion: () => -1,
      syncSessionSnapshotFromServer,
    });

    const abortController = new AbortController();
    const waitPromise = api.waitForMetadataUpdate(abortController.signal);
    await Promise.resolve();
    abortController.abort();
    await expect(waitPromise).resolves.toBe(false);

    expect(syncSessionSnapshotFromServer).not.toHaveBeenCalled();
  });

  it('does not force a direct metadata-wait detail refresh when metadata is still unknown', async () => {
    const syncSessionSnapshotFromServer = vi.fn(async () => true);
    const api = createApi({
      getMetadataVersion: () => -1,
      getAgentStateVersion: () => -1,
      syncSessionSnapshotFromServer,
    });

    const abortController = new AbortController();
    const waitPromise = api.waitForMetadataUpdate(abortController.signal);
    await Promise.resolve();
    abortController.abort();
    await expect(waitPromise).resolves.toBe(false);

    expect(syncSessionSnapshotFromServer).not.toHaveBeenCalled();
  });

  it('replays pending materialization debt after the provider-input consumer attaches', () => {
    let hasPendingDebt = false;
    const calls: string[] = [];
    const api = createApi({
      setProviderInputConsumer: vi.fn(() => {
        calls.push('consumer-attached');
      }),
      shouldAttemptPendingMaterialization: () => hasPendingDebt,
      wakePendingMaterialization: vi.fn(() => {
        calls.push('pending-wake');
      }),
    });

    hasPendingDebt = true;
    expect(calls).toEqual([]);

    api.onUserMessage(vi.fn());

    expect(calls).toEqual(['consumer-attached', 'pending-wake']);
  });

  it('catches up once when input attaches and schedules no timed rereads after success', async () => {
    vi.useFakeTimers();
    let startupStarted = false;
    axiosGetMock.mockResolvedValue({ status: 200, data: { messages: [] } });
    const recovery = createSessionClientRecoveryRuntime({
      mode: 'plain', ctx: null, token: 'token-1', sessionId: 's1',
      getClosed: () => false,
      getSessionConnectionSupervisor: () => null,
      getLastObservedMessageSeq: () => 0,
      handleUpdate: () => {},
      syncSessionSnapshotFromServer: async () => true,
      applyPendingQueueState: () => {},
    });
    const api = createApi({
      catchUpSessionMessages: request => recovery.catchUpSessionMessages(request),
      getStartupMessageCatchUpStarted: () => startupStarted,
      setStartupMessageCatchUpStarted: (value) => {
        startupStarted = value;
      },
    });
    try {
      api.onUserMessage(() => {});
      await vi.advanceTimersByTimeAsync(0);
      api.onUserMessage(() => {});
      await vi.advanceTimersByTimeAsync(0);
      // Exercise any scheduled reread without treating unrelated log-file
      // flushes or completed transport deadlines as Session recovery work.
      await vi.runOnlyPendingTimersAsync();

      expect(axiosGetMock.mock.calls.map(([url]) => new URL(String(url)).pathname))
        .toEqual(['/v1/sessions/s1/messages']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks startup catch-up as explicit when the attach payload provides an afterSeq cursor', async () => {
    let startupStarted = false;
    const catchUpSessionMessages = vi.fn(async () => {});
    const api = createApi({
      catchUpSessionMessages,
      getLastObservedMessageSeq: () => 99,
      getStartupMessageCatchUpExplicitAfterSeq: () => 36,
      getStartupMessageCatchUpStarted: () => startupStarted,
      setStartupMessageCatchUpStarted: (value) => {
        startupStarted = value;
      },
    });

    api.onUserMessage(vi.fn());

    expect(catchUpSessionMessages).toHaveBeenCalledWith({
      afterSeq: 36,
    });
  });

  it('does not force a detail refresh for metadata-wait best effort when local versions are known', async () => {
    const syncSessionSnapshotFromServer = vi.fn(async () => true);
    const api = createApi({
      getMetadata: () => createTestMetadata({ flavor: 'claude' }),
      getMetadataVersion: () => 2,
      getAgentStateVersion: () => 1,
      syncSessionSnapshotFromServer,
    });

    await api.refreshSessionSnapshotFromServerBestEffort({ reason: 'waitForMetadataUpdate' });

    expect(syncSessionSnapshotFromServer).not.toHaveBeenCalled();
  });

  it('does not force a metadata-wait detail refresh when authoritative local versions are known before metadata is populated', async () => {
    const syncSessionSnapshotFromServer = vi.fn(async () => true);
    const api = createApi({
      getMetadata: () => null,
      getMetadataVersion: () => 2,
      getAgentStateVersion: () => 1,
      syncSessionSnapshotFromServer,
    });

    await api.refreshSessionSnapshotFromServerBestEffort({ reason: 'waitForMetadataUpdate' });

    expect(syncSessionSnapshotFromServer).not.toHaveBeenCalled();
  });

  it('does not force a metadata-wait detail refresh when only the local metadata version is authoritative', async () => {
    const syncSessionSnapshotFromServer = vi.fn(async () => true);
    const api = createApi({
      getMetadata: () => null,
      getMetadataVersion: () => 2,
      getAgentStateVersion: () => -1,
      syncSessionSnapshotFromServer,
    });

    await api.refreshSessionSnapshotFromServerBestEffort({ reason: 'waitForMetadataUpdate' });

    expect(syncSessionSnapshotFromServer).not.toHaveBeenCalled();
  });

  it('forces an observable authoritative refresh even when local metadata is already populated', async () => {
    const syncSessionSnapshotFromServer = vi.fn(async () => true);
    const api = createApi({
      getMetadata: () => createTestMetadata({ flavor: 'claude' }),
      getMetadataVersion: () => 2,
      getAgentStateVersion: () => 1,
      syncSessionSnapshotFromServer,
    });

    await expect(
      api.refreshSessionSnapshotFromServerRequired({
        reason: 'startup-drain',
      }),
    ).resolves.toBeUndefined();

    expect(syncSessionSnapshotFromServer).toHaveBeenCalledWith({
      reason: 'startup-drain',
    });
  });

  it('rejects a required authoritative refresh when the canonical sync cannot apply a snapshot', async () => {
    const syncSessionSnapshotFromServer = vi.fn(async () => false);
    const api = createApi({ syncSessionSnapshotFromServer });

    await expect(
      api.refreshSessionSnapshotFromServerRequired({
        reason: 'startup-drain',
      }),
    ).rejects.toThrow(/authoritative session snapshot/i);
  });
});
