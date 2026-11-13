import { act } from 'react-test-renderer';
import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol/sessions/control/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storage';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { writeVoiceConversationBindingMetadata } from '@/voice/binding/voiceConversationBindingMetadata';
import { observeStorageSubscriptionDeliveries } from '@/dev/testkit/performance/storageSubscriptionCensus';

const initialStorageState = getStorage().getState();
const initialBindings = voiceSessionBindingStore.getState();

const TARGET_SESSION_ID = 'target-session';

const VOICE_SETTINGS = Object.freeze({
    providerId: 'local_conversation',
    ui: Object.freeze({
        activityFeedEnabled: false,
        scopeDefault: 'session',
        surfaceLocation: 'session',
    }),
});

function seedTargetSession(): void {
    getStorage().setState((state) => ({
        ...state,
        isDataReady: true,
        sessions: {
            ...state.sessions,
            [TARGET_SESSION_ID]: createSessionFixture({
                id: TARGET_SESSION_ID,
                thinking: false,
                presence: 'online',
                active: true,
                metadata: { path: '/repo', host: 'test', summaryText: 'Dashboard auth' },
            }),
        },
    }));
}

/** A write to a session this surface has nothing to do with. */
function writeUnrelatedSession(index: number): void {
    getStorage().setState((state) => ({
        ...state,
        sessions: {
            ...state.sessions,
            [`unrelated-${index}`]: createSessionFixture({
                id: `unrelated-${index}`,
                thinking: false,
                presence: 'online',
                active: true,
                metadata: { path: '/repo', host: 'test', summaryText: `Unrelated ${index}` },
            }),
        },
    }));
}

/**
 * M3 — the Voice surface must not re-render because some other session moved.
 *
 * `selectPersistedSessions` subscribed to `state.sessions` by identity, so every
 * append, presence flip or metadata patch anywhere in the app produced a new map
 * and re-rendered the whole surface — including, after the Horizon swap, its
 * planet, meter and transcript. What this hook actually depends on is the
 * *resolved* conversation session id, which those writes do not change.
 */
describe('useVoiceSurfaceConversationState session-store subscription', () => {
    beforeEach(() => {
        getStorage().setState(initialStorageState, true);
        voiceSessionBindingStore.setState(initialBindings, true);
        seedTargetSession();
    });

    afterEach(() => {
        standardCleanup();
        getStorage().setState(initialStorageState, true);
        voiceSessionBindingStore.setState(initialBindings, true);
    });

    it('does not re-render on writes to unrelated sessions', async () => {
        const { useVoiceSurfaceConversationState } = await import('./useVoiceSurfaceConversationState');
        let renders = 0;
        const delivery = observeStorageSubscriptionDeliveries();

        const hook = await renderHook(() => {
            renders += 1;
            return useVoiceSurfaceConversationState({
                providerId: 'local_conversation',
                activeControlSessionId: TARGET_SESSION_ID,
                surfaceSessionId: TARGET_SESSION_ID,
                transcriptEnabled: false,
                voiceSettings: VOICE_SETTINGS,
            });
        });

        try {
            const rendersAfterMount = renders;
            expect(hook.getCurrent().openConversationSessionId).toBeNull();
            delivery.reset();

            for (let index = 0; index < 5; index += 1) {
                await act(async () => {
                    writeUnrelatedSession(index);
                });
            }

            expect(renders - rendersAfterMount).toBe(0);
            expect(delivery.count).toBe(0);

            // The same subscription must still discover a newly persisted binding.
            // A disconnected selector could satisfy the unrelated-write assertion.
            const carrierId = 'new-voice-carrier';
            const binding = {
                adapterId: 'local_conversation', controlSessionId: TARGET_SESSION_ID,
                conversationSessionId: carrierId,
                conversationSessionAddress: { serverId: 'server-active', sessionId: carrierId },
                targetSessionAddress: { serverId: 'server-active', sessionId: TARGET_SESSION_ID },
                transcriptMode: 'native_session' as const, updatedAt: 10,
            };
            await act(async () => {
                getStorage().setState((state) => ({ sessions: {
                    ...state.sessions,
                    [carrierId]: createSessionFixture({
                        id: carrierId, serverId: 'server-active',
                        metadata: writeVoiceConversationBindingMetadata({
                            path: '/voice', host: 'test',
                            ...buildSystemSessionMetadataV1({ key: 'voice_conversation', hidden: true }),
                        }, binding),
                    }),
                } }));
            });
            expect(hook.getCurrent().openConversationSessionId).toBe(carrierId);
            expect(renders).toBeGreaterThan(rendersAfterMount);

            const carrier = getStorage().getState().sessions[carrierId]!;
            const carrierMetadata = carrier.metadata;
            if (!carrierMetadata) throw new Error('Expected the voice carrier metadata');
            const changeControl = async (controlSessionId: string, updatedAt: number) => act(async () => {
                getStorage().setState(state => ({ sessions: { ...state.sessions, [carrierId]: {
                    ...carrier, metadata: writeVoiceConversationBindingMetadata(carrierMetadata,
                        { ...binding, controlSessionId, updatedAt }),
                } } }));
            });
            await changeControl('other-control', 11);
            expect(hook.getCurrent().openConversationSessionId).toBeNull();
            await changeControl(TARGET_SESSION_ID, 12);
            expect(hook.getCurrent().openConversationSessionId).toBe(carrierId);
            await act(async () => {
                getStorage().setState(state => ({ sessions: Object.fromEntries(
                    Object.entries(state.sessions).filter(([id]) => id !== carrierId),
                ) }));
            });
            expect(hook.getCurrent().openConversationSessionId).toBeNull();

        } finally {
            await hook.unmount();
            delivery.restore();
        }
    });
});
