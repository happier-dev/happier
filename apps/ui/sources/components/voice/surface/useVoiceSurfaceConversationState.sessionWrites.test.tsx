import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storage';

const initialStorageState = getStorage().getState();

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
    getStorage().setState((state: any) => ({
        ...state,
        isDataReady: true,
        sessions: {
            ...state.sessions,
            [TARGET_SESSION_ID]: {
                id: TARGET_SESSION_ID,
                thinking: false,
                presence: 'online',
                active: true,
                metadata: { summaryText: 'Dashboard auth' },
            },
        },
    }));
}

/** A write to a session this surface has nothing to do with. */
function writeUnrelatedSession(index: number): void {
    getStorage().setState((state: any) => ({
        ...state,
        sessions: {
            ...state.sessions,
            [`unrelated-${index}`]: {
                id: `unrelated-${index}`,
                thinking: false,
                presence: 'online',
                active: true,
                metadata: { summaryText: `Unrelated ${index}` },
            },
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
        seedTargetSession();
    });

    afterEach(() => {
        standardCleanup();
        getStorage().setState(initialStorageState, true);
    });

    it('does not re-render on writes to unrelated sessions', async () => {
        const { useVoiceSurfaceConversationState } = await import('./useVoiceSurfaceConversationState');
        let renders = 0;

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

        const rendersAfterMount = renders;

        for (let index = 0; index < 5; index += 1) {
            await act(async () => {
                writeUnrelatedSession(index);
            });
        }

        expect(renders - rendersAfterMount).toBe(0);

        await hook.unmount();
    });
});
