import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol';
import { VOICE_CONVERSATION_SYSTEM_SESSION_KEY } from '@happier-dev/protocol/voice/sessionBinding';
import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol/sessions/control/contract';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { VoiceSessionBinding } from './voiceConversationBindingTypes';

vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

const { storage } = await import('@/sync/domains/state/storage');
const { sync } = await import('@/sync/sync');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { createVoiceSettingsAccountTestHarness } = await import('@/voice/settings/panels/voiceSettingsAccountTestHarness');
const { createVoiceSessionBindingStore } = await import('./voiceConversationBindingStore');
const { createVoiceConversationBindingResolver } = await import('./VoiceConversationBindingResolver');
const { createVoiceSessionBindingManager } = await import('./voiceConversationBindingManager');
const { writeVoiceConversationBindingMetadata, readVoiceConversationBindingMetadata } = await import('./voiceConversationBindingMetadata');
const { appendVoiceTargetSessionSwitchNote } = await import('./appendVoiceTargetSessionSwitchNote');
const { selectVoiceTranscriptEntriesForConversationSession } = await import('@/voice/transcript/voiceTranscriptSelectors');
const { createBuiltinVoiceAdapterAssembly } = await import('@/dev/testkit/harness/builtinVoiceAdapters');
const { registerVoiceAdapters, resetVoiceAdapterRegistryForTests, getVoiceAdapterRegistry } = await import('@/voice/session/voiceAdapterRegistry');

let account: Awaited<ReturnType<typeof createVoiceSettingsAccountTestHarness>>;
let http: ReturnType<typeof createSessionMetadataHttpBoundary>;
let assembly: Awaited<ReturnType<typeof createBuiltinVoiceAdapterAssembly>>;
let store: ReturnType<typeof createVoiceSessionBindingStore>;
let manager: ReturnType<typeof createVoiceSessionBindingManager>;
let now = 123;
const address = (sessionId: string) => ({ serverId: account.scope.serverId, sessionId });
const input = { adapterId: 'local_conversation', controlSessionId: 'voice-global', requestedTargetSessionId: 's1' };
const notes = () => selectVoiceTranscriptEntriesForConversationSession(storage.getState(), 'carrier-s1').filter(entry => entry.kind === 'note');

function seedBinding(overrides: Partial<VoiceSessionBinding> = {}) {
    const binding: VoiceSessionBinding = {
        adapterId: 'local_conversation', controlSessionId: 'voice-global',
        conversationSessionId: 'carrier-s1', conversationSessionAddress: address('carrier-s1'),
        transcriptMode: 'native_session', targetSessionAddress: address('s1'), updatedAt: 1, ...overrides,
    };
    const session = createSessionFixture({ id: binding.conversationSessionId, serverId: account.scope.serverId,
        metadata: writeVoiceConversationBindingMetadata({ ...createSessionFixture().metadata!,
            ...buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true }),
        }, binding),
    });
    storage.setState(state => ({ sessions: { ...state.sessions, [session.id]: session } }));
    http.replaceSession(session.id);
    return binding;
}

async function persistedBinding(sessionId = 'carrier-s1') {
    const response = http.handle(new URL('/v2/sessions/' + sessionId, getActiveServerSnapshot().serverUrl));
    if (!response) throw new Error('Missing persisted Voice session');
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== 'object' || !('session' in payload)) throw new Error('Missing Session response');
    const record = SessionCurrentProjectionRecordV1Schema.parse(payload.session);
    if (record.ownerMetadata?.t !== 'plain') throw new Error('Expected Plain Account owner metadata');
    return readVoiceConversationBindingMetadata(sessionId, record.ownerMetadata.v.system, { sourceServerId: account.scope.serverId });
}

