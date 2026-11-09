import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { VOICE_CONVERSATION_SYSTEM_SESSION_KEY } from '@happier-dev/protocol/voice/sessionBinding';
import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol/sessions/control/contract';
import { createDeferred, createSessionFixture } from '@/dev/testkit';

const fixtureMetadata = (() => {
    const metadata = createSessionFixture().metadata;
    if (!metadata) throw new Error('Canonical Session fixture metadata missing');
    return metadata;
})();
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { VoiceSessionBinding } from './voiceConversationBindingTypes';

vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
const { voiceSessionBindingStore } = await import('./voiceConversationBindingStore');
const { writeVoiceConversationBindingMetadata, readVoiceConversationBindingMetadata } = await import('./voiceConversationBindingMetadata');
const { applyVoiceSessionTargetSelection } = await import('./applyVoiceSessionTargetSelection');
const { useVoiceTargetStore } = await import('@/voice/runtime/voiceTargetStore');
const { VOICE_AGENT_GLOBAL_SESSION_ID } = await import('@/voice/agent/voiceAgentGlobalSessionId');
const initialState = storage.getState();
const initialTargets = useVoiceTargetStore.getState();
const initialBindings = voiceSessionBindingStore.getState();
afterEach(async () => {
    storage.setState(initialState, true);
    useVoiceTargetStore.setState(initialTargets, true);
    voiceSessionBindingStore.setState(initialBindings, true);
});

describe('applyVoiceSessionTargetSelection', () => {
    it('persists the normalized bound target before publishing primary and last-focused selection', async () => {
        const { createVoiceSettingsAccountTestHarness } = await import('@/voice/settings/panels/voiceSettingsAccountTestHarness');
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        const account = await createVoiceSettingsAccountTestHarness(settingsParse({}));
        const serverId = account.scope.serverId;
        let sessions: Readonly<Record<string, Session>> = {};
        const metadata = createSessionMetadataHttpBoundary(() => sessions);
        const patchObserved = createDeferred<void>();
        const releasePatch = createDeferred<void>();
        let holdPatches = false;
        const request = account.request.getMockImplementation();
        if (!request) throw new Error('Account HTTP boundary missing');
        account.request.mockImplementation(createSessionReadBatchFetchBoundary(async (url, init) => {
            if (holdPatches && init?.method === 'PATCH' && new URL(String(url)).pathname === '/v2/sessions/voice-carrier') {
                patchObserved.resolve();
                await releasePatch.promise;
            }
            return metadata.handle(url, init) ?? await request(url, init);
        }));
        try {
            const previous = { serverId, sessionId: 'previous-target' };
            const target = { serverId, sessionId: 'next-target' };
            const binding: VoiceSessionBinding = {
                adapterId: 'local_conversation', controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
                conversationSessionId: 'voice-carrier', conversationSessionAddress: { serverId, sessionId: 'voice-carrier' },
                transcriptMode: 'synthetic', targetSessionAddress: previous, updatedAt: 1,
            };
            const seed = createSessionFixture({ id: 'voice-carrier', serverId,
                metadata: writeVoiceConversationBindingMetadata({
                    ...fixtureMetadata,
                    ...buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true }),
                }, binding),
            });
            sessions = { [seed.id]: seed };
            storage.setState({ sessions });
            voiceSessionBindingStore.getState().bind(binding);
            useVoiceTargetStore.getState().setPrimaryActionSessionAddress(previous);
            useVoiceTargetStore.getState().setLastFocusedSessionAddress(previous);
            holdPatches = true;

            const selecting = applyVoiceSessionTargetSelection({
                controlSessionId: `  ${VOICE_AGENT_GLOBAL_SESSION_ID}  `,
                targetSessionAddress: { serverId: ` ${serverId} `, sessionId: ' next-target ' },
                updateLastFocused: true,
            });
            await Promise.race([
                patchObserved.promise,
                selecting.then(() => { throw new Error('Selection completed without reaching the metadata persistence boundary'); }),
            ]);
            expect(useVoiceTargetStore.getState().primaryActionSessionAddress).toEqual(previous);
            expect(useVoiceTargetStore.getState().lastFocusedSessionAddress).toEqual(previous);
            releasePatch.resolve();
            await selecting;

            expect(useVoiceTargetStore.getState().primaryActionSessionAddress).toEqual(target);
            expect(useVoiceTargetStore.getState().lastFocusedSessionAddress).toEqual(target);
            expect(voiceSessionBindingStore.getState().getByControlSessionId(VOICE_AGENT_GLOBAL_SESSION_ID)?.targetSessionAddress).toEqual(target);
            const serverUrl = getServerProfileById(serverId)?.serverUrl;
            if (!serverUrl) throw new Error('Persisted Home profile missing');
            const readPersistedBinding = async () => {
                const response = metadata.handle(new URL('/v2/sessions/voice-carrier', serverUrl));
                if (!response) throw new Error('Persisted Voice carrier is unavailable');
                const payload: unknown = await response.json();
                if (!payload || typeof payload !== 'object' || !('session' in payload)) throw new Error('Session response missing');
                const record = SessionCurrentProjectionRecordV1Schema.parse(payload.session);
                if (record.ownerMetadata?.t !== 'plain') throw new Error('Expected actual Plain Account owner metadata');
                return readVoiceConversationBindingMetadata(seed.id, record.ownerMetadata.v.system, { sourceServerId: serverId });
            };
            expect(await readPersistedBinding())
                .toMatchObject({ controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID, targetSessionAddress: target });

            // The tool caller must consume this owner, not publish a parallel
            // target-store update that leaves its bound conversation behind.
            const toolTarget = { serverId, sessionId: 'tool-target' };
            const toolSession = createSessionFixture({ id: toolTarget.sessionId, serverId });
            sessions = { ...sessions, [toolSession.id]: toolSession };
            storage.setState(current => ({ sessions: { ...current.sessions, [toolSession.id]: toolSession } }));
            const { setPrimaryActionSessionId } = await import('@/voice/tools/actionImpl/sessionTargets');
            expect(await setPrimaryActionSessionId({ ...toolTarget, updateLastFocused: true }))
                .toMatchObject({ ok: true, address: toolTarget });
            expect(useVoiceTargetStore.getState().primaryActionSessionAddress).toEqual(toolTarget);
            expect(useVoiceTargetStore.getState().lastFocusedSessionAddress).toEqual(toolTarget);
            expect(await readPersistedBinding()).toMatchObject({
                controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID, targetSessionAddress: toolTarget,
            });
        } finally {
            releasePatch.resolve();
            await account.dispose();
        }
    });
});
