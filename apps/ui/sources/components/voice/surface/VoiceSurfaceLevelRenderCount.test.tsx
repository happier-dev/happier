import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import type { VoiceRuntimeLevelWriter } from '@/voice/runtime/levels/voiceRuntimeLevelStore';
import { installVoiceSurfaceCommonModuleMocks } from './voiceSurfaceTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createHostComponentMock(type: string) {
    return (props: any) => React.createElement(type, props, props.children);
}

// Counts the memoized leaf *inside* the surface boundary. A wrapper above
// `VoiceSurface` never observes child commits and is therefore not a render oracle.
const renderCounter = { current: 0 };
const broadAudioSubscriptionCanary = vi.hoisted(() => ({ enabled: false }));
const voiceSettingState = vi.hoisted(() => ({
    current: {
        providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
        ui: { activityFeedEnabled: false, scopeDefault: 'global', surfaceLocation: 'auto' },
    },
}));

installVoiceSurfaceCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Text: 'Text',
            Pressable: createHostComponentMock('Pressable'),
            ScrollView: 'ScrollView',
            Platform: { OS: 'web', select: (spec: any) => spec?.web ?? spec?.default },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            // The real surface fails closed for an absent Voice setting. The
            // probe must mount an actual visible surface, not count a null
            // return above it.
            useSetting: (key: string) => key === 'voice' ? voiceSettingState.current : undefined,
        });
    },
    unistyles: async () => {
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
    },
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: createHostComponentMock('Ionicons') }));
vi.mock('@/components/ui/status/StatusDot', () => ({ StatusDot: createHostComponentMock('StatusDot') }));
vi.mock('./VoiceSurfaceView', async () => {
    const { voiceRuntimeLevelStore } = await import('@/voice/runtime/levels/voiceRuntimeLevelStore');
    return {
        VoiceSurfaceView: React.memo(function CountedVoiceSurfaceView(props: any) {
            /*
             * Oracle canary, not production behavior. If a future surface leaks
             * the frame-rate meter back onto its React path, this same counted
             * leaf must commit for each sample. Keeping it in the leaf makes the
             * test falsifiable; the former wrapper could not observe that fault.
             */
            const outputLevel = React.useSyncExternalStore(
                React.useCallback(
                    (listener) => broadAudioSubscriptionCanary.enabled
                        ? voiceRuntimeLevelStore.subscribe('output', listener)
                        : () => {},
                    [],
                ),
                React.useCallback(
                    () => broadAudioSubscriptionCanary.enabled
                        ? voiceRuntimeLevelStore.getSnapshot().outputLevel
                        : 0,
                    [],
                ),
                () => 0,
            );
            renderCounter.current += 1;
            return React.createElement('VoiceSurfaceView', {
                ...props,
                // Including the value only under the canary makes this exactly
                // the plausible bad shape: a meter value entered the view model.
                ...(broadAudioSubscriptionCanary.enabled ? { outputLevel } : {}),
            });
        }),
    };
});

const featureEnabledState: Record<string, boolean> = { 'voice.agent': true };
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureEnabledState[featureId] ?? true,
}));

describe('VoiceSurface audio-level render budget', () => {
    beforeEach(() => {
        renderCounter.current = 0;
        broadAudioSubscriptionCanary.enabled = false;
        // Keep the mocked leaf and the driven store on one module instance.
        // `vi.resetModules()` clears the store used by the test while retaining
        // this mock's factory result, which makes a canary subscribe to an old
        // store and turns the negative control into a false pass.
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
        const { VoiceSurface } = await import('./VoiceSurface');
        const screen = await renderScreen(React.createElement(VoiceSurface, { variant: 'sidebar' }));
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
});
