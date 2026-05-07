import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('RealtimeProvider', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('keeps the app shell mounted when the native realtime voice session module cannot load', async () => {
        vi.doMock('@/voice/session/VoiceSessionRuntime', () => ({
            VoiceSessionRuntime: () => React.createElement('VoiceSessionRuntimeMock', null),
        }));
        vi.doMock('./resolveRealtimeVoiceSessionComponent', () => ({
            resolveRealtimeVoiceSessionComponent: () => null,
        }));

        const { RealtimeProvider } = await import('./RealtimeProvider');
        const screen = await renderScreen(
            React.createElement(RealtimeProvider, null, React.createElement('ChildContent', null)),
        );

        await act(async () => {});

        expect(screen.findAllByType('VoiceSessionRuntimeMock' as any)).toHaveLength(1);
        expect(screen.findAllByType('ChildContent' as any)).toHaveLength(1);
    });
});
