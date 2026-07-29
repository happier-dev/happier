import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('RealtimeProvider', () => {
    it('mounts only the canonical Voice session runtime beside the app shell', async () => {
        vi.doMock('@/voice/session/VoiceSessionRuntime', () => ({
            VoiceSessionRuntime: () => React.createElement('VoiceSessionRuntimeMock', null),
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
