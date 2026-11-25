import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { voiceRuntimeLevelStore } from '@/voice/runtime/levels/voiceRuntimeLevelStore';
import type { VoiceRuntimeLevelWriter } from '@/voice/runtime/levels/voiceRuntimeLevelStore';
import { getPreferredLanguage, preloadTranslations, setPreferredLanguageFromSettings } from '@/text';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Counts the memoized leaf *inside* the surface boundary. A wrapper above
// `VoiceSurface` never observes child commits and is therefore not a render oracle.
const renderCounter = { current: 0 };
const broadAudioSubscriptionCanary = { enabled: false };

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ View: 'View', Text: 'Text', Pressable: 'Pressable', ScrollView: 'ScrollView' });
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                status: { connecting: '#00f', connected: '#0f0', error: '#f00', default: '#999' },
                surface: '#fff',
                text: '#000',
                textSecondary: '#555',
            },
        },
    });
});

const { useVoiceSurfaceModel } = await import('./useVoiceSurfaceModel');
const { VoiceSurfaceView } = await import('./VoiceSurfaceView');
const { getStorage } = await import('@/sync/domains/state/storage');
const { voiceSettingsParse } = await import('@/sync/domains/settings/voiceSettings');
const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
const { projectLocalVoiceCapturePartial, clearLocalVoiceCapturePartial } = await import('@/voice/transcript/voiceConversationTranscript');
const { resetVoiceActivityFeedExpansionForTests, setVoiceActivityFeedExpanded } = await import('./voiceActivityFeedExpansionStore');
const initialStorageState = getStorage().getState();
const previousLanguage = getPreferredLanguage();

function AudioSubscriptionCanary() {
    const level = React.useSyncExternalStore(
        React.useCallback((listener) => voiceRuntimeLevelStore.subscribe('output', listener), []),
        () => voiceRuntimeLevelStore.getSnapshot().outputLevel,
        () => 0,
    );
    return <span>{level}</span>;
}

function VoiceSurfaceModelProbe() {
    const model = useVoiceSurfaceModel({ variant: 'sidebar' });
    // Profiler sees commits inside the real presentation subtree, including a
    // descendant subscription that a render counter above the view would miss.
    return model ? <React.Profiler id="voice-surface" onRender={() => { renderCounter.current += 1; }}>
        <VoiceSurfaceView model={model} />
        {broadAudioSubscriptionCanary.enabled ? <AudioSubscriptionCanary /> : null}
    </React.Profiler> : null;
}

