import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol';

import { renderScreen } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { getStorage } from '@/sync/domains/state/storage';
import { Platform } from 'react-native';

import { SOUND_EFFECT_SOURCES } from './soundEffectSources';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const initialStorageState = getStorage().getState();

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'android' } });
});

// expo-audio is the native playback boundary; the runtime, bus, store and catalog stay real.
const audio = vi.hoisted(() => ({
    played: [] as unknown[],
    setAudioModeAsync: vi.fn(async () => {}),
}));
vi.mock('expo-audio', () => ({
    AudioModule: { setAudioModeAsync: audio.setAudioModeAsync },
    createAudioPlayer: (source: unknown) => ({
        play: () => { audio.played.push(source); },
        remove: () => {},
        addListener: () => ({ remove() {} }),
    }),
}));

// The Android quiet-mode reader is a local native module.
const quietMode = vi.hoisted(() => ({ active: false }));
vi.mock('expo-modules-core', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    const requireOptional = actual.requireOptionalNativeModule as (name: string) => unknown;
    return {
        ...actual,
        requireOptionalNativeModule: (name: string) => (name === 'HappierQuietMode'
            ? { isQuietModeActive: () => quietMode.active }
            : requireOptional(name)),
    };
});

const failure: SessionRuntimeIssueV1 = {
    v: 1,
    scope: 'primary_session',
    status: 'failed',
    code: 'provider_error',
    source: 'provider_session_error',
    occurredAt: 5_000,
};

function putSession(session: ReturnType<typeof createSessionFixture>): void {
    const state = getStorage().getState();
    getStorage().setState({ sessions: { ...state.sessions, [session.id]: session } });
}

async function flushPlayback(): Promise<void> {
    // Playback starts after the audio module loads asynchronously.
    await act(async () => { await vi.runAllTimersAsync(); });
}

