import {
  FeaturesResponseSchema,
  HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1,
  buildBackendTargetKeyV2,
} from '@happier-dev/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseReleasedServerV021Features } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import type { Encryption } from '@/sync/encryption/encryption';
import { settingsParse } from '@/sync/domains/settings/settings';
import type { Session } from '@/sync/domains/state/storageTypes';
import { saveAccountSettings } from '@/sync/domains/state/accountSettingsPersistence';
import { loadPendingOutboxForSession } from '@/sync/domains/state/pendingOutboxPersistence';
import { buildSession, resetPendingQueueState } from '@/sync/engine/pending/pendingQueueV2.testHelpers';
import { createServerScopedSessionSendMessage } from './serverScopedSessionSendMessage';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import '@/sync/syncEngine';
import { sync } from '@/sync/sync';
import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES } from '@happier-dev/agents/agent-ids';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

const serverFeaturesSnapshotMock = vi.hoisted(() => vi.fn());
const runtimeFetchMock = vi.hoisted(() => vi.fn());
const resumeSessionMock = vi.hoisted(() => vi.fn());
const kvStore = vi.hoisted(() => new Map<string, string>());

vi.mock('react-native-mmkv', () => {
  class MMKV {
    getString(key: string) {
      return kvStore.get(key);
    }
    set(key: string, value: string) {
      kvStore.set(key, value);
    }
    delete(key: string) {
      kvStore.delete(key);
    }
    getAllKeys() {
      return [...kvStore.keys()];
    }
    clearAll() {
      kvStore.clear();
    }
  }

  return { MMKV };
});

vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
  getServerFeaturesSnapshot: serverFeaturesSnapshotMock,
  getCachedServerFeaturesSnapshot: () => null,
}));

vi.mock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch', () => ({
  runtimeFetchWithServerReachability: runtimeFetchMock,
}));

vi.mock('@/sync/ops/sessions', () => ({
  resumeSession: resumeSessionMock,
}));

function createSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1', serverId: 'server-1', seq: 1, createdAt: 1, updatedAt: 1,
    active: true, activeAt: 1, pendingVersion: 2, pendingCount: 0,
    metadata: { machineId: 'm1', path: '/tmp/project', host: 'host', flavor: 'claude', version: '999.0.0' },
    metadataVersion: 1, agentState: null, agentStateVersion: 1,
    thinking: false, thinkingAt: 0, presence: 1, optimisticThinkingAt: null,
    ...overrides,
  };
}

type ScopedAccountEncryptionStub = Readonly<{
  decryptEncryptionKey: (value: string) => Promise<Uint8Array | null>;
  initializeSessions: (keys: Map<string, Uint8Array | null>, scope?: unknown) => Promise<void>;
  getSessionEncryption: (sessionId: string) => unknown;
}>;

/**
 * Account encryption is a real system boundary (Account key material and the crypto worker), and
 * the scoped send path consumes exactly these three methods. Each case stubs that boundary; this
 * helper is the single place that presents the stub as the `Encryption` the request context
 * carries, so no case restates a class it never calls. A method the path starts using that the
 * stub does not carry fails the case loudly rather than silently.
 */
function scopedAccountEncryptionStub(stub?: Partial<ScopedAccountEncryptionStub>): Encryption {
  return {
    decryptEncryptionKey: async () => null,
    initializeSessions: async () => {},
    getSessionEncryption: () => null,
    ...stub,
  } as unknown as Encryption;
}