beforeEach(async () => {
    account = await createVoiceSettingsAccountTestHarness(settingsParse({ voice: { privacy: { shareSessionSummary: true } } }));
    storage.setState({ sessions: {
        s1: createSessionFixture({ id: 's1', serverId: account.scope.serverId,
            metadata: { ...createSessionFixture().metadata!, name: 'Previous project' } }),
        s2: createSessionFixture({ id: 's2', serverId: account.scope.serverId,
            metadata: { ...createSessionFixture().metadata!, name: 'Next project' } }),
    }, sessionMessages: {} });
    http = createSessionMetadataHttpBoundary(() => storage.getState().sessions);
    const request = account.request.getMockImplementation();
    if (!request) throw new Error('Account HTTP boundary missing');
    account.request.mockImplementation(createSessionReadBatchFetchBoundary(async (url, init) => http.handle(url, init) ?? request(url, init)));
    store = createVoiceSessionBindingStore();
    // Real persisted-binding policy and Sync persistence; only Home HTTP and the clock are controlled.
    const resolver = createVoiceConversationBindingResolver({ store: createVoiceSessionBindingStore() });
    resetVoiceAdapterRegistryForTests();
    assembly = (await createBuiltinVoiceAdapterAssembly());
    registerVoiceAdapters(assembly.adapters);
    now = 123;
    manager = createVoiceSessionBindingManager({
        store, nowMs: () => now,
        resolveBinding: async params => resolver.resolveByControlSessionId(params),
        resolveExistingBindingByConversationSessionId: conversationSessionId => resolver.resolveByConversationSessionId({ conversationSessionId }),
        resolveConversationTargeting: adapterId => getVoiceAdapterRegistry().get(adapterId)?.conversationTargeting ?? 'route_target',
        persistBinding: async binding => { await sync.patchSessionMetadataWithRetry(binding.conversationSessionId,
            metadata => writeVoiceConversationBindingMetadata(metadata, binding)); },
        appendTargetSwitchNote: appendVoiceTargetSessionSwitchNote,
    });
});

afterEach(async () => {
    resetVoiceAdapterRegistryForTests();
    await assembly?.dispose();
    await account?.dispose();
});

