import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { SessionMetadataTuplePatchV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol/sessions/control/contract';
import { ACP_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { SessionResumeRequestV1Schema } from '@happier-dev/protocol/sessions/control/sessionResumeRequestV1';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createConnectedPurposeCatalogHttpBoundary } from '@/dev/testkit/harness/connectedAccountCatalogBoundary';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { PermissionIntent } from '@happier-dev/agents';
import { readLocalConversationVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { resolveAgentCatalogProjection } from '@/agents/backendCatalog/agentCatalogProjection';
import { resolveAgentConnectedServicesDefaultBindings } from '@/sync/domains/connectedServices/resolveAgentConnectedServicesDefaultBindings';

const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { sync } = await import('@/sync/sync');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { voiceSessionBindingManager } = await import('./voiceConversationBindingRuntime');
const { ensureDefaultLocalVoiceQaBinding } = await import('@/voice/qa/ensureDefaultLocalVoiceQaBinding');
const { voiceSessionBindingStore } = await import('./voiceConversationBindingStore');
const { readVoiceConversationBindingMetadata } = await import('./voiceConversationBindingMetadata');
const { createBuiltinVoiceAdapterAssembly } = await import('@/dev/testkit/harness/builtinVoiceAdapters');
const { registerVoiceAdapters, resetVoiceAdapterRegistryForTests } = await import('@/voice/session/voiceAdapterRegistry');
const { writeVoiceConversationScopeMetadata } = await import('@/voice/persistence/voiceConversationScopeMetadata');
const { VOICE_CONVERSATION_SYSTEM_SESSION_KEY } = await import('@/voice/persistence/voiceConversationSession');
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { selectVoiceTranscriptEntriesForConversationSession } = await import('@/voice/transcript/voiceTranscriptSelectors');
const { RPC_METHODS } = await import('@happier-dev/protocol/rpc');

let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
let metadata: ReturnType<typeof createSessionMetadataHttpBoundary>;
let assembly: Awaited<ReturnType<typeof createBuiltinVoiceAdapterAssembly>>;
let rejectNextBindingFor: string | null;
const address = (sessionId: string) => ({ serverId: connection.home.id, sessionId });
const input = () => ({ adapterId: 'local_conversation', controlSessionId: '__voice_agent__', requestedTargetSessionId: 's1',
    requestedTargetServerId: connection.home.id });
const notes = () => selectVoiceTranscriptEntriesForConversationSession(storage.getState(), 'carrier-s1').filter(entry => entry.kind === 'note');

function carrier(sessionId: string, rootId: string, permissionMode: PermissionIntent,
    connectedServices: ReturnType<typeof resolveAgentConnectedServicesDefaultBindings>): Session {
    return createSessionFixture({ id: sessionId, serverId: connection.home.id, active: true,
        metadata: writeVoiceConversationScopeMetadata({ path: '/project/' + rootId, host: 'tester.local', machineId: 'machine-1',
            flavor: 'codex', permissionMode, connectedServices,
            ...buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true }),
        }, { kind: 'session_root', sessionRootId: rootId }),
    });
}

async function persistedBinding(sessionId: string) {
    const response = metadata.handle(new URL('/v2/sessions/' + sessionId, connection.home.serverUrl));
    if (!response) throw new Error('Missing carrier HTTP response');
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== 'object' || !('session' in payload)) throw new Error('Missing Session response');
    const record = SessionCurrentProjectionRecordV1Schema.parse(payload.session);
    if (record.ownerMetadata?.t !== 'plain') throw new Error('Expected persisted Plain owner metadata');
    return readVoiceConversationBindingMetadata(sessionId, record.ownerMetadata.v.system, { sourceServerId: connection.home.id });
}

