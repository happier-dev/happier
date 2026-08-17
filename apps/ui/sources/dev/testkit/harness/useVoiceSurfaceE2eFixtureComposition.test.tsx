import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '../cleanup/standardCleanup';
import { flushHookEffects } from '../hooks/flushHookEffects';
import { renderHook } from '../hooks/renderHook';
import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';
import { getStorage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { selectSessionViewShellSessionForRouteState } from '@/components/sessions/shell/sessionViewStableSession';
import {
    readLocalConversationVoiceSettings,
    readVoiceProviderSettingsConfig,
} from '@/sync/domains/settings/voiceSettings';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { voiceConversationBindingResolver } from '@/voice/binding/VoiceConversationBindingResolver';
import { getVoiceSessionSnapshot } from '@/voice/session/voiceSessionStore';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { selectVoiceTranscriptEntriesForConversationSession } from '@/voice/transcript/voiceTranscriptSelectors';

const localSearchParamsState = vi.hoisted(() => ({
    current: { happier_voice_e2e_fixture: 'sidebar_hidden_conversation' as string | string[] | undefined },
}));

const getServerFeaturesSnapshotSpy = vi.hoisted(() =>
    vi.fn(async (_params: unknown) => ({
        status: 'ready' as const,
        features: buildServerFeaturesResponse({ voiceEnabled: true }),
    })),
);

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await vi.importActual<typeof import('@/dev/testkit/mocks/router')>(
        '@/dev/testkit/mocks/router',
    );
    return createExpoRouterMock({
        params: () => localSearchParamsState.current as Record<string, string | string[] | undefined>,
    }).module;
});

vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
    getServerFeaturesSnapshot: (params: unknown) => getServerFeaturesSnapshotSpy(params),
}));

const initialStorageState = getStorage().getState();
const initialVoiceTargetState = useVoiceTargetStore.getState();
const initialBindingState = voiceSessionBindingStore.getState();
const initialDev = (globalThis as { __DEV__?: boolean }).__DEV__;
const initialExpoPublicDebug = process.env.EXPO_PUBLIC_DEBUG;

