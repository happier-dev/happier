import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { flushHookEffects, renderScreen } from '@/dev/testkit';


type SearchParams = { id?: string; jumpSeq?: string };
let searchParams: SearchParams = {};
const ensureSessionVisibleSpy = vi.fn((_sessionId: string) => Promise.resolve());
let hydrateReady = true;
const routerMock = createSessionRouterMock();

function createSessionRouterMock() {
    return createExpoRouterMock({
        params: () => searchParams,
    });
}

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    Platform: {
                        OS: 'web',
                    },
                    View: (props: any) => React.createElement('View', props, props.children),
                }
    );
});

vi.mock('expo-router', async () => {
    return routerMock.module;
});

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
    routerMock.state.params = searchParams;
    const Screen = (await import('@/app/(app)/session/[id]')).default;

    const screen = await renderScreen(React.createElement(Screen));
    await flushHookEffects({ cycles: 1, turns: 1 });

    return screen;
}

async function renderSessionScreen() {
    const screen = await renderSessionScreenTree();
    const sessionView = screen.findByType('SessionView' as any);
    return { screen, sessionView };
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
        const screen = await renderSessionScreenTree();
        expect(ensureSessionVisibleSpy).not.toHaveBeenCalled();
        expect(screen.findAllByType('SessionView' as any)).toHaveLength(0);
        expect(screen.findByTestId('session-invalid-link')).toBeTruthy();
  });
});