beforeEach(async () => {
    network.resetRequests();
    clearDaemonMergedProjectionCacheForTests();
    const home = await network.addHome('https://voice-binding-publication.example.test', 'account-binding');
    metadata = createSessionMetadataHttpBoundary(() => storage.getState().sessions);
    const purposes = createConnectedPurposeCatalogHttpBoundary();
    rejectNextBindingFor = null;
    const settings = settingsParse({ lastUsedAgent: 'codex', voice: {
        providers: { local_conversation: { schemaVersion: 1, config: {
            conversationMode: 'agent', agent: { backend: 'daemon', agentSource: 'agent', agentId: 'codex', rootSessionPolicy: 'keep_warm', maxWarmRoots: 5 },
        } } },
    } });
    const machine = createPlainMachineRowFixture({ id: 'machine-1', accountId: 'account-binding' });
    network.setRpcAckResponder(async request => {
        if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)
            return { ok: false, error: 'RPC method not found', errorCode: 'RPC_METHOD_NOT_FOUND' };
        if (request.method === RPC_METHODS.SPAWN_HAPPY_SESSION || request.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE) {
            const resume = SessionResumeRequestV1Schema.parse(request.payload);
            expect(request).toMatchObject({ targetId: 'machine-1', serverUrl: home.serverUrl });
            expect(['carrier-s1', 'carrier-s2']).toContain(resume.sessionId);
            expect(resume).toMatchObject({ type: 'resume-session', directory: '/project/' + resume.sessionId.slice('carrier-'.length) });
            return { ok: true, result: { type: 'success', sessionId: resume.sessionId } };
        }
        throw new Error('Unexpected daemon effect: ' + request.method);
    });
    const request = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response | null> => {
        const path = new URL(String(url)).pathname;
        if (init?.method === 'PATCH' && path === '/v2/sessions/' + rejectNextBindingFor) {
            const patch = SessionMetadataTuplePatchV1Schema.parse(JSON.parse(String(init.body)));
            const owner = patch.mode === 'owner_migration' ? patch.target.ownerMetadata : patch.mode === 'owner' ? patch.ownerMetadata : null;
            if (owner?.t === 'plain' && owner.v.system?.voiceConversationBindingV1) {
                metadata.rejectNextPatch(rejectNextBindingFor!);
                rejectNextBindingFor = null;
            }
        }
        const sessionResponse = metadata.handle(url, init);
        if (sessionResponse) return sessionResponse;
        if (path === '/health') return Response.json({});
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
        if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: settings }, version: 1 });
        if (path === ACP_CATALOG_ROWS_ROUTE_V1) return Response.json({ status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, definitions: [] } } });
        if (path === '/v1/machines') return Response.json([machine]);
            if (path === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
              id => id === machine.id ? machine : null);
            if (path === '/v1/machines/machine-1') return Response.json({ machine });
        if (path === '/v2/cursor') return Response.json({ cursor: 0, changesFloor: 0 });
        if (path === '/v2/changes') return Response.json({ changes: [], nextCursor: 0 });
        if (path === '/v2/sessions/metadata-upgrades') return Response.json({ sessionIds: [] });
        return await purposes.handle(url, init);
    };
    network.setHttpResponder(request);
    connection = await restoreServerAccountForTest({ serverUrl: home.serverUrl, accountId: 'account-binding',
        credentialScope: 'restored-home', request: createSessionReadBatchFetchBoundary(request) });
    await sync.refreshMachines();
    const scope = { serverId: connection.home.id, accountId: 'account-binding' };
    const agent = resolveAgentCatalogProjection('codex', { enabledAgentIds: [] });
    if (!agent.identity) throw new Error('Expected the bundled Codex contribution');
    const connectedServices = resolveAgentConnectedServicesDefaultBindings({ settings,
        purposeBindings: purposes.value, agentId: 'codex', consumer: agent.identity,
        declarations: agent.connectedAccounts });
    const sessions = Object.fromEntries(['s1', 's2'].flatMap(rootId => [
        createSessionFixture({ id: rootId, serverId: scope.serverId, metadata: { path: '/project/' + rootId, host: 'tester.local', machineId: 'machine-1' } }),
        carrier('carrier-' + rootId, rootId, readLocalConversationVoiceSettings(settings.voice).agent.permissionIntent, connectedServices),
    ]).map(session => [session.id, session]));
    storage.setState({ settings, settingsScope: scope, profileScope: scope, sessions, sessionMessages: {} });
    voiceSessionBindingStore.setState({ bindingsByConversationSessionId: {}, runtimeBindingsByConversationSessionId: {}, persistedBindingsByConversationSessionId: {} });
    resetVoiceAdapterRegistryForTests();
    assembly = (await createBuiltinVoiceAdapterAssembly());
    registerVoiceAdapters(assembly.adapters);
});

afterEach(async () => {
    resetVoiceAdapterRegistryForTests();
    await assembly?.dispose();
    await connection?.dispose();
});
afterAll(() => network.dispose());

