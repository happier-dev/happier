import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

type SearchParams = { id?: string };
let searchParams: SearchParams = {};

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('expo-router', () => ({
    useLocalSearchParams: () => searchParams,
}));

vi.mock('@react-navigation/native', () => ({
    useRoute: () => {
        throw new Error('session/[id] screen should not depend on react-navigation useRoute() in expo-router web');
    },
}));

vi.mock('@/components/sessions/shell/SessionView', () => ({
    SessionView: ({ id, jumpToSeq }: { id: string; jumpToSeq?: number | null }) =>
        React.createElement('SessionView', { id, jumpToSeq }),
}));

describe('session/[id] param parsing', () => {
  it('renders the session view using expo-router search params', async () => {
        vi.resetModules();
        searchParams = { id: 'session-123' };

        const Screen = (await import('./[id]')).default;
        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(Screen));
        });

    const sessionView = tree!.root.findByType('SessionView');
    expect(sessionView.props.id).toBe('session-123');
  });

  it('passes jumpSeq through to SessionView as jumpToSeq', async () => {
    vi.resetModules();
    searchParams = { id: 'session-123', jumpSeq: '42' } as any;

    const Screen = (await import('./[id]')).default;
    let tree: renderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = renderer.create(React.createElement(Screen));
    });

    const sessionView = tree!.root.findByType('SessionView');
    expect(sessionView.props.jumpToSeq).toBe(42);
  });
});
