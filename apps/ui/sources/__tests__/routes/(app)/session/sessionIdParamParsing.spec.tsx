import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

type SearchParams = { id?: string; jumpSeq?: string };
let searchParams: SearchParams = {};
const ensureSessionVisibleSpy = vi.fn((_sessionId: string) => Promise.resolve());
let hydrateReady = true;

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const stub = await import('@/dev/reactNativeStub');
    return {
        ...stub,
        Platform: { ...stub.Platform, OS: 'web' },
        View: (props: any) => React.createElement('View', props, props.children),
    };
});

vi.mock('expo-router', () => ({
    useLocalSearchParams: () => searchParams,
}));

vi.mock('@react-navigation/native', () => ({
    useRoute: () => {
        throw new Error('session/[id] screen should not depend on react-navigation useRoute() in expo-router web');
    },
}));

vi.mock('@/components/sessions/shell/SessionView', () => ({
    SessionView: ({ id, jumpToSeq, paneUrlState }: { id: string; jumpToSeq?: number | null; paneUrlState?: any }) =>
        React.createElement('SessionView', { id, jumpToSeq, paneUrlState }),
}));

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: (sessionId: string) => {
        if (sessionId) {
            ensureSessionVisibleSpy(sessionId);
        }
        return hydrateReady;
    },
}));

async function renderSessionScreenTree() {
    const Screen = (await import('@/app/(app)/session/[id]')).default;

    let tree: renderer.ReactTestRenderer | null = null;
    await act(async () => {
        tree = renderer.create(React.createElement(Screen));
    });
    await act(async () => {
        await Promise.resolve();
    });

    return tree!;
}

async function renderSessionScreen() {
    const tree = await renderSessionScreenTree();
    const sessionView = tree.root.findByType('SessionView');
    return { tree, sessionView };
}

describe('session/[id] param parsing', () => {
  afterEach(() => {
    vi.resetModules();
    ensureSessionVisibleSpy.mockClear();
    hydrateReady = true;
  });

  it('renders the session view using expo-router search params', async () => {
        vi.resetModules();
        searchParams = { id: 'session-123' };
        const { sessionView } = await renderSessionScreen();
        expect(sessionView.props.id).toBe('session-123');
  });

  it('does not pass jumpToSeq when jumpSeq is missing', async () => {
    vi.resetModules();
    searchParams = { id: 'session-123' };
    const { sessionView } = await renderSessionScreen();
    expect(sessionView.props.jumpToSeq ?? null).toBeNull();
  });

  it('does not pass jumpToSeq when jumpSeq is empty or whitespace', async () => {
    vi.resetModules();
    searchParams = { id: 'session-123', jumpSeq: '   ' };
    const { sessionView } = await renderSessionScreen();
    expect(sessionView.props.jumpToSeq ?? null).toBeNull();
  });

  it('passes jumpSeq through to SessionView as jumpToSeq', async () => {
    vi.resetModules();
    searchParams = { id: 'session-123', jumpSeq: '42' } as any;
    const { sessionView } = await renderSessionScreen();
    expect(sessionView.props.jumpToSeq).toBe(42);
  });

  it('passes pane url params through to SessionView as paneUrlState', async () => {
    vi.resetModules();
    searchParams = { id: 'session-123', right: 'files', details: 'file', path: 'src/app.ts' } as any;
    const { sessionView } = await renderSessionScreen();
    expect(sessionView.props.paneUrlState).toEqual({
      rightTabId: 'files',
      details: { kind: 'file', path: 'src/app.ts' },
    });
  });

  it('hydrates sessions for deep links by requesting session visibility', async () => {
    vi.resetModules();
    searchParams = { id: 'session-123' };
    await renderSessionScreen();
    expect(ensureSessionVisibleSpy).toHaveBeenCalledWith('session-123');
  });

  it('still renders SessionView while hydration is pending so deleted-session UI can recover', async () => {
    vi.resetModules();
    hydrateReady = false;
    searchParams = { id: 'session-123' };
    const { sessionView } = await renderSessionScreen();
    expect(sessionView.props.id).toBe('session-123');
  });

  it('renders an invalid-link fallback when session id is missing', async () => {
        vi.resetModules();
        searchParams = {};
        const tree = await renderSessionScreenTree();
        expect(ensureSessionVisibleSpy).not.toHaveBeenCalled();
        expect(tree.root.findAllByType('SessionView')).toHaveLength(0);
        expect(tree.root.findByProps({ testID: 'session-invalid-link' })).toBeTruthy();
  });
});
