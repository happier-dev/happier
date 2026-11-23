import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bindApiSessionSocketSequenceMock,
  createApiSessionSocketStub,
  createSessionRuntimeActivityHomeStub,
  createSessionTranscriptHomeStub,
} from '@/testkit/backends/apiSessionSocketHarness';
import { createMockSession } from '@/testkit/backends/sessionFixtures';
import {
  readSessionFollowWakeInvalidationGeneration,
} from '@/agent/runtime/session/follow/sessionFollowWakeSignal';

import { ApiClient } from './api';
import { CURRENT_MACHINE_OPERATION_PROTOCOL_CAPABILITIES_V1 } from './apiMachine';
import type { ApiSessionClient } from './session/sessionClient';
import { configuration } from '@/configuration';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { SessionInputRequestV1Schema, SessionInputAdmissionReceiptV1Schema, withSessionInputRequest } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { SESSION_PENDING_ADMISSION_SETTLEMENT_EVENT_V1, SessionPendingAdmissionSettlementRequestV1Schema } from '@happier-dev/protocol/sessions/messages/sessionPendingAdmissionSettlementV1';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';

const { mockIo, readStoredCredentialsMock } = vi.hoisted(() => ({
  mockIo: vi.fn(),
  readStoredCredentialsMock: vi.fn(),
}));

vi.mock('socket.io-client', () => ({ io: mockIo }));
vi.mock('@/api/connection/createLoopbackReadinessProbe', () => ({
  createLoopbackReadinessProbe: () => async () => ({ status: 'ready' as const }),
}));
vi.mock('@/persistence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/persistence')>()),
  readStoredCredentials: readStoredCredentialsMock,
}));

