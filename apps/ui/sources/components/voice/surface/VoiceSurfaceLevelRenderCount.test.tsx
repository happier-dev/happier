import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { installVoiceSurfaceCommonModuleMocks } from './voiceSurfaceTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createHostComponentMock(type: string) {
    return (props: any) => React.createElement(type, props, props.children);
}

// A render counter that wraps the surface and increments on every React render.
const renderCounter = { current: 0 };

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

const featureEnabledState: Record<string, boolean> = { 'voice.agent': true };
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureEnabledState[featureId] ?? true,
}));

describe('VoiceSurface audio-level render budget', () => {
    beforeEach(() => {
        renderCounter.current = 0;
        vi.resetModules();
    });

    it('does not re-render the surface tree when the audio level is driven at frame rate', async () => {
        const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
        setVoiceSessionSnapshot({
            adapterId: 'realtime_elevenlabs',
            sessionId: 's1',
            status: 'connected',
            mode: 'speaking',
            canStop: true,
        });

        const { voiceRuntimeLevelStore } = await import('@/voice/runtime/levels/voiceRuntimeLevelStore');
        const { VoiceSurface } = await import('./VoiceSurface');

        function CountedSurface(props: { variant: 'sidebar' }) {
            renderCounter.current += 1;
            return React.createElement(VoiceSurface, props);
        }

        const screen = await renderScreen(React.createElement(CountedSurface, { variant: 'sidebar' }));
        const baseline = renderCounter.current;
        expect(baseline).toBeGreaterThan(0);
        const writer = voiceRuntimeLevelStore.open({ channel: 'output', sourceId: 'test-output' });

        await act(async () => {
            for (let i = 0; i < 300; i += 1) {
                writer.write((i % 50) / 50);
            }
        });

        expect(renderCounter.current).toBe(baseline);
        writer.close();

        await act(async () => {
            screen.tree.unmount();
        });
    });
});