describe('binding publication through actual resolver and HTTP persistence', () => {
    it('commits a carrier metadata edit when detail residency releases the row during the HTTP read', async () => {
        // Establish the real server-side fixture before releasing its local
        // detail projection. The metadata owner must use its hydrated read.
        metadata.handle(new URL('/v2/sessions/carrier-s1', connection.home.serverUrl));
        let released = 0;
        const unsubscribe = storage.subscribe(state => {
            if (!state.sessions['carrier-s1']) return;
            const { 'carrier-s1': _released, ...sessions } = state.sessions;
            released += 1;
            storage.setState({ sessions });
        });
        const { 'carrier-s1': _coldCarrier, ...otherSessions } = storage.getState().sessions;
        storage.setState({ sessions: otherSessions });
        try {
            await expect(sync.patchSessionMetadataWithRetry('carrier-s1', current => ({
                ...current, summary: { text: 'Retained carrier title', updatedAt: 7 },
            }))).resolves.toBeUndefined();
            expect(released).toBeGreaterThan(0);
            const response = metadata.handle(new URL('/v2/sessions/carrier-s1', connection.home.serverUrl));
            if (!response) throw new Error('Missing carrier HTTP response');
            const wire = SessionCurrentProjectionRecordV1Schema.parse((await response.json()).session);
            expect(wire.metadata).toContain('Retained carrier title');
            expect(wire.ownerMetadata?.t).toBe('plain');
            if (wire.ownerMetadata?.t !== 'plain') throw new Error('Expected opened owner metadata');
            expect(wire.ownerMetadata.v.system?.voiceConversationScopeV1).toMatchObject({ kind: 'session_root', sessionRootId: 's1' });
        } finally { unsubscribe(); }
    });

    it('publishes only after persistence succeeds and safely retries the failed binding', async () => {
        rejectNextBindingFor = 'carrier-s1';
        await expect(voiceSessionBindingManager.ensureBound(input())).rejects.toMatchObject({ status: 500 });
        expect(rejectNextBindingFor).toBeNull();
        expect(metadata.writes).toContain('carrier-s1');
        expect(voiceSessionBindingStore.getState().getByConversationSessionId('carrier-s1')).toBeNull();
        expect(voiceSessionBindingStore.getState().getByControlSessionId('__voice_agent__')).toBeNull();
        expect(await persistedBinding('carrier-s1')).toBeNull();
        expect(notes()).toEqual([]);

        const bound = await ensureDefaultLocalVoiceQaBinding({
            controlSessionId: '__voice_agent__', requestedTargetSessionAddress: address('s1'),
        });
        expect(bound).toMatchObject({
            controlSessionId: '__voice_agent__', conversationSessionId: 'carrier-s1',
            conversationSessionAddress: address('carrier-s1'), targetSessionAddress: address('s1'),
            transcriptMode: 'native_session',
        });
        expect(voiceSessionBindingStore.getState().getByControlSessionId('__voice_agent__')).toEqual(bound);
        expect(await persistedBinding('carrier-s1')).toMatchObject(bound!);
        expect(notes()).toEqual([]);
    });

    it('retains prior target and emits no switch note on failed persistence, then retries safely', async () => {
        await voiceSessionBindingManager.ensureBound(input());
        rejectNextBindingFor = 'carrier-s1';
        await expect(voiceSessionBindingManager.syncTargetSession({ controlSessionId: '__voice_agent__', targetSessionAddress: address('s2') }))
            .rejects.toMatchObject({ status: 500 });
        expect(rejectNextBindingFor).toBeNull();
        expect(voiceSessionBindingStore.getState().getByControlSessionId('__voice_agent__')?.targetSessionAddress).toEqual(address('s1'));
        expect(await persistedBinding('carrier-s1')).toMatchObject({ targetSessionAddress: address('s1') });
        expect(notes()).toEqual([]);

        const rebound = await voiceSessionBindingManager.syncTargetSession({ controlSessionId: '__voice_agent__', targetSessionAddress: address('s2') });
        expect(rebound?.targetSessionAddress).toEqual(address('s2'));
        expect(await persistedBinding('carrier-s1')).toMatchObject({ targetSessionAddress: address('s2') });
        expect(notes()).toHaveLength(1);
    });

    it('surfaces rebind failure rather than silently reopening the old conversation', async () => {
        const initial = await voiceSessionBindingManager.ensureBound(input());
        expect(initial).not.toBeNull();
        rejectNextBindingFor = 'carrier-s2';
        await expect(voiceSessionBindingManager.ensureBoundForOpenConversation({
            openConversationSessionId: 'carrier-s1', fallbackControlSessionId: '__voice_agent__', activeAdapterId: 'local_conversation',
            providerId: 'local_conversation', requestedTargetSessionId: 's2', requestedTargetServerId: connection.home.id,
        })).rejects.toMatchObject({ status: 500 });
        expect(rejectNextBindingFor).toBeNull();
        expect(voiceSessionBindingStore.getState().getByConversationSessionId('carrier-s2')).toBeNull();
        expect(await persistedBinding('carrier-s2')).toBeNull();
        expect(voiceSessionBindingStore.getState().getByConversationSessionId('carrier-s1')).toEqual(initial);
        expect(notes()).toEqual([]);
    });
});
