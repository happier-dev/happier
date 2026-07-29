import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/voice/session/VoiceSessionRuntime', () => ({
  VoiceSessionRuntime: () => React.createElement('VoiceSessionRuntimeMock', null),
}));

describe('RealtimeProvider.web', () => {
  it('mounts VoiceSessionRuntime so voice adapters are registered on web', async () => {
    const { RealtimeProvider } = await import('./RealtimeProvider.web');

    const screen = await renderScreen(React.createElement(RealtimeProvider, null, React.createElement('Child', null)));

    await act(async () => {});

    expect(screen.findAllByType('VoiceSessionRuntimeMock' as any)).toHaveLength(1);
    expect(screen.findAllByType('Child' as any)).toHaveLength(1);
  });
});