describe('Voice surface model audio-level render budget', () => {
    beforeEach(async () => {
        await preloadTranslations('en');
        setPreferredLanguageFromSettings('en');
        getStorage().setState(initialStorageState, true);
        getStorage().setState({
            settings: {
                ...initialStorageState.settings,
                voice: voiceSettingsParse({
                    providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
                    ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
                }),
            },
        });
        renderCounter.current = 0;
        broadAudioSubscriptionCanary.enabled = false;
    });

    afterEach(() => {
        standardCleanup();
        clearLocalVoiceCapturePartial();
        resetVoiceActivityFeedExpansionForTests();
        getStorage().setState(initialStorageState, true);
        setPreferredLanguageFromSettings(previousLanguage);
    });

    async function renderSurface() {
        const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
        setVoiceSessionSnapshot({
            adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
            sessionId: 's1',
            status: 'connected',
            mode: 'speaking',
            canStop: true,
        });

        const { voiceRuntimeLevelStore } = await import('@/voice/runtime/levels/voiceRuntimeLevelStore');
        const screen = await renderScreen(<VoiceSurfaceModelProbe />);
        return { screen, setVoiceSessionSnapshot, voiceRuntimeLevelStore };
    }

    function writeOutputLevels(writer: VoiceRuntimeLevelWriter): void {
        // The approved M1 probe uses 100 distinct samples. This is deliberately
        // not one bulk `act`: each sample needs its own React commit boundary so
        // a broad subscription cannot be hidden by batching.
        for (let i = 0; i < 100; i += 1) {
            // Each write has its own commit boundary. The level-store write is
            // synchronous, so an async act only adds an event-loop turn per
            // sample without making the oracle more discriminating.
            act(() => {
                writer.write((i % 50) / 50);
            });
        }
    }

    it('does not re-render the surface leaf when the audio level is driven at frame rate', async () => {
        const { screen, setVoiceSessionSnapshot, voiceRuntimeLevelStore } = await renderSurface();
        const baseline = renderCounter.current;
        expect(baseline).toBeGreaterThan(0);
        const writer = voiceRuntimeLevelStore.open({ channel: 'output', sourceId: 'test-output' });

        writeOutputLevels(writer);

        expect(renderCounter.current).toBe(baseline);
        act(() => {
            writer.close();
        });

        // Positive control: a real semantic session transition must reach the
        // same leaf, proving this instrumentation can observe a commit.
        await act(async () => {
            setVoiceSessionSnapshot({
                adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
                sessionId: 's1',
                status: 'connected',
                mode: 'listening',
                canStop: true,
            });
        });
        expect(renderCounter.current).toBeGreaterThan(baseline);

        await act(async () => {
            screen.tree.unmount();
        });
    }, 120_000);

    it('fails the same leaf oracle when a frame-rate level leaks into the React view path', async () => {
        broadAudioSubscriptionCanary.enabled = true;
        const { screen, voiceRuntimeLevelStore } = await renderSurface();
        const writer = voiceRuntimeLevelStore.open({ channel: 'output', sourceId: 'bad-test-output' });
        const baselineAfterSourceOpen = renderCounter.current;

        writeOutputLevels(writer);

        // This is the specific wrong implementation the owner test rejects:
        // a React-level output subscription causes the memoized presentation
        // leaf to commit for audio samples rather than staying on shared values.
        expect(renderCounter.current).toBeGreaterThan(baselineAfterSourceOpen);
        act(() => {
            writer.close();
        });
        await act(async () => {
            screen.tree.unmount();
        });
    }, 120_000);

    it('only renders the full transcript when expanded and catches up immediately on reveal', async () => {
        const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
        const providerId = 'local_conversation';
        const carrier = { serverId: 'home', sessionId: 'render-cost-carrier' };
        getStorage().setState(state => ({
            sessions: { ...state.sessions, [carrier.sessionId]: createSessionFixture({
                id: carrier.sessionId, serverId: carrier.serverId,
            }) },
            settings: { ...state.settings, voice: voiceSettingsParse({
                ...state.settings.voice, providerId,
                ui: { ...state.settings.voice.ui, activityFeedEnabled: true, activityFeedAutoExpandOnStart: false },
            }) },
        }));
        voiceSessionBindingStore.getState().bind({
            adapterId: providerId, controlSessionId: 's1', conversationSessionId: carrier.sessionId,
            conversationSessionAddress: carrier, targetSessionAddress: null,
            transcriptMode: 'native_session', updatedAt: Date.now(),
        });
        setVoiceSessionSnapshot({ adapterId: providerId, sessionId: 's1', status: 'connected', mode: 'listening', canStop: true });
        const screen = await renderScreen(<VoiceSurfaceModelProbe />);
        try {
            const baseline = renderCounter.current;
            expect(baseline).toBeGreaterThan(0);
            act(() => projectLocalVoiceCapturePartial(carrier.sessionId, 'One changed partial'));
            expect.soft(renderCounter.current - baseline).toBe(0);
            act(() => setVoiceActivityFeedExpanded(true));
            expect(screen.getTextContent()).toContain('One changed partial');
            const expanded = renderCounter.current;
            act(() => projectLocalVoiceCapturePartial(carrier.sessionId, 'The next changed partial'));
            expect(renderCounter.current - expanded).toBe(1);
            expect(screen.getTextContent()).toContain('The next changed partial');
        } finally {
            await screen.unmount();
        }
    }, 120_000);
});