function composerAttachmentOnlyMeta(): Record<string, unknown> {
  return {
    [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: {
      v: 1,
      composerAttachments: [{
        v: 1,
        instanceId: 'attachment-instance-1',
        attachment: {
          pluginId: 'com.acme.review',
          localId: 'review',
        },
        key: 'review-42',
        value: { reviewId: '42' },
        presentation: { label: 'Review #42', typeLabel: 'Review comment' },
        // The real Composer shape: a draft whose media is still the
        // transfer-owned staged claim. Only the daemon's SessionMedia
        // finalizer may replace it, so the admitted-only projection cannot
        // hold this record and must not decide whether the turn is empty.
        content: {
          kind: 'stagedMedia',
          handle: {
            v: 1,
            id: 'staged-content-42',
            executionTarget: { serverId: 'server-1', machineId: 'm1' },
            owner: { pluginId: 'com.acme.review', localId: 'review' },
            mediaKind: 'image',
            mimeType: 'image/png',
            name: 'review-42.png',
            sizeBytes: 2048,
            sha256: 'a'.repeat(64),
          },
        },
      }],
    },
  };
}

describe('sendSessionMessageWithServerScope', () => {
  it.each(['sender', 'voice_handler', 'cancelled_voice_handler'] as const)('uses the exact remote Session and Voice origin when the active Home has an encrypted duplicate id through %s', async (entryPoint) => {
    const active = await upsertServerProfile({ serverUrl: 'https://active-send.example.test', name: 'Active' });
    const remote = await upsertServerProfile({ serverUrl: 'https://remote-send.example.test', name: 'Remote' });
    await setActiveServerId(active.id, { scope: 'device' });
    // `claudeRemoteMaxThinkingTokens` is a plugin-contributed Agent setting (its producer is
    // `packages/plugins/claude`), so it enters the settings bag through the canonical parser
    // rather than as an ad-hoc literal property.
    storage.setState((state) => ({ settings: settingsParse({
      ...state.settings,
      claudeRemoteMaxThinkingTokens: 777,
      experiments: true,
      featureToggles: { ...state.settings.featureToggles, voice: true },
    }) }));
    const token = `e30.${btoa(JSON.stringify({ sub: 'remote-account' })).replaceAll('=', '')}.signature`;
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
    storage.getState().applySessions([createSession({ id: 'same', serverId: active.id, encryptionMode: 'e2ee', modelMode: 'active-private-model' })]);
    const activeSession = storage.getState().sessions.same;
    serverFeaturesSnapshotMock.mockResolvedValue({
      status: 'ready', features: FeaturesResponseSchema.parse({ features: {}, capabilities: { session: { pendingInput: { protocolVersion: 1 } } } }),
    });
    saveAccountSettings({ serverId: remote.id, accountId: 'remote-account' }, settingsParse({
      ...storage.getState().settings, claudeRemoteMaxThinkingTokens: 1337,
    }), 1);
    const cancellation = new AbortController();
    const writes: Array<Readonly<{ url: string; body: Record<string, unknown> }>> = [];
    runtimeFetchMock.mockImplementation(async (request: Readonly<{ url: string; init?: RequestInit }>) => {
      if (request.init?.method === 'GET' && request.url.endsWith('/v1/account/encryption')) {
        return Response.json({ mode: 'plain', updatedAt: 1 });
      }
      if (request.init?.method === 'GET' && request.url.endsWith('/v2/account/settings')) {
        return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
      }
      if (request.init?.method === 'GET' && request.url.endsWith('/v2/sessions/same')) {
        if (entryPoint === 'cancelled_voice_handler') cancellation.abort();
        return Response.json({ session: {
          id: 'same', seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
          encryptionMode: 'plain', dataEncryptionKey: null,
          metadataVersion: 1, metadata: JSON.stringify({
            path: '/remote', host: 'remote', flavor: 'claude',
            permissionMode: 'yolo', permissionModeUpdatedAt: 10,
            modelSelectionIntentV1: { v: 1, updatedAt: 10, selection: {
              agentTargetKey: buildBackendTargetKeyV2({ kind: 'agent', identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.claude }), providerConnectionId: 'pc_01J00000000000000000000000', modelId: 'provider/claude-sonnet',
            } },
          }),
          agentStateVersion: 1, agentState: null, share: null,
        } });
      }
      if (request.init?.method === 'POST') {
        const body = JSON.parse(String(request.init.body)) as Record<string, unknown>;
        writes.push({ url: request.url, body });
        return Response.json({ requestedAction: body.requestedAction, pending: { localId: body.localId } });
      }
      throw new Error(`Unexpected network request: ${request.init?.method} ${request.url}`);
    });
    // Voice enters through the Account-qualified Action owner before it reaches
    // the same scoped Pending sender. That owner uses the canonical runtimeFetch
    // boundary directly for settings/encryption reads, while the sender uses the
    // reachability wrapper mocked above. Feed both transport adapters into this
    // one external-network fixture so the test still exercises the real Action
    // policy and exact-Home send path.
    setRuntimeFetch(async (input, init) => await runtimeFetchMock({ url: String(input), init }));
    const { sendSessionMessageWithServerScope } = createServerScopedSessionSendMessage({
      markSessionLiveTailIntent: (sessionId) => sync.markSessionLiveTailIntent(sessionId),
      schedulePendingOutboxRetry: (params) => sync.schedulePendingOutboxOperationRetry(params),
      enqueuePendingMessageActive: (...args) => sync.enqueuePendingMessage(...args),
    });
    const result = entryPoint !== 'sender'
      ? (await import('@/voice/tools/handlers')).createVoiceToolHandlers({
        resolveSessionId: () => 'same', currentSessionAddress: { serverId: remote.id, sessionId: 'same' },
      }).sendSessionMessage({ message: 'Remote Voice input' }, { signal: cancellation.signal }).then((value) => JSON.parse(value))
      : sendSessionMessageWithServerScope({
      sessionId: 'same', serverId: remote.id, message: 'Remote Voice input', messageLocalId: 'qualified-voice-input',
      requestedAction: { v: 1, kind: 'send_now' }, hostAdmissionOrigin: 'voice',
    });
    const outcome = await result;
    if (entryPoint === 'cancelled_voice_handler') {
      expect(outcome).toMatchObject({ ok: false, errorCode: 'tool_cancelled' });
      expect(writes).toEqual([]);
      expect(storage.getState().sessions.same).toEqual(activeSession);
      expect(await loadPendingOutboxForSession('same', { serverId: remote.id, accountId: 'remote-account' })).toEqual([]);
      return;
    }
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.url).toContain('https://remote-send.example.test/');
    expect(writes[0]?.body).toMatchObject({ content: { t: 'plain', v: { meta: {
      happierProvenanceV1: { v: 1, kind: 'voice' },
      happierInputRequestV1: { v: 1, producer: 'voiceInput' },
      permissionMode: 'yolo',
      claudeRemoteMaxThinkingTokens: 1337,
    } } } });
    expect(JSON.stringify(writes)).not.toContain('active-private-model');
    expect(JSON.stringify(writes)).toContain('provider/claude-sonnet');
    expect(storage.getState().sessions.same).toEqual(activeSession);
  });
  beforeEach(async () => {
    await resetPendingQueueState();
    kvStore.clear();
    serverFeaturesSnapshotMock.mockReset();
    runtimeFetchMock.mockReset();
    resumeSessionMock.mockReset();
  });

  afterEach(() => {
    resetRuntimeFetch();
    vi.restoreAllMocks();
  });

  function plainScopedSessionResponse(): Response {
    return Response.json({ session: {
      id: 's1', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
      encryptionMode: 'plain', dataEncryptionKey: null,
      metadataVersion: 1, metadata: JSON.stringify({ machineId: 'remote-machine', path: '/remote', host: 'remote', flavor: 'claude' }),
      agentStateVersion: 1, agentState: null, share: null,
    } });
  }

  it('writes active ordinary input with an explicit enqueue action', async () => {
    const enqueuePendingMessageActive = vi.fn(async () => ({ localId: 'local-1', accepted: true }));
    const { sendSessionMessageWithServerScope } = createServerScopedSessionSendMessage({
      getSession: () => createSession(),
      resolveContext: vi.fn(async () => ({ scope: 'active' as const, timeoutMs: 1_000 })),
      enqueuePendingMessageActive,
    });

    await expect(sendSessionMessageWithServerScope({
      sessionId: 's1', message: 'hello', messageLocalId: 'local-1',
    })).resolves.toMatchObject({ ok: true, ack: { localId: 'local-1', persistence: 'pending', accepted: true } });

    expect(enqueuePendingMessageActive).toHaveBeenCalledWith(
      's1', 'hello', undefined, undefined,
      { localId: 'local-1', requestedAction: { v: 1, kind: 'enqueue' } },
    );
  });

  it('uses the fetched exact-Home Session machine for a scoped Run Pending mutation', async () => {
    serverFeaturesSnapshotMock.mockResolvedValue({
      status: 'ready',
      features: FeaturesResponseSchema.parse({
        features: {},
        capabilities: { session: { pendingInput: { protocolVersion: 3 } } },
      }),
    });
    runtimeFetchMock.mockImplementation(async (request: Readonly<{ init?: RequestInit }>) => {
      if (request.init?.method === 'GET') return plainScopedSessionResponse();
      const body = JSON.parse(String(request.init?.body ?? 'null')) as Record<string, unknown>;
      return Response.json({ requestedAction: body.requestedAction, pending: { localId: body.localId } });
    });
    const { sendSessionMessageWithServerScope } = createServerScopedSessionSendMessage({
      schedulePendingOutboxRetry: vi.fn(),
      resolveContext: vi.fn(async () => ({
        scope: 'scoped' as const,
        timeoutMs: 1_000,
        targetServerId: 'server-remote',
        targetServerUrl: 'https://remote.example.test',
        targetAccountId: 'account-remote',
        token: 'token-remote',
        credentials: { token: 'token-remote' },
        encryption: scopedAccountEncryptionStub(),
      })),
    });
    const recipient = { kind: 'execution_run' as const, runId: 'run-remote' };

    await expect(sendSessionMessageWithServerScope({
      sessionId: 's1', serverId: 'server-remote', message: 'continue remote Run',
      messageLocalId: 'run-remote-local', recipient,
    })).resolves.toMatchObject({ ok: true });

    const write = runtimeFetchMock.mock.calls.find(([request]) => request.init?.method === 'POST')?.[0];
    expect(write?.url).toContain('/v2/sessions/s1/execution-runs/run-remote/pending');
    expect(JSON.parse(String(write?.init?.body ?? 'null'))).toMatchObject({
      localId: 'run-remote-local', targetMachineId: 'remote-machine', requestedAction: { v: 1, kind: 'enqueue' },
    });
  });

  it('keeps the exact Run recipient on the active Home Pending mutation', async () => {
    const enqueuePendingMessageActive = vi.fn(async () => ({ localId: 'run-local-1', accepted: true }));
    const { sendSessionMessageWithServerScope } = createServerScopedSessionSendMessage({
      getSession: () => createSession({ serverId: 'server-exact' }),
      resolveContext: vi.fn(async () => ({ scope: 'active' as const, timeoutMs: 1_000 })),
      enqueuePendingMessageActive,
    });
    const recipient = { kind: 'execution_run' as const, runId: 'run-1' };

    await expect(sendSessionMessageWithServerScope({
      sessionId: 's1',
      serverId: 'server-exact',
      message: 'continue',
      messageLocalId: 'run-local-1',
      recipient,
    })).resolves.toMatchObject({ ok: true });

    expect(enqueuePendingMessageActive).toHaveBeenCalledWith(
      's1', 'continue', undefined, undefined,
      { localId: 'run-local-1', recipient, requestedAction: { v: 1, kind: 'enqueue' } },
    );
  });

  it('projects a canonical Pending admission rejection instead of throwing through the Action boundary', async () => {
    const enqueuePendingMessageActive = vi.fn(async () => {
      throw Object.assign(new Error('target unavailable'), { code: 'session_input_target_unavailable' });
    });
    const { sendSessionMessageWithServerScope } = createServerScopedSessionSendMessage({
      getSession: () => createSession({ serverId: 'server-exact' }),
      resolveContext: vi.fn(async () => ({ scope: 'active' as const, timeoutMs: 1_000 })),
      enqueuePendingMessageActive,
    });

    await expect(sendSessionMessageWithServerScope({
      sessionId: 's1', serverId: 'server-exact', message: 'continue',
      messageLocalId: 'run-rejected', recipient: { kind: 'execution_run', runId: 'run-1' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'session_input_target_unavailable',
      error: 'session_input_target_unavailable',
    });
  });

  it('admits an attachment-only active first turn with the stable local id', async () => {
    const enqueuePendingMessageActive = vi.fn(async () => ({ localId: 'attachment-only-1', accepted: true }));
    serverFeaturesSnapshotMock.mockResolvedValue({
      status: 'ready',
      features: parseReleasedServerV021Features(),
    });
    const { sendSessionMessageWithServerScope } = createServerScopedSessionSendMessage({
      getSession: () => createSession(),
      resolveContext: vi.fn(async () => ({ scope: 'active' as const, timeoutMs: 1_000 })),
      enqueuePendingMessageActive,
    });
    const metaOverrides = composerAttachmentOnlyMeta();

    await expect(sendSessionMessageWithServerScope({
      sessionId: 's1',
      message: '',
      metaOverrides,
      messageLocalId: 'attachment-only-1',
      providerDeliveryIntent: 'first_turn',
    })).resolves.toMatchObject({
      ok: true,
      ack: { localId: 'attachment-only-1', persistence: 'pending', accepted: true },
    });

    expect(enqueuePendingMessageActive).toHaveBeenCalledWith(
      's1',
      '',
      undefined,
      metaOverrides,
      { localId: 'attachment-only-1', requestedAction: { v: 1, kind: 'enqueue' } },
    );
  });

  it('keeps blank input without an approved composer attachment rejected', async () => {
    const enqueuePendingMessageActive = vi.fn(async () => ({ localId: 'must-not-send', accepted: true }));
    const { sendSessionMessageWithServerScope } = createServerScopedSessionSendMessage({
      getSession: () => createSession(),
      resolveContext: vi.fn(async () => ({ scope: 'active' as const, timeoutMs: 1_000 })),
      enqueuePendingMessageActive,
    });

    await expect(sendSessionMessageWithServerScope({
      sessionId: 's1',
      message: '   ',
      metaOverrides: { arbitrary: 'metadata-is-not-input' },
      messageLocalId: 'must-not-send',
      providerDeliveryIntent: 'first_turn',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });

    expect(enqueuePendingMessageActive).not.toHaveBeenCalled();
  });

  it('keeps blank input with a malformed composer attachment selection rejected', async () => {
    const enqueuePendingMessageActive = vi.fn(async () => ({ localId: 'must-not-send-malformed', accepted: true }));
    const { sendSessionMessageWithServerScope } = createServerScopedSessionSendMessage({
      getSession: () => createSession(),
      resolveContext: vi.fn(async () => ({ scope: 'active' as const, timeoutMs: 1_000 })),
      enqueuePendingMessageActive,
    });

    await expect(sendSessionMessageWithServerScope({
      sessionId: 's1',
      message: '',
      metaOverrides: {
        [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: {
          v: 1,
          composerAttachments: [{ malformed: true }],
        },
      },
      messageLocalId: 'must-not-send-malformed',
      providerDeliveryIntent: 'first_turn',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });

    expect(enqueuePendingMessageActive).not.toHaveBeenCalled();
  });

  it('preserves an explicit settings-aware action intent from the Action surface', async () => {
    const enqueuePendingMessageActive = vi.fn(async () => ({ localId: 'action-1', accepted: true }));
    const { sendSessionMessageWithServerScope } = createServerScopedSessionSendMessage({
      getSession: () => createSession(),
      resolveContext: vi.fn(async () => ({ scope: 'active' as const, timeoutMs: 1_000 })),
      enqueuePendingMessageActive,
    });

    await sendSessionMessageWithServerScope({
      sessionId: 's1',
      message: 'continue',
      messageLocalId: 'action-1',
      requestedAction: { v: 1, kind: 'steer_if_active' },
    });

    expect(enqueuePendingMessageActive).toHaveBeenCalledWith(
      's1', 'continue', undefined, undefined,
      { localId: 'action-1', requestedAction: { v: 1, kind: 'steer_if_active' } },
    );
  });

  it('leaves an inactive first-turn wake to the durable Pending activation owner', async () => {
    const enqueuePendingMessageActive = vi.fn(async () => ({ localId: 'wake-1', accepted: true }));
    const session = createSession({ active: false, presence: 0 });
    serverFeaturesSnapshotMock.mockResolvedValue({
      status: 'ready',
      features: FeaturesResponseSchema.parse({
        features: {},
        capabilities: {
          session: {
            pendingInput: { protocolVersion: 1 },
          },
        },
      }),
    });
    const { sendSessionMessageWithServerScope } = createServerScopedSessionSendMessage({
      getSession: () => session,
      resolveContext: vi.fn(async () => ({ scope: 'active' as const, timeoutMs: 1_000 })),
      enqueuePendingMessageActive,
    });

    await sendSessionMessageWithServerScope({
      sessionId: 's1', message: 'wake now', messageLocalId: 'wake-1', providerDeliveryIntent: 'first_turn',
    });

    expect(enqueuePendingMessageActive).toHaveBeenCalledWith(
      's1', 'wake now', undefined, undefined,
      { localId: 'wake-1', requestedAction: { v: 1, kind: 'send_now' } },
    );
    expect(serverFeaturesSnapshotMock).toHaveBeenCalledWith({ serverId: 'server-1' });
    expect(resumeSessionMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'current Pending contract',
      snapshot: {
        status: 'ready' as const,
        features: FeaturesResponseSchema.parse({
          features: {},
          capabilities: {
            session: {
              pendingInput: { protocolVersion: 1 },
            },
          },
        }),
      },
      expectedAction: 'send_now',
    },
    {
      name: 'released server',
      snapshot: {
        status: 'ready' as const,
        features: parseReleasedServerV021Features(),
      },
      expectedAction: 'enqueue',
    },
    {
      name: 'indeterminate server contract',
      snapshot: { status: 'error' as const, reason: 'network' as const },
      expectedAction: 'enqueue',
    },
  ])('maps active first-turn input for the $name', async ({ snapshot, expectedAction }) => {
    serverFeaturesSnapshotMock.mockResolvedValue(snapshot);
    const enqueuePendingMessageActive = vi.fn(async () => ({ localId: 'active-first-turn', accepted: true }));
    const { sendSessionMessageWithServerScope } = createServerScopedSessionSendMessage({
      getSession: () => createSession(),
      resolveContext: vi.fn(async () => ({ scope: 'active' as const, timeoutMs: 1_000 })),
      enqueuePendingMessageActive,
    });

    await expect(sendSessionMessageWithServerScope({
      sessionId: 's1',
      message: 'first prompt',
      messageLocalId: 'active-first-turn',
      providerDeliveryIntent: 'first_turn',
    })).resolves.toMatchObject({ ok: true, ack: { localId: 'active-first-turn', accepted: true } });

    expect(enqueuePendingMessageActive).toHaveBeenCalledWith(
      's1',
      'first prompt',
      undefined,
      undefined,
      { localId: 'active-first-turn', requestedAction: { v: 1, kind: expectedAction } },
    );
    expect(serverFeaturesSnapshotMock).toHaveBeenCalledWith({ serverId: 'server-1' });
  });

  it.each([
    {
      name: 'released server first turn',
      features: parseReleasedServerV021Features(),
      expectedBody: {
        localId: 'first-turn-1',
        content: expect.objectContaining({ t: 'plain' }),
      },
      released: true,
    },
    {
      name: 'current server first turn',
      features: FeaturesResponseSchema.parse({
        features: {},
        capabilities: {
          session: {
            pendingInput: { protocolVersion: 1 },
          },
        },
      }),
      expectedBody: expect.objectContaining({
        localId: 'first-turn-1',
        requestedAction: { v: 1, kind: 'send_now' },
      }),
      released: false,
    },
  ])('serializes $name through its selected wire contract', async ({ features, expectedBody, released }) => {
    const session = buildSession({
      sessionId: 's1',
      overrides: { serverId: 'server-1', encryptionMode: 'plain' },
    });
    storage.getState().applySessions([session]);
    serverFeaturesSnapshotMock.mockResolvedValue({ status: 'ready', features });
    runtimeFetchMock.mockImplementation(async (request: Readonly<{ init?: RequestInit }>) => {
      if (request.init?.method === 'GET') return plainScopedSessionResponse();
      const body = JSON.parse(String(request.init?.body ?? 'null')) as Record<string, unknown>;
      if (!released) {
        return Response.json({ requestedAction: body.requestedAction, pending: { localId: body.localId } });
      }
      return Response.json({
        didWrite: true,
        pending: {
          localId: body.localId,
          content: body.content,
          status: 'queued',
          position: 0,
          createdAt: 1,
          updatedAt: 1,
          discardedAt: null,
          discardedReason: null,
          authorAccountId: 'account-1',
        },
        pendingCount: 1,
        pendingVersion: 1,
      });
    });
    const { sendSessionMessageWithServerScope } = createServerScopedSessionSendMessage({
      schedulePendingOutboxRetry: vi.fn(),
      markSessionLiveTailIntent: vi.fn(),
      resolveContext: vi.fn(async () => ({
        scope: 'scoped' as const,
        timeoutMs: 1_000,
        targetServerId: 'server-1',
        targetServerUrl: 'https://server.example.test',
        targetAccountId: 'account-1',
        token: 'token-1',
        credentials: { token: 'token-1' },
        encryption: scopedAccountEncryptionStub(),
      })),
    });

    await expect(sendSessionMessageWithServerScope({
      sessionId: 's1',
      serverId: 'server-1',
      message: 'first prompt',
      messageLocalId: 'first-turn-1',
      providerDeliveryIntent: 'first_turn',
    })).resolves.toMatchObject({ ok: true, ack: { localId: 'first-turn-1', accepted: true } });

    const writes = runtimeFetchMock.mock.calls.filter(([request]) => request.init?.method === 'POST');
    expect(writes).toHaveLength(1);
    const request = writes[0]?.[0] as Readonly<{ init?: RequestInit }>;
    const body = JSON.parse(String(request.init?.body ?? 'null')) as Record<string, unknown>;
    expect(body).toEqual(expectedBody);
    if (released) {
      expect(body).not.toHaveProperty('requestedAction');
    }
  });

  it('loads scoped E2EE material and sends through the selected semantic Home carrier', async () => {
    const session = buildSession({
      sessionId: 's1',
      overrides: { serverId: 'server-1', encryptionMode: 'e2ee' },
    });
    storage.getState().applySessions([session]);
    serverFeaturesSnapshotMock.mockResolvedValue({
      status: 'ready',
      features: FeaturesResponseSchema.parse({
        features: {},
        capabilities: { session: { pendingInput: { protocolVersion: 1 } } },
      }),
    });
    const carrierRequest = vi.fn(async (url: string, init: RequestInit) => {
      if (url === 'http://127.0.0.1:3010/v2/sessions/s1') {
        return Response.json({
          session: {
            id: 's1',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            archivedAt: null,
            metadata: 'metadata',
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            pendingCount: 0,
            pendingVersion: 0,
            encryptionMode: 'e2ee',
            dataEncryptionKey: 'sealed-session-key',
          },
        });
      }
      const body = JSON.parse(String(init.body ?? 'null')) as { localId?: string; requestedAction?: unknown };
      return Response.json({ requestedAction: body.requestedAction, pending: { localId: body.localId } });
    });
    const release = vi.fn(async () => {});
    const sessionEncryption = {
      encryptRawRecord: vi.fn(async () => 'encrypted-record'),
      decryptMetadata: async () => ({ path: '/remote', host: 'remote', flavor: 'claude' }),
      decryptAgentState: async () => null,
    };
    const encryption = {
      decryptEncryptionKey: vi.fn(async () => new Uint8Array(32).fill(4)),
      initializeSessions: vi.fn(async () => {}),
      getSessionEncryption: vi.fn(() => sessionEncryption),
    };
    const { sendSessionMessageWithServerScope } = createServerScopedSessionSendMessage({
      schedulePendingOutboxRetry: vi.fn(),
      markSessionLiveTailIntent: vi.fn(),
      resolveContext: vi.fn(async () => ({
        scope: 'scoped' as const,
        timeoutMs: 1_000,
        targetServerId: 'server-1',
        targetServerUrl: 'http://127.0.0.1:3010',
        targetAccountId: 'account-1',
        carrier: 'iroh' as const,
        homeCarrier: {
          endpointId: 'home-endpoint',
          readObservedPath: () => 'relay' as const,
          request: carrierRequest,
          createWebSocket: vi.fn(),
        },
        token: 'token-1',
        credentials: { token: 'token-1' },
        encryption: scopedAccountEncryptionStub(encryption),
        release,
      })),
    });

    await expect(sendSessionMessageWithServerScope({
      sessionId: 's1',
      serverId: 'server-1',
      message: 'through Home B',
      messageLocalId: 'iroh-message-1',
      providerDeliveryIntent: 'first_turn',
    })).resolves.toMatchObject({ ok: true });

    expect(carrierRequest.mock.calls.some(([url]) => url === 'http://127.0.0.1:3010/v2/sessions/s1')).toBe(true);
    expect(carrierRequest.mock.calls.some(([url, init]) =>
      url.startsWith('http://127.0.0.1:3010/') && init.method === 'POST',
    )).toBe(true);
    expect(runtimeFetchMock).not.toHaveBeenCalled();
    expect(encryption.initializeSessions).toHaveBeenCalledWith(
      new Map([['s1', new Uint8Array(32).fill(4)]]),
      { serverId: 'server-1', shouldContinue: expect.any(Function) },
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('never seals scoped input for a recipient Session without its own envelope using the Account-secret reader', async () => {
    const session = buildSession({
      sessionId: 's1',
      overrides: { serverId: 'server-1', encryptionMode: 'e2ee' },
    });
    storage.getState().applySessions([session]);
    serverFeaturesSnapshotMock.mockResolvedValue({
      status: 'ready',
      features: FeaturesResponseSchema.parse({
        features: {},
        capabilities: { session: { pendingInput: { protocolVersion: 1 } } },
      }),
    });
    const accountSecret = new Uint8Array(32).fill(21);
    const { Encryption: RealEncryption } = await vi.importActual<typeof import('@/sync/encryption/encryption')>(
      '@/sync/encryption/encryption',
    );
    const encryption = await RealEncryption.create(accountSecret);
    const request = vi.fn(async (url: string, init: RequestInit) => {
      if (url === 'http://127.0.0.1:3010/v2/sessions/s1') {
        return Response.json({
          session: {
            id: 's1', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1, archivedAt: null,
            metadata: 'metadata', metadataVersion: 1, agentState: null, agentStateVersion: 0,
            pendingCount: 0, pendingVersion: 0, encryptionMode: 'e2ee',
            // Shared with this Account, whose recipient envelope has not been written yet.
            share: { accessLevel: 'edit', canApprovePermissions: false },
            dataEncryptionKey: null,
          },
        });
      }
      if (url === 'http://127.0.0.1:3010/v1/account/encryption/currentness') {
        return Response.json({
          mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing', contentKeyFingerprint: 'content',
          updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' },
        });
      }
      const body = JSON.parse(String(init.body ?? 'null')) as { localId?: string; requestedAction?: unknown };
      return Response.json({ requestedAction: body.requestedAction, pending: { localId: body.localId } });
    });
    const { sendSessionMessageWithServerScope } = createServerScopedSessionSendMessage({
      schedulePendingOutboxRetry: vi.fn(),
      markSessionLiveTailIntent: vi.fn(),
      resolveContext: vi.fn(async () => ({
        scope: 'scoped' as const,
        timeoutMs: 1_000,
        targetServerId: 'server-1',
        targetServerUrl: 'http://127.0.0.1:3010',
        targetAccountId: 'account-1',
        carrier: 'iroh' as const,
        homeCarrier: {
          endpointId: 'home-endpoint',
          readObservedPath: () => 'relay' as const,
          request,
          createWebSocket: vi.fn(),
        },
        token: 'token-1',
        credentials: { token: 'token-1', secret: Buffer.from(accountSecret).toString('base64url') },
        encryption,
        release: vi.fn(async () => {}),
      })),
    });

    const outcome = await sendSessionMessageWithServerScope({
      sessionId: 's1',
      serverId: 'server-1',
      message: 'for the recipient Session',
      messageLocalId: 'recipient-message-1',
      providerDeliveryIntent: 'first_turn',
    }).then((value) => value, (error: unknown) => ({ ok: false as const, thrown: error }));

    expect(outcome).toMatchObject({ ok: false });
    expect(request.mock.calls.some(([, init]) => init.method === 'POST')).toBe(false);
    expect(encryption.getSessionEncryption('s1')).toBeNull();
  });

  it('preserves the active viewport and pending bag when sending to a different Home', async () => {
    const session = buildSession({
      sessionId: 's1',
      overrides: { serverId: 'server-1', encryptionMode: 'plain' },
    });
    storage.getState().applySessions([session]);
    const { sync } = await import('@/sync/syncEngine');
    sync.onSessionViewportChange('s1', {
      isPinned: false,
      offsetY: 420,
      shouldPersistViewport: false,
      shouldRestoreViewport: true,
      anchor: {
        kind: 'message',
        messageId: 'message-1',
        seq: 1,
        itemId: 'msg:message-1',
        itemOffsetPx: 12,
        capturedAtMs: 1_000,
      },
    });
    expect(sync.getSessionViewport('s1')).toMatchObject({
      isPinned: false,
      source: 'observed',
    });

    const activeViewport = sync.getSessionViewport('s1');
    serverFeaturesSnapshotMock.mockResolvedValue({
      status: 'ready',
      features: FeaturesResponseSchema.parse({
        features: {},
        capabilities: {
          session: {
            pendingInput: { protocolVersion: 1 },
          },
        },
      }),
    });
    runtimeFetchMock.mockImplementation(async (request: Readonly<{ init?: RequestInit }>) =>
      request.init?.method === 'GET' ? plainScopedSessionResponse() : Response.json({
        requestedAction: { v: 1, kind: 'send_now' },
        pending: { localId: 'scoped-cross-mount-first-turn' },
      }));
    const { sendSessionMessageWithServerScope } = createServerScopedSessionSendMessage({
      schedulePendingOutboxRetry: vi.fn(),
      markSessionLiveTailIntent: (sessionId) => sync.markSessionLiveTailIntent(sessionId),
      resolveContext: vi.fn(async () => ({
        scope: 'scoped' as const,
        timeoutMs: 1_000,
        targetServerId: 'server-1',
        targetServerUrl: 'https://server.example.test',
        targetAccountId: 'account-1',
        token: 'token-1',
        credentials: { token: 'token-1' },
        encryption: scopedAccountEncryptionStub(),
      })),
    });

    await expect(sendSessionMessageWithServerScope({
      sessionId: 's1',
      serverId: 'server-1',
      message: 'scoped first prompt',
      messageLocalId: 'scoped-cross-mount-first-turn',
      providerDeliveryIntent: 'first_turn',
    })).resolves.toMatchObject({ ok: true });

    expect(sync.getSessionViewport('s1')).toEqual(activeViewport);
    expect(storage.getState().sessionPending.s1?.messages ?? []).toEqual([]);
  });

  it('persists scoped first-turn custody as enqueue while the server wire mode is indeterminate', async () => {
    const session = buildSession({
      sessionId: 's1',
      overrides: { serverId: 'server-1', encryptionMode: 'plain' },
    });
    storage.getState().applySessions([session]);
    serverFeaturesSnapshotMock.mockResolvedValue({ status: 'error', reason: 'network' });
    runtimeFetchMock.mockImplementation(async (request: Readonly<{ init?: RequestInit }>) => {
      if (request.init?.method === 'GET') return plainScopedSessionResponse();
      throw new Error('Indeterminate Pending contract cannot submit input');
    });
    const schedulePendingOutboxRetry = vi.fn();
    const { sendSessionMessageWithServerScope } = createServerScopedSessionSendMessage({
      schedulePendingOutboxRetry,
      markSessionLiveTailIntent: vi.fn(),
      resolveContext: vi.fn(async () => ({
        scope: 'scoped' as const,
        timeoutMs: 1_000,
        targetServerId: 'server-1',
        targetServerUrl: 'https://server.example.test',
        targetAccountId: 'account-1',
        token: 'token-1',
        credentials: { token: 'token-1' },
        encryption: scopedAccountEncryptionStub(),
      })),
    });

    await expect(sendSessionMessageWithServerScope({
      sessionId: 's1',
      serverId: 'server-1',
      message: 'first prompt',
      messageLocalId: 'first-turn-indeterminate',
      providerDeliveryIntent: 'first_turn',
    })).resolves.toMatchObject({
      ok: true,
      ack: { localId: 'first-turn-indeterminate', accepted: false },
    });

    expect(runtimeFetchMock.mock.calls.filter(([request]) => request.init?.method === 'POST')).toEqual([]);
    expect(schedulePendingOutboxRetry).not.toHaveBeenCalled();
    const [outboxRow] = (await loadPendingOutboxForSession('s1', {
      serverId: 'server-1',
      accountId: 'account-1',
    }));
    expect(JSON.parse(String(outboxRow?.request.body ?? 'null'))).toMatchObject({
      localId: 'first-turn-indeterminate',
      requestedAction: { v: 1, kind: 'enqueue' },
    });
  });

  it('keeps explicit immediate send_now fail-closed against the released server', async () => {
    const session = buildSession({
      sessionId: 's1',
      overrides: { serverId: 'server-1', encryptionMode: 'plain' },
    });
    storage.getState().applySessions([session]);
    runtimeFetchMock.mockImplementation(async (request: Readonly<{ init?: RequestInit }>) => {
      if (request.init?.method === 'GET') return plainScopedSessionResponse();
      throw new Error('Unsupported immediate delivery cannot submit input');
    });
    serverFeaturesSnapshotMock.mockResolvedValue({
      status: 'ready',
      features: parseReleasedServerV021Features(),
    });
    const schedulePendingOutboxRetry = vi.fn();
    const { sendSessionMessageWithServerScope } = createServerScopedSessionSendMessage({
      schedulePendingOutboxRetry,
      markSessionLiveTailIntent: vi.fn(),
      resolveContext: vi.fn(async () => ({
        scope: 'scoped' as const,
        timeoutMs: 1_000,
        targetServerId: 'server-1',
        targetServerUrl: 'https://server.example.test',
        targetAccountId: 'account-1',
        token: 'token-1',
        credentials: { token: 'token-1' },
        encryption: scopedAccountEncryptionStub(),
      })),
    });

    await expect(sendSessionMessageWithServerScope({
      sessionId: 's1',
      serverId: 'server-1',
      message: 'send immediately',
      messageLocalId: 'immediate-old-server',
      providerDeliveryIntent: 'immediate',
    })).rejects.toMatchObject({ code: 'server-upgrade-required' });

    expect(runtimeFetchMock.mock.calls.filter(([request]) => request.init?.method === 'POST')).toEqual([]);
    expect(schedulePendingOutboxRetry).not.toHaveBeenCalled();
    expect((await loadPendingOutboxForSession('s1', {
      serverId: 'server-1',
      accountId: 'account-1',
    }))).toEqual([]);
  });
});