describe('SoundEffectsRuntime', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        getStorage().setState(initialStorageState, true);
        Platform.OS = 'android';
        quietMode.active = false;
        audio.played.length = 0;
        getStorage().getState().applyLocalSettings({ soundEffectsEnabled: true });
    });

    afterEach(async () => {
        getStorage().setState(initialStorageState, true);
        const { resetActivityLocalNotificationRuntimeForTests } = await import('@/activity/notifications/runtime/activityLocalNotificationBus');
        resetActivityLocalNotificationRuntimeForTests();
        vi.useRealTimers();
    });

    it('stays silent until sound effects are switched on for this device', async () => {
        getStorage().getState().applyLocalSettings({ soundEffectsEnabled: false });
        const { SoundEffectsRuntime } = await import('./SoundEffectsRuntime');
        const { notifyActivityAgentRequest, notifyActivityReady } = await import('@/activity/notifications/runtime/activityLocalNotificationBus');
        const screen = await renderScreen(<SoundEffectsRuntime />);

        await act(async () => {
            notifyActivityReady('session-1', [], 1);
            notifyActivityAgentRequest({ sessionId: 'session-1', requestId: 'r1', requestKind: 'permission', toolName: 'Bash', toolArgs: {} });
        });
        await flushPlayback();

        expect(audio.played).toEqual([]);
        await act(async () => { screen.tree.unmount(); });
    });

    it('plays the chosen attention and success sounds', async () => {
        getStorage().getState().applyLocalSettings({ soundEffectsSuccessSound: 'sound_electro_pop1' });
        const running = createSessionFixture({ id: 'session-2', latestTurnId: 'turn-2', latestTurnStatus: 'in_progress' });
        putSession(running);
        const { SoundEffectsRuntime } = await import('./SoundEffectsRuntime');
        const { notifyActivityAgentRequest, notifyActivityReady } = await import('@/activity/notifications/runtime/activityLocalNotificationBus');
        const screen = await renderScreen(<SoundEffectsRuntime />);

        await act(async () => {
            notifyActivityAgentRequest({ sessionId: 'session-1', requestId: 'r1', requestKind: 'user_action', toolName: 'AskUserQuestion', toolArgs: {} });
        });
        await flushPlayback();
        expect(audio.played).toEqual([SOUND_EFFECT_SOURCES['sound_electro_swell-taps']]);

        await act(async () => { notifyActivityReady('session-2', [], 7); });
        await flushPlayback();
        expect(audio.played).toEqual([SOUND_EFFECT_SOURCES['sound_electro_swell-taps']]);

        await act(async () => { putSession({ ...running, latestTurnStatus: 'completed' }); });
        await flushPlayback();
        expect(audio.played).toEqual([
            SOUND_EFFECT_SOURCES['sound_electro_swell-taps'],
            SOUND_EFFECT_SOURCES.sound_electro_pop1,
        ]);
        await act(async () => { screen.tree.unmount(); });
    });

    it('plays the error sound instead of success when a turn ends in failure', async () => {
        putSession(createSessionFixture({ id: 'session-1', thinking: true, latestTurnStatus: 'in_progress' }));
        const { SoundEffectsRuntime } = await import('./SoundEffectsRuntime');
        const { notifyActivityReady } = await import('@/activity/notifications/runtime/activityLocalNotificationBus');
        const screen = await renderScreen(<SoundEffectsRuntime />);

        // The ready event and the failed turn status arrive separately, in either order.
        await act(async () => { notifyActivityReady('session-1', [], 3); });
        await flushPlayback();
        expect(audio.played).toEqual([]);
        await act(async () => {
            putSession(createSessionFixture({
                id: 'session-1',
                thinking: false,
                latestTurnStatus: 'failed',
                lastRuntimeIssue: failure,
            }));
        });
        await flushPlayback();
        expect(audio.played).toEqual([SOUND_EFFECT_SOURCES.sound_electro_158]);

        putSession(createSessionFixture({ id: 'session-2', thinking: true }));
        await act(async () => {
            putSession(createSessionFixture({
                id: 'session-2',
                latestTurnStatus: 'failed',
                lastRuntimeIssue: { ...failure, occurredAt: 6_000 },
            }));
        });
        // The ready event may also trail the failure.
        await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
        await act(async () => { notifyActivityReady('session-2', [], 4); });
        await flushPlayback();

        expect(audio.played).toEqual([SOUND_EFFECT_SOURCES.sound_electro_158, SOUND_EFFECT_SOURCES.sound_electro_158]);
        await act(async () => { screen.tree.unmount(); });
    });

    it('plays attention while a question is pending and waits for the resumed work to finish', async () => {
        const running = createSessionFixture({
            active: true,
            latestTurnId: 'question-turn',
            latestTurnStatus: 'in_progress',
        });
        putSession(running);
        const { SoundEffectsRuntime } = await import('./SoundEffectsRuntime');
        const { notifyActivityAgentRequest, notifyActivityReady } = await import('@/activity/notifications/runtime/activityLocalNotificationBus');
        const screen = await renderScreen(<SoundEffectsRuntime />);

        await act(async () => {
            putSession({ ...running, pendingUserActionRequestCount: 1 });
            notifyActivityAgentRequest({ sessionId: running.id, requestId: 'q1', requestKind: 'user_action', toolName: 'AskUserQuestion', toolArgs: {} });
            notifyActivityReady(running.id, [], 7);
            putSession({ ...running, pendingUserActionRequestCount: 1, latestTurnStatus: 'completed' });
        });
        await flushPlayback();
        const attention = SOUND_EFFECT_SOURCES['sound_electro_swell-taps'];
        expect(audio.played).toEqual([attention]);

        await act(async () => {
            putSession({ ...running, pendingUserActionRequestCount: 0, latestTurnStatus: 'completed' });
            putSession({ ...running, pendingUserActionRequestCount: 0, latestTurnId: 'follow-up', latestTurnStatus: 'in_progress' });
        });
        await flushPlayback();
        expect(audio.played).toEqual([attention]);

        await act(async () => {
            putSession({ ...running, latestTurnId: 'follow-up', latestTurnStatus: 'completed' });
        });
        await flushPlayback();
        expect(audio.played).toEqual([attention, SOUND_EFFECT_SOURCES['sound_electro_windows-ish1']]);

        // Late ready markers and repeated status snapshots cannot replay the same completion.
        await act(async () => {
            notifyActivityReady(running.id, [], 12);
            putSession({ ...running, seq: 13, latestTurnId: 'follow-up', latestTurnStatus: 'completed' });
        });
        await flushPlayback();
        expect(audio.played).toEqual([attention, SOUND_EFFECT_SOURCES['sound_electro_windows-ish1']]);
        await act(async () => { screen.tree.unmount(); });
    });

    it('uses live list-row outcomes for hidden sessions and stays silent on cancellation', async () => {
        const running = createSessionFixture({ latestTurnId: 'turn-1', latestTurnStatus: 'in_progress' });
        putSession(running);
        const updateListRow = (session: typeof running) => {
            getStorage().setState({ sessionListRenderables: { [session.id]: buildSessionListRenderableFromSession(session) } });
        };
        updateListRow(running);
        const { SoundEffectsRuntime } = await import('./SoundEffectsRuntime');
        const screen = await renderScreen(<SoundEffectsRuntime />);

        await act(async () => { updateListRow({ ...running, latestTurnStatus: 'cancelled' }); });
        await flushPlayback();
        expect(audio.played).toEqual([]);

        const nextTurn = { ...running, latestTurnId: 'turn-2' };
        await act(async () => {
            updateListRow(nextTurn);
            updateListRow({ ...nextTurn, latestTurnStatus: 'completed' });
        });
        await flushPlayback();
        expect(audio.played).toEqual([SOUND_EFFECT_SOURCES['sound_electro_windows-ish1']]);
        await act(async () => { screen.tree.unmount(); });
    });

    it('does not replay failures that were already present when the app started', async () => {
        putSession(createSessionFixture({ id: 'session-1', latestTurnStatus: 'failed', lastRuntimeIssue: failure }));
        const { SoundEffectsRuntime } = await import('./SoundEffectsRuntime');
        const screen = await renderScreen(<SoundEffectsRuntime />);

        await act(async () => {
            putSession(createSessionFixture({ id: 'session-1', latestTurnStatus: 'failed', lastRuntimeIssue: failure, seq: 2 }));
        });
        await flushPlayback();
        expect(audio.played).toEqual([]);

        await act(async () => {
            putSession(createSessionFixture({
                id: 'session-1',
                latestTurnStatus: 'failed',
                lastRuntimeIssue: { ...failure, occurredAt: 9_000 },
                seq: 3,
            }));
        });
        await flushPlayback();
        expect(audio.played).toEqual([SOUND_EFFECT_SOURCES.sound_electro_158]);
        await act(async () => { screen.tree.unmount(); });
    });

    it('plays the resume sound when a session continues after a usage limit', async () => {
        const usageLimit: SessionRuntimeIssueV1 = { ...failure, code: 'usage_limit', source: 'usage_limit' };
        // Limits are often hours long, so the app may only learn of the block on startup.
        putSession(createSessionFixture({ id: 'limited', latestTurnStatus: 'failed', lastRuntimeIssue: usageLimit }));
        putSession(createSessionFixture({ id: 'crashed', latestTurnStatus: 'failed', lastRuntimeIssue: failure }));
        const { SoundEffectsRuntime } = await import('./SoundEffectsRuntime');
        const screen = await renderScreen(<SoundEffectsRuntime />);

        await act(async () => {
            putSession(createSessionFixture({ id: 'crashed', latestTurnStatus: 'failed', lastRuntimeIssue: failure, thinking: true }));
        });
        await flushPlayback();
        expect(audio.played).toEqual([]);

        await act(async () => {
            putSession(createSessionFixture({ id: 'limited', latestTurnStatus: 'failed', lastRuntimeIssue: usageLimit, thinking: true }));
        });
        await act(async () => {
            putSession(createSessionFixture({ id: 'limited', latestTurnStatus: 'in_progress', lastRuntimeIssue: usageLimit, thinking: true }));
        });
        await flushPlayback();
        expect(audio.played).toEqual([SOUND_EFFECT_SOURCES.sound_electro_pop1]);
        await act(async () => { screen.tree.unmount(); });
    });

    it('obeys Do Not Disturb and silent ringer modes on Android', async () => {
        quietMode.active = true;
        const { SoundEffectsRuntime } = await import('./SoundEffectsRuntime');
        const { notifyActivityAgentRequest } = await import('@/activity/notifications/runtime/activityLocalNotificationBus');
        const screen = await renderScreen(<SoundEffectsRuntime />);

        await act(async () => {
            notifyActivityAgentRequest({ sessionId: 'session-1', requestId: 'r1', requestKind: 'permission', toolName: 'Bash', toolArgs: {} });
        });
        await flushPlayback();

        expect(audio.played).toEqual([]);
        await act(async () => { screen.tree.unmount(); });
    });
});
