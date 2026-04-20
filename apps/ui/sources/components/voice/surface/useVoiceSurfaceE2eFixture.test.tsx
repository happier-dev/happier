import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';
import { getStorage } from '@/sync/domains/state/storage';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { voiceConversationBindingResolver } from '@/voice/binding/VoiceConversationBindingResolver';
import { getVoiceSessionSnapshot } from '@/voice/session/voiceSessionStore';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { selectVoiceTranscriptEntriesForConversationSession } from '@/voice/transcript/voiceTranscriptSelectors';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';

const localSearchParamsState = vi.hoisted(() => ({
    current: { happier_voice_e2e_fixture: 'sidebar_hidden_conversation' as string | string[] | undefined },
}));

const getServerFeaturesSnapshotSpy = vi.hoisted(() =>
    vi.fn(async (_params: unknown) => ({
        status: 'ready' as const,
        features: buildServerFeaturesResponse({ voiceEnabled: true }),
    })),
);

const expoRouterMock = createExpoRouterMock({
    params: () => localSearchParamsState.current as Record<string, string | string[] | undefined>,
});

vi.mock('expo-router', () => expoRouterMock.module);

vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
    getServerFeaturesSnapshot: (params: unknown) => getServerFeaturesSnapshotSpy(params),
}));

const initialStorageState = getStorage().getState();
const initialVoiceTargetState = useVoiceTargetStore.getState();
const initialBindingState = voiceSessionBindingStore.getState();
const initialDev = (globalThis as { __DEV__?: boolean }).__DEV__;
const initialExpoPublicDebug = process.env.EXPO_PUBLIC_DEBUG;

describe('useVoiceSurfaceE2eFixture', () => {
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
        const { useVoiceSurfaceE2eFixture } = await import('./useVoiceSurfaceE2eFixture');

        const harness = await renderHook(() => {
            useVoiceSurfaceE2eFixture();
            return null;
        });

        await flushHookEffects({ cycles: 6, turns: 4 });

        const settings = getStorage().getState().settings;
        expect(settings.experiments).toBe(true);
        expect(settings.featureToggles.voice).toBe(true);
        expect(settings.featureToggles['execution.runs']).toBe(true);
        expect(settings.featureToggles['voice.agent']).toBe(true);
        expect(settings.voice.providerId).toBe('realtime_elevenlabs');
        expect(settings.voice.adapters.realtime_elevenlabs.billingMode).toBe('byo');
        expect(settings.voice.ui?.activityFeedEnabled).toBe(true);
        expect(
            voiceConversationBindingResolver.resolveByControlSessionId({
                controlSessionId: '__voice_agent__',
                adapterId: 'realtime_elevenlabs',
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
            adapterId: 'realtime_elevenlabs',
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
        const { useVoiceSurfaceE2eFixture } = await import('./useVoiceSurfaceE2eFixture');

        const harness = await renderHook(() => {
            useVoiceSurfaceE2eFixture();
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

    it('falls back to the persisted localStorage fixture marker when auth navigation strips the route query param', async () => {
        localSearchParamsState.current = { happier_voice_e2e_fixture: undefined };
        globalThis.localStorage?.setItem('happier.voice.e2e.fixture', 'sidebar_hidden_conversation');

        const { useVoiceSurfaceE2eFixture } = await import('./useVoiceSurfaceE2eFixture');

        const harness = await renderHook(() => {
            useVoiceSurfaceE2eFixture();
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

        const { useVoiceSurfaceE2eFixture } = await import('./useVoiceSurfaceE2eFixture');

        const harness = await renderHook(() => {
            useVoiceSurfaceE2eFixture();
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

        const { useVoiceSurfaceE2eFixture } = await import('./useVoiceSurfaceE2eFixture');

        const harness = await renderHook(() => {
            useVoiceSurfaceE2eFixture();
            return null;
        });

        await flushHookEffects({ cycles: 6, turns: 4 });

        expect(getVoiceSessionSnapshot()).toMatchObject({
            adapterId: 'realtime_elevenlabs',
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

        const { useVoiceSurfaceE2eFixture } = await import('./useVoiceSurfaceE2eFixture');

        const harness = await renderHook(() => {
            useVoiceSurfaceE2eFixture();
            return null;
        });

        await flushHookEffects({ cycles: 6, turns: 4 });

        expect(getStorage().getState().settings.voice.providerId).toBe('local_conversation');
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

        const { useVoiceSurfaceE2eFixture } = await import('./useVoiceSurfaceE2eFixture');

        const harness = await renderHook(() => {
            useVoiceSurfaceE2eFixture();
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

        const { useVoiceSurfaceE2eFixture } = await import('./useVoiceSurfaceE2eFixture');

        const harness = await renderHook(() => {
            useVoiceSurfaceE2eFixture();
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
                adapters: expect.objectContaining({
                    local_conversation: expect.objectContaining({
                        tts: expect.objectContaining({
                            provider: 'local_neural',
                            localNeural: expect.objectContaining({
                                execution: 'device',
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

    it('can install a cancel-during-assistant-speech fixture for the realtime sidebar surface', async () => {
        localSearchParamsState.current = { happier_voice_e2e_fixture: 'cancel_during_assistant_speech' };

        const { useVoiceSurfaceE2eFixture } = await import('./useVoiceSurfaceE2eFixture');

        const harness = await renderHook(() => {
            useVoiceSurfaceE2eFixture();
            return null;
        });

        await flushHookEffects({ cycles: 6, turns: 4 });

        expect(getVoiceSessionSnapshot()).toMatchObject({
            adapterId: 'realtime_elevenlabs',
            sessionId: '__voice_agent__',
            status: 'connected',
            mode: 'speaking',
            canStop: true,
        });

        await harness.unmount();
    });
});
