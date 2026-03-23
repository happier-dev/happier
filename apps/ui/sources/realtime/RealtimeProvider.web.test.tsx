import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/voice/session/VoiceSessionRuntime', () => ({
  VoiceSessionRuntime: () => React.createElement('VoiceSessionRuntimeMock', null),
}));

vi.mock('./RealtimeVoiceSession', () => ({
  RealtimeVoiceSession: () => React.createElement('RealtimeVoiceSessionMock', null),
}));

describe('RealtimeProvider.web', () => {
  it('mounts VoiceSessionRuntime so voice adapters are registered on web', async () => {
    const { RealtimeProvider } = await import('./RealtimeProvider.web');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(React.createElement(RealtimeProvider, null, React.createElement('Child', null)))).tree;

    await act(async () => {});

    expect(tree.root.findAllByType('VoiceSessionRuntimeMock' as any).length).toBe(1);
  });
});