describe('useVoiceSurfaceE2eFixtureComposition', () => {
    beforeEach(() => {
        getStorage().setState(initialStorageState, true);
        useVoiceTargetStore.setState(initialVoiceTargetState, true);
        voiceSessionBindingStore.setState(initialBindingState, true);
        (globalThis as { __DEV__?: boolean }).__DEV__ = true;
        getServerFeaturesSnapshotSpy.mockClear();
        localSearchParamsState.current = { happier_voice_e2e_fixture: 'sidebar_hidden_conversation' };
        globalThis.localStorage?.removeItem('happier.voice.e2e.fixture');
        process.env.EXPO_PUBLIC_DEBUG = initialExpoPublicDebug;
    });

    afterEach(() => {
        vi.useRealTimers();
        standardCleanup();
        getStorage().setState(initialStorageState, true);
        useVoiceTargetStore.setState(initialVoiceTargetState, true);
        voiceSessionBindingStore.setState(initialBindingState, true);
        if (initialDev === undefined) {
            delete (globalThis as { __DEV__?: boolean }).__DEV__;
        } else {
            (globalThis as { __DEV__?: boolean }).__DEV__ = initialDev;
        }
        process.env.EXPO_PUBLIC_DEBUG = initialExpoPublicDebug;
        globalThis.localStorage?.removeItem('happier.voice.e2e.fixture');
    });

    it('hydrates the live feature gates and voice settings needed by the sidebar shell fixture', async () => {
        const { useVoiceSurfaceE2eFixtureComposition } = await import('./useVoiceSurfaceE2eFixtureComposition');

        const harness = await renderHook(() => {
            useVoiceSurfaceE2eFixtureComposition();
            return null;
        });

        await flushHookEffects({ cycles: 6, turns: 4 });

        const settings = getStorage().getState().settings;
        expect(settings.experiments).toBe(true);
        expect(settings.featureToggles.voice).toBe(true);
        expect(settings.featureToggles['execution.runs']).toBe(true);
        expect(settings.featureToggles['voice.agent']).toBe(true);
        expect(settings.voice.providerId).toBe('happier.voice.elevenlabs/realtime-elevenlabs');
        expect(readVoiceProviderSettingsConfig(settings.voice, 'happier.voice.elevenlabs/realtime-elevenlabs')?.billingMode).toBe('byo');
        expect(settings.voice.providers['happier.voice.elevenlabs/realtime-elevenlabs']).toMatchObject({
            schemaVersion: 2,
            config: expect.objectContaining({ billingMode: 'byo' }),
        });
        expect(Object.keys(settings.voice)).not.toContain('adapters');
        expect(settings.voice.ui?.activityFeedEnabled).toBe(true);
        expect(
            voiceConversationBindingResolver.resolveByControlSessionId({
                controlSessionId: '__voice_agent__',
                adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
            }),
        ).toMatchObject({
            conversationSessionId: 'voice-e2e-hidden-conversation',
            targetSessionId: 'voice-e2e-root-session',
        });
        expect(
            voiceSessionBindingStore.getState().getByControlSessionId('__voice_agent__'),
        ).toMatchObject({
            conversationSessionId: 'voice-e2e-hidden-conversation',
            targetSessionId: 'voice-e2e-root-session',
        });
        expect(
            selectVoiceTranscriptEntriesForConversationSession(
                getStorage().getState(),
                'voice-e2e-hidden-conversation',
            ).map((entry) => entry.text),
        ).toEqual(['first', 'second']);

        expect(useVoiceTargetStore.getState().scope).toBe('global');
        expect(getVoiceSessionSnapshot()).toMatchObject({
            adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
            sessionId: '__voice_agent__',
            status: 'connected',
            mode: 'idle',
            canStop: true,
        });
        expect(getServerFeaturesSnapshotSpy).toHaveBeenCalledWith({ force: true });

        await harness.unmount();
    });

    it('reinstalls the hidden conversation transcript if later runtime resets clear it', async () => {
        vi.useFakeTimers();
        const { useVoiceSurfaceE2eFixtureComposition } = await import('./useVoiceSurfaceE2eFixtureComposition');

        const harness = await renderHook(() => {
            useVoiceSurfaceE2eFixtureComposition();
            return null;
        });

        await flushHookEffects({ cycles: 6, turns: 4 });

        getStorage().setState((state) => ({
            ...state,
            sessionMessages: {},
        }));

        expect(
            selectVoiceTranscriptEntriesForConversationSession(
                getStorage().getState(),
                'voice-e2e-hidden-conversation',
            ),
        ).toEqual([]);

        await flushHookEffects({ cycles: 6, turns: 4 });
        await vi.advanceTimersByTimeAsync(400);
        await flushHookEffects({ cycles: 4, turns: 2 });

        expect(
            selectVoiceTranscriptEntriesForConversationSession(
                getStorage().getState(),
                'voice-e2e-hidden-conversation',
            ).map((entry) => entry.text),
        ).toEqual(['first', 'second']);

        await harness.unmount();
    });

    it('repairs hidden fixture sessions with the active server scope required by the session route', async () => {
        vi.useFakeTimers();
        const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
        expect(activeServerId).not.toBe('');
        const { useVoiceSurfaceE2eFixtureComposition } = await import('./useVoiceSurfaceE2eFixtureComposition');

        const harness = await renderHook(() => {
            useVoiceSurfaceE2eFixtureComposition();
            return null;
        });

        await flushHookEffects({ cycles: 6, turns: 4 });

        getStorage().setState((state) => ({
            ...state,
            sessions: {
                ...state.sessions,
                'voice-e2e-root-session': {
                    ...state.sessions['voice-e2e-root-session'],
                    serverId: undefined,
                },
                'voice-e2e-hidden-conversation': {
                    ...state.sessions['voice-e2e-hidden-conversation'],
                    serverId: undefined,
                },
            },
        }));

        expect(selectSessionViewShellSessionForRouteState(
            getStorage().getState(),
            'voice-e2e-hidden-conversation',
            activeServerId,
        )).toBeNull();

        await flushHookEffects({ cycles: 6, turns: 4 });
        await vi.advanceTimersByTimeAsync(400);
        await flushHookEffects({ cycles: 4, turns: 2 });

        const repairedState = getStorage().getState();
        expect(repairedState.sessions['voice-e2e-root-session']?.serverId).toBe(activeServerId);
        expect(repairedState.sessions['voice-e2e-hidden-conversation']?.serverId).toBe(activeServerId);
        expect(selectSessionViewShellSessionForRouteState(
            repairedState,
            'voice-e2e-hidden-conversation',
            activeServerId,
        )).not.toBeNull();

        await harness.unmount();
    });

    it('falls back to the persisted localStorage fixture marker when auth navigation strips the route query param', async () => {
        localSearchParamsState.current = { happier_voice_e2e_fixture: undefined };
        globalThis.localStorage?.setItem('happier.voice.e2e.fixture', 'sidebar_hidden_conversation');

        const { useVoiceSurfaceE2eFixtureComposition } = await import('./useVoiceSurfaceE2eFixtureComposition');

        const harness = await renderHook(() => {
            useVoiceSurfaceE2eFixtureComposition();
            return null;
        });

        await flushHookEffects({ cycles: 6, turns: 4 });

        expect(
            selectVoiceTranscriptEntriesForConversationSession(
                getStorage().getState(),
                'voice-e2e-hidden-conversation',
            ).map((entry) => entry.text),
        ).toEqual(['first', 'second']);

        await harness.unmount();
    });

    it('installs the explicit fixture even when __DEV__ is false', async () => {
        (globalThis as { __DEV__?: boolean }).__DEV__ = false;
        process.env.EXPO_PUBLIC_DEBUG = '1';
        localSearchParamsState.current = { happier_voice_e2e_fixture: 'sidebar_hidden_conversation' };

        const { useVoiceSurfaceE2eFixtureComposition } = await import('./useVoiceSurfaceE2eFixtureComposition');

        const harness = await renderHook(() => {
            useVoiceSurfaceE2eFixtureComposition();
            return null;
        });

        await flushHookEffects({ cycles: 6, turns: 4 });

        expect(
            selectVoiceTranscriptEntriesForConversationSession(
                getStorage().getState(),
                'voice-e2e-hidden-conversation',
            ).map((entry) => entry.text),
        ).toEqual(['first', 'second']);

        await harness.unmount();
    });

    it('can install a recoverable realtime disconnect fixture for the sidebar web surface', async () => {
        localSearchParamsState.current = { happier_voice_e2e_fixture: 'realtime_recoverable_disconnect' };

        const { useVoiceSurfaceE2eFixtureComposition } = await import('./useVoiceSurfaceE2eFixtureComposition');

        const harness = await renderHook(() => {
            useVoiceSurfaceE2eFixtureComposition();
            return null;
        });

        await flushHookEffects({ cycles: 6, turns: 4 });

        expect(getVoiceSessionSnapshot()).toMatchObject({
            adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
            sessionId: '__voice_agent__',
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        });
        expect(
            selectVoiceTranscriptEntriesForConversationSession(
                getStorage().getState(),
                'voice-e2e-hidden-conversation',
            ).map((entry) => entry.text),
        ).toEqual(['first', 'second']);

        await harness.unmount();
    });

    it('can install a local auto-return listening fixture for the sidebar web surface', async () => {
        vi.useFakeTimers();
        localSearchParamsState.current = { happier_voice_e2e_fixture: 'local_auto_return_listening' };

        const { useVoiceSurfaceE2eFixtureComposition } = await import('./useVoiceSurfaceE2eFixtureComposition');

        const harness = await renderHook(() => {
            useVoiceSurfaceE2eFixtureComposition();
            return null;
        });

        await flushHookEffects({ cycles: 6, turns: 4 });

        expect(getStorage().getState().settings.voice.providerId).toBe('local_conversation');
        expect(readLocalConversationVoiceSettings(getStorage().getState().settings.voice).conversationMode).toBe('agent');
        expect(getStorage().getState().settings.voice.providers.local_conversation).toMatchObject({
            schemaVersion: 1,
            config: expect.objectContaining({ conversationMode: 'agent' }),
        });
        const initialSnapshot = getVoiceSessionSnapshot();
        expect(initialSnapshot).toMatchObject({
            adapterId: 'local_conversation',
            sessionId: '__voice_agent__',
            status: 'connected',
            canStop: true,
        });
        // The fixture can advance quickly depending on timer/microtask ordering; assert only stable lifecycle state here.
        expect(['transcribing', 'listening']).toContain(initialSnapshot.mode);

        await vi.advanceTimersByTimeAsync(400);
        await flushHookEffects({ cycles: 4, turns: 2 });

        expect(getVoiceSessionSnapshot()).toMatchObject({
            adapterId: 'local_conversation',
            sessionId: '__voice_agent__',
            status: 'connected',
            mode: 'listening',
            canStop: true,
        });

        await harness.unmount();
    });

    it('can install a welcome resume persistence fixture without duplicating the persisted welcome transcript', async () => {
        vi.useFakeTimers();
        localSearchParamsState.current = { happier_voice_e2e_fixture: 'welcome_resume_persistence' };

        const { useVoiceSurfaceE2eFixtureComposition } = await import('./useVoiceSurfaceE2eFixtureComposition');

        const harness = await renderHook(() => {
            useVoiceSurfaceE2eFixtureComposition();
            return null;
        });

        await flushHookEffects({ cycles: 6, turns: 4 });

        expect(
            selectVoiceTranscriptEntriesForConversationSession(
                getStorage().getState(),
                'voice-e2e-hidden-conversation',
            ).map((entry) => entry.text),
        ).toEqual(['Welcome back']);
        expect((getStorage().getState().sessions as Record<string, any>)['voice-e2e-hidden-conversation']?.metadata).toMatchObject({
            voiceAgentRunV1: {
                transcriptContractVersion: 2,
                welcomedEpoch: 1,
            },
        });

        getStorage().setState((state) => ({
            ...state,
            sessionMessages: {},
        }));
        await flushHookEffects({ cycles: 6, turns: 4 });
        await vi.advanceTimersByTimeAsync(400);
        await flushHookEffects({ cycles: 4, turns: 2 });

        expect(
            selectVoiceTranscriptEntriesForConversationSession(
                getStorage().getState(),
                'voice-e2e-hidden-conversation',
            ).map((entry) => entry.text),
        ).toEqual(['Welcome back']);

        await harness.unmount();
    });

    it('can install a daemon inference web fallback parity fixture for the sidebar web surface', async () => {
        localSearchParamsState.current = { happier_voice_e2e_fixture: 'daemon_inference_web_fallback_parity' };

        const { useVoiceSurfaceE2eFixtureComposition } = await import('./useVoiceSurfaceE2eFixtureComposition');

        const harness = await renderHook(() => {
            useVoiceSurfaceE2eFixtureComposition();
            return null;
        });

        await flushHookEffects({ cycles: 6, turns: 4 });

        expect(getStorage().getState().settings).toMatchObject({
            experiments: true,
            featureToggles: expect.objectContaining({
                voice: true,
                'execution.runs': true,
                'voice.agent': true,
                'voice.daemonInference': true,
            }),
            voice: expect.objectContaining({
                providerId: 'local_conversation',
                providers: expect.objectContaining({
                    local_conversation: expect.objectContaining({
                        schemaVersion: 1,
                        config: expect.objectContaining({
                            tts: expect.objectContaining({
                                provider: 'local_neural',
                                localNeural: expect.objectContaining({
                                    execution: 'device',
                                }),
                            }),
                        }),
                    }),
                }),
            }),
        });
        expect(
            selectVoiceTranscriptEntriesForConversationSession(
                getStorage().getState(),
                'voice-e2e-hidden-conversation',
            ).map((entry) => entry.text),
        ).toEqual(['first', 'second']);

        await harness.unmount();
    });

    it('can install a cancel-during-assistant-speech fixture for the local sidebar surface', async () => {
        localSearchParamsState.current = { happier_voice_e2e_fixture: 'cancel_during_assistant_speech' };

        const { useVoiceSurfaceE2eFixtureComposition } = await import('./useVoiceSurfaceE2eFixtureComposition');

        const harness = await renderHook(() => {
            useVoiceSurfaceE2eFixtureComposition();
            return null;
        });

        await flushHookEffects({ cycles: 6, turns: 4 });

        expect(getVoiceSessionSnapshot()).toMatchObject({
            adapterId: 'local_conversation',
            sessionId: '__voice_agent__',
            status: 'connected',
            mode: 'speaking',
            canStop: true,
        });

        await harness.unmount();
    });

    it('cannot intercept cancellation from a production query marker', async () => {
        (globalThis as { __DEV__?: boolean }).__DEV__ = false;
        process.env.EXPO_PUBLIC_DEBUG = '0';
        localSearchParamsState.current = { happier_voice_e2e_fixture: 'cancel_during_assistant_speech' };
        const before = getVoiceSessionSnapshot();
        const settingsBefore = getStorage().getState().settings;
        const targetBefore = useVoiceTargetStore.getState();
        const bindingBefore = voiceSessionBindingStore.getState();
        const { useVoiceSurfaceE2eFixtureComposition } = await import('./useVoiceSurfaceE2eFixtureComposition');

        const harness = await renderHook(() => useVoiceSurfaceE2eFixtureComposition());
        try {
            await flushHookEffects({ cycles: 2, turns: 2 });

            expect(harness.getCurrent().shouldSuppressOnboarding).toBe(false);
            expect(getVoiceSessionSnapshot()).toEqual(before);
            expect(getStorage().getState().settings).toEqual(settingsBefore);
            expect(useVoiceTargetStore.getState()).toEqual(targetBefore);
            expect(voiceSessionBindingStore.getState()).toEqual(bindingBefore);
        } finally {
            await harness.unmount();
        }
    });

    it('cannot mutate voice state or suppress onboarding from a production localStorage marker', async () => {
        (globalThis as { __DEV__?: boolean }).__DEV__ = false;
        process.env.EXPO_PUBLIC_DEBUG = '0';
        localSearchParamsState.current = { happier_voice_e2e_fixture: undefined };
        globalThis.localStorage?.setItem('happier.voice.e2e.fixture', 'cancel_during_assistant_speech');
        const before = getVoiceSessionSnapshot();
        const settingsBefore = getStorage().getState().settings;
        const targetBefore = useVoiceTargetStore.getState();
        const bindingBefore = voiceSessionBindingStore.getState();
        const { useVoiceSurfaceE2eFixtureComposition } = await import('./useVoiceSurfaceE2eFixtureComposition');

        const harness = await renderHook(() => useVoiceSurfaceE2eFixtureComposition());
        try {
            await flushHookEffects({ cycles: 2, turns: 2 });

            expect(harness.getCurrent().shouldSuppressOnboarding).toBe(false);
            expect(getVoiceSessionSnapshot()).toEqual(before);
            expect(getStorage().getState().settings).toEqual(settingsBefore);
            expect(useVoiceTargetStore.getState()).toEqual(targetBefore);
            expect(voiceSessionBindingStore.getState()).toEqual(bindingBefore);
        } finally {
            await harness.unmount();
        }
    });
});