describe('ApiClient ordinary Session Follow wake wiring', () => {
  let client: ApiSessionClient | null = null;

  beforeEach(() => {
    vi.stubEnv('HAPPY_ENABLE_V2_CHANGES', 'false');
    mockIo.mockReset();
    resetActiveAccountSettingsSnapshotForTests();
    readStoredCredentialsMock.mockReset().mockResolvedValue({
      token: 'ordinary-account-token',
      encryption: null,
    });
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 404, data: {} });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
  });

  afterEach(async () => {
    await client?.close();
    client = null;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each(['daemon', 'session'] as const)('admits an addressed Discussion input using the %s feature owner through the production Session composition', async featureOwner => {
    const credentials = { token: 'ordinary-account-token', encryption: null } as const;
    const features = FeaturesResponseSchema.parse({ features: {
      sessions: { enabled: true, autonomousExchange: { enabled: true }, conversations: { enabled: true } },
      sharing: { enabled: true, session: { enabled: true } },
    }, capabilities: { session: { pendingInput: { protocolVersion: 1 } } } });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(features)));
    const addressing = { discussionId: 'discussion', messageId: 'question', throughSeq: 3, participantSessionId: 'check-in-destination' };
    const request = SessionInputRequestV1Schema.parse({ v: 1, producer: 'sessionAction', caller: { kind: 'host' },
      sourceSession: { sourceSessionId: 'source-session', sourceTurnId: 'source-turn', sourceInputId: 'source-input', via: 'mcp' },
      discussionAddressing: addressing, replyIntent: { mode: 'return' }, permission: { requestedPermissionCeiling: 'read-only' } });
    const receipt = SessionInputAdmissionReceiptV1Schema.parse({ v: 1, issuer: 'authenticatedMachine', discussionAddressing: addressing,
      admittedTarget: { homeId: configuration.activeServerId, accountId: 'owner', sessionId: 'check-in-destination', machineId: 'machine', installationId: 'installation' } });
    const original = { id: 'original', seq: 1, localId: 'discussion-original', messageRole: 'user', createdAt: 1, updatedAt: 1,
      content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Answer this Discussion question' }, meta: withSessionInputRequest({}, request) } },
      inputAdmissionReceipt: receipt };
    vi.mocked(axios.get).mockImplementation(async url => String(url).includes('/messages/by-local-id/')
      ? { status: 200, data: { message: original } }
      : String(url).includes('/delivery-mutes') ? { status: 200, data: { scopes: [] } }
        : String(url).includes('/v1/access-keys/') ? { status: 200, data: { accessKey: 'ordinary-machine-access' } }
          : { status: 404, data: {} });
    const decisions: unknown[] = [];
    const userSocket = createApiSessionSocketStub({ id: 'check-in-user' });
    const sessionSocket = createApiSessionSocketStub({ id: 'check-in-session', emitWithAck: (event, payload) => {
      if (event !== SESSION_PENDING_ADMISSION_SETTLEMENT_EVENT_V1) return { ok: true };
      const settlement = SessionPendingAdmissionSettlementRequestV1Schema.parse(payload);
      decisions.push(settlement.decision);
      return { v: 1, result: { status: 'accepted', localId: settlement.localId } };
    } });
    bindApiSessionSocketSequenceMock(mockIo, [userSocket, sessionSocket]);
    const api = await ApiClient.create(credentials);
    if (featureOwner === 'daemon') api.setServerFeaturesSnapshotProvider(() => ({ status: 'ready', features }));
    const beforeConnect = readSessionFollowWakeInvalidationGeneration();
    client = await api.sessionSyncClient(createMockSession({ id: 'check-in-destination', encryptionMode: 'plain',
      metadataLayoutVersion: 1, metadata: { v: 1, machineId: 'machine' }, agentState: null }), { durableMutationDeliveryInitiallyActive: false });
    await vi.waitFor(() => expect(sessionSocket.connected).toBe(true));
    await vi.waitFor(() => expect(client?.getServerFeaturesSnapshot()?.status).toBe('ready'));
    await vi.waitFor(() => expect(readSessionFollowWakeInvalidationGeneration()).toBe(beforeConnect + 1));
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
    const discussionRead = vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: {
      discussionId: 'discussion', settings: { coordination: { autonomousCheckIn: { afterTurns: null } } },
    } });
    const featureReads = vi.mocked(fetch).mock.calls.length;
    const input = { localId: original.localId, discussionAddressing: addressing, signal: new AbortController().signal };
    const outcome = await client.reconcileSessionInputForProviderDispatch(input);
    expect({ outcome, discussionReads: discussionRead.mock.calls.length, settlements: decisions.length })
      .toEqual({ outcome: 'admitted', discussionReads: 1, settlements: 1 });
    expect(decisions).toEqual([expect.objectContaining({ kind: 'admit', validation: expect.objectContaining({ autonomousCheckIn: { afterTurns: null } }) })]);
    expect(discussionRead).toHaveBeenCalledOnce();
    expect(discussionRead).toHaveBeenCalledWith(expect.objectContaining({
      url: expect.stringContaining('/v1/discussions/discussion/settings'),
      headers: expect.objectContaining({ Authorization: 'Bearer ordinary-account-token' }),
    }));
    // A real unreadable policy must still fail closed, without submitting a new settlement.
    discussionRead.mockResolvedValue({ status: 503, data: {} });
    expect(await client.reconcileSessionInputForProviderDispatch(input)).toBe('outcomeUnknown');
    expect(decisions).toHaveLength(1);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(featureReads);
  });

  it('backs advertised wake support with exact Session invalidation and reconnect consumers when V2 changes are disabled', async () => {
    const machineId = 'ordinary-machine';
    const activityHome = createSessionRuntimeActivityHomeStub({ machineId });
    const transcriptHome = createSessionTranscriptHomeStub();
    const emitWithAck = (event: string, payload: unknown) => activityHome.answer(event, payload)
      ?? transcriptHome.answer(event, payload) ?? { ok: true };
    vi.mocked(axios.get).mockImplementation(async url => String(url).includes('/v1/access-keys/')
      ? { status: 200, data: { accessKey: 'ordinary-machine-access' } }
      : { status: 404, data: {} });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(FeaturesResponseSchema.parse({
      features: {},
      capabilities: { session: { runtimeActivity: { protocolVersion: 2 },
        pendingInput: { protocolVersion: 3 }, publisherAuthority: { protocolVersion: 1 } } },
    }))));
    const userSocket = createApiSessionSocketStub({ id: 'ordinary-user-socket' });
    const firstSessionSocket = createApiSessionSocketStub({
      id: 'ordinary-session-socket-1',
      disconnectReason: 'transport close',
      emitWithAck,
    });
    const reconnectedSessionSocket = createApiSessionSocketStub({
      id: 'ordinary-session-socket-2',
      emitWithAck,
    });
    bindApiSessionSocketSequenceMock(mockIo, [
      userSocket,
      firstSessionSocket,
      reconnectedSessionSocket,
    ]);

    const api = await ApiClient.create({
      token: 'ordinary-account-token',
      encryption: null,
    });
    const beforeConstruction = readSessionFollowWakeInvalidationGeneration();
    client = await api.sessionSyncClient(createMockSession({
      id: 'destination-session',
      encryptionMode: 'plain',
      metadataLayoutVersion: 1,
      metadata: { v: 1, machineId },
      agentState: null,
    }), {
      // This connection-only fixture has not activated a host runtime yet.
      durableMutationDeliveryInitiallyActive: false,
    });

    await vi.waitFor(() => {
      expect(readSessionFollowWakeInvalidationGeneration()).toBe(beforeConstruction + 1);
    });
    expect(CURRENT_MACHINE_OPERATION_PROTOCOL_CAPABILITIES_V1.sessionFollow).toEqual({
      contextV1: true,
      wakeOnHumanChangeV1: true,
    });

    const afterConnect = readSessionFollowWakeInvalidationGeneration();
    firstSessionSocket.trigger('session', {
      id: 'wrong-session-change',
      createdAt: 1,
      body: { t: 'session-changed', sessionId: 'other-session' },
    });
    expect(readSessionFollowWakeInvalidationGeneration()).toBe(afterConnect);

    firstSessionSocket.trigger('session', {
      id: 'exact-session-change',
      createdAt: 2,
      body: { t: 'session-changed', sessionId: 'destination-session' },
    });
    expect(readSessionFollowWakeInvalidationGeneration()).toBe(afterConnect + 1);

    const beforeReconnect = readSessionFollowWakeInvalidationGeneration();
    firstSessionSocket.disconnect();
    await vi.waitFor(() => expect(reconnectedSessionSocket.connect).toHaveBeenCalledTimes(1), {
      timeout: 3_000,
    });
    await vi.waitFor(() => {
      expect(readSessionFollowWakeInvalidationGeneration()).toBe(beforeReconnect + 1);
    });
  });
});