describe('binding manager with real binding and persistence owners', () => {
    it('admits an exact synced binding locally before another client changes its target', async () => {
        const previous = seedBinding();
        store.getState().replacePersistedBindings([previous]);
        await manager.ensureBound(input);
        store.getState().replacePersistedBindings([{ ...previous, targetSessionAddress: address('s2'), updatedAt: 999 }]);
        expect(store.getState().getByControlSessionId(input.controlSessionId)?.targetSessionAddress).toEqual(address('s1'));
    });

    it('stores and persists the binding from the canonical resolver', async () => {
        seedBinding();
        const binding = await manager.ensureBound(input);
        expect(binding?.conversationSessionId).toBe('carrier-s1');
        expect(store.getState().getByConversationSessionId('carrier-s1')?.adapterId).toBe('local_conversation');
        expect(store.getState().getByControlSessionId('voice-global')).toEqual(binding);
        expect(await persistedBinding()).toMatchObject(binding!);
        expect(notes()).toEqual([]);
    });

    it('appends a target-switch note when target changes within the same conversation', async () => {
        seedBinding();
        await manager.ensureBound(input);
        seedBinding({ targetSessionAddress: address('s2'), updatedAt: 2 });
        await manager.ensureBound({ ...input, requestedTargetSessionId: 's2' });
        expect(await persistedBinding()).toMatchObject({ targetSessionAddress: address('s2') });
        expect(notes()).toHaveLength(1);
        expect(notes()[0]?.text).toContain('Previous project');
        expect(notes()[0]?.text).toContain('Next project');
    });

    it('updates tracked target while preserving the same conversation', async () => {
        seedBinding();
        await manager.ensureBound(input);
        now = 456;
        const next = await manager.syncTargetSession({ controlSessionId: 'voice-global', targetSessionAddress: address('s2') });
        expect(next).toMatchObject({ conversationSessionId: 'carrier-s1', targetSessionAddress: address('s2'), updatedAt: 456 });
        expect(await persistedBinding()).toMatchObject(next!);
        expect(notes()).toHaveLength(1);
    });

    it('reuses binding semantics without a persistence write when unchanged', async () => {
        seedBinding({ targetSessionAddress: null });
        const initial = await manager.ensureBound({ ...input, requestedTargetSessionId: null });
        const writes = http.writes.length;
        now = 789;
        expect(await manager.ensureBound({ ...input, requestedTargetSessionId: null })).toEqual(initial);
        expect(store.getState().getByControlSessionId('voice-global')).toEqual(initial);
        expect(http.writes).toHaveLength(writes);
    });

    it('canonicalizes ids before canonical lookup and persistence', async () => {
        seedBinding();
        const padded = { adapterId: ' local_conversation ', controlSessionId: ' voice-global ', requestedTargetSessionId: ' s1 ' };
        const initial = await manager.ensureBound(padded);
        expect(initial).toMatchObject({ adapterId: 'local_conversation', controlSessionId: 'voice-global', targetSessionAddress: address('s1') });
        now = 456;
        expect(await manager.ensureBound(padded)).toEqual(initial);
        expect(await persistedBinding()).toMatchObject(initial!);
    });

    it('keeps a contributed bound-conversation attachment fixed when the route drifts', async () => {
        const adapterId = 'happier.agent.codex/realtime-codex';
        expect(getVoiceAdapterRegistry().get(adapterId)?.conversationTargeting).toBe('bound_conversation');
        seedBinding({ adapterId, conversationSessionId: 'hidden-codex-voice-a', conversationSessionAddress: address('hidden-codex-voice-a'), targetSessionAddress: null });
        expect(await manager.ensureBoundForOpenConversation({ openConversationSessionId: 'hidden-codex-voice-a', fallbackControlSessionId: 'voice-global',
            activeAdapterId: adapterId, providerId: adapterId, requestedTargetSessionId: 'visible-session-b', requestedTargetServerId: account.scope.serverId,
        })).toEqual({ conversationSessionId: 'hidden-codex-voice-a', conversationServerId: account.scope.serverId });
        expect(http.writes).toEqual([]);
    });

    it('opens the existing conversation without rebinding when target matches', async () => {
        seedBinding();
        expect(await manager.ensureBoundForOpenConversation({ openConversationSessionId: 'carrier-s1', fallbackControlSessionId: 'voice-global',
            activeAdapterId: 'local_conversation', providerId: 'local_conversation', requestedTargetSessionId: 's1', requestedTargetServerId: account.scope.serverId,
        })).toEqual({ conversationSessionId: 'carrier-s1', conversationServerId: account.scope.serverId });
        expect(http.writes).toEqual([]);
    });

    it('rebinds to the canonical new conversation when requested target drifts', async () => {
        seedBinding();
        seedBinding({ conversationSessionId: 'carrier-s2', conversationSessionAddress: address('carrier-s2'), targetSessionAddress: address('s2'), updatedAt: 2 });
        expect(await manager.ensureBoundForOpenConversation({ openConversationSessionId: 'carrier-s1', fallbackControlSessionId: 'voice-global',
            activeAdapterId: 'local_conversation', providerId: 'local_conversation', requestedTargetSessionId: 's2', requestedTargetServerId: account.scope.serverId,
        })).toEqual({ conversationSessionId: 'carrier-s2', conversationServerId: account.scope.serverId });
        expect(await persistedBinding('carrier-s2')).toMatchObject({ targetSessionAddress: address('s2') });
    });

    it('uses provider selection when no existing open-conversation binding remains', async () => {
        seedBinding({ conversationSessionId: 'voice-root-s1', conversationSessionAddress: address('voice-root-s1') });
        expect(await manager.ensureBoundForOpenConversation({ openConversationSessionId: 'carrier-missing', fallbackControlSessionId: 'voice-global',
            activeAdapterId: null, providerId: 'local_conversation', requestedTargetSessionId: 's1', requestedTargetServerId: account.scope.serverId,
        })).toEqual({ conversationSessionId: 'voice-root-s1', conversationServerId: account.scope.serverId });
        expect(await persistedBinding('voice-root-s1')).toMatchObject({ adapterId: 'local_conversation' });
    });

    it('falls back to original conversation when rebinding cannot proceed', async () => {
        expect(await manager.ensureBoundForOpenConversation({ openConversationSessionId: 'carrier-s1', fallbackControlSessionId: null,
            activeAdapterId: null, providerId: 'local_conversation', requestedTargetSessionId: null,
        })).toEqual({ conversationSessionId: 'carrier-s1', conversationServerId: null });
        expect(http.writes).toEqual([]);
    });

    it('rebinds when canonical metadata changes conversation and transcript semantics', async () => {
        seedBinding({ conversationSessionId: 'carrier-home', conversationSessionAddress: address('carrier-home'), targetSessionAddress: null });
        await manager.ensureBound({ ...input, requestedTargetSessionId: null });
        seedBinding({ conversationSessionId: 'carrier-root', conversationSessionAddress: address('carrier-root'), transcriptMode: 'synthetic', targetSessionAddress: null, updatedAt: 1000 });
        now = 790;
        const rebound = await manager.ensureBound({ ...input, requestedTargetSessionId: null });
        expect(rebound).toMatchObject({ conversationSessionId: 'carrier-root', transcriptMode: 'synthetic', updatedAt: 790 });
        expect(store.getState().getByControlSessionId('voice-global')).toEqual(rebound);
        expect(await persistedBinding('carrier-root')).toMatchObject(rebound!);
    });
});
