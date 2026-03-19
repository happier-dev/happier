import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerBackSpy = vi.fn();
const routerPushSpy = vi.fn();
const routerReplaceSpy = vi.fn();
let mockSessionId = 'session-1';
let isFocused = true;
let canGoBack = true;

const openRightSpy = vi.fn();
const closeRightSpy = vi.fn();
const setRightTabSpy = vi.fn();
const ensureSessionVisibleSpy = vi.fn((_sessionId: string) => Promise.resolve());
let scopeState: any = {
    right: { isOpen: false, activeTabId: null, tabState: {} },
    details: null,
};

vi.mock('@react-navigation/native', () => ({
    useIsFocused: () => isFocused,
}));

vi.mock('react-native', async (importOriginal) => {
    const rn = await importOriginal<typeof import('react-native')>();
    return {
        ...rn,
        View: 'View',
        ActivityIndicator: 'ActivityIndicator',
    };
});

vi.mock('expo-router', () => ({
    useLocalSearchParams: () => ({ id: mockSessionId }),
    useRouter: () => ({
        back: routerBackSpy,
        push: routerPushSpy,
        replace: routerReplaceSpy,
    }),
    useNavigation: () => ({
        canGoBack: () => canGoBack,
    }),
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeId: `session:${mockSessionId}`,
        scopeState,
        openRight: openRightSpy,
        closeRight: closeRightSpy,
        setRightTab: setRightTabSpy,
        setRightTabState: vi.fn(),
        openDetailsTab: vi.fn(),
        setDetailsTabState: vi.fn(),
        pinDetailsTab: vi.fn(),
        closeDetails: vi.fn(),
        closeDetailsTab: vi.fn(),
        setActiveDetailsTab: vi.fn(),
    }),
}));

vi.mock('@/components/sessions/panes/SessionRightPanel', () => ({
    SessionRightPanel: (props: any) => React.createElement('SessionRightPanel', props),
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSessionVisibleForMessageRoute: (sessionId: string) => ensureSessionVisibleSpy(sessionId),
    },
}));

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: (sessionId: string) => {
        ensureSessionVisibleSpy(sessionId);
        return true;
    },
}));

let SessionFilesRouteScreen: React.ComponentType<any>;

describe('/session/[id]/files', () => {
    beforeAll(async () => {
        SessionFilesRouteScreen = (await import('@/app/(app)/session/[id]/files')).default;
    }, 60_000);

    beforeEach(() => {
        mockSessionId = 'session-1';
        isFocused = true;
        canGoBack = true;
        scopeState = {
            right: { isOpen: false, activeTabId: null, tabState: {} },
            details: null,
        };
        openRightSpy.mockClear();
        closeRightSpy.mockClear();
        setRightTabSpy.mockClear();
        routerBackSpy.mockClear();
        routerPushSpy.mockClear();
        routerReplaceSpy.mockClear();
        ensureSessionVisibleSpy.mockClear();
        vi.clearAllMocks();
    });

    async function renderScreen() {
        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionFilesRouteScreen />);
            await Promise.resolve();
        });
        return tree!;
    }

    it('renders the shared SessionRightPanel surface fullscreen and opens the right pane state', async () => {
        const tree = await renderScreen();

        const panel = tree!.root.findByType('SessionRightPanel' as any);
        expect(panel.props.sessionId).toBe('session-1');
        expect(panel.props.scopeId).toBe('session:session-1');
        expect(openRightSpy).toHaveBeenCalledWith({ tabId: 'files' });
        expect(setRightTabSpy).toHaveBeenCalledWith('files');
    });

    it('forces the files tab even when another right-pane tab was remembered', async () => {
        scopeState = {
            right: { isOpen: true, activeTabId: 'terminal', tabState: {} },
            details: null,
        };

        await renderScreen();

        expect(openRightSpy).toHaveBeenCalledWith({ tabId: 'files' });
        expect(setRightTabSpy).toHaveBeenCalledWith('files');
    });

    it('hydrates the session for deep links by requesting session visibility', async () => {
        await renderScreen();

        expect(ensureSessionVisibleSpy).toHaveBeenCalledWith('session-1');
    });

    it('closes by navigating back and closing the right-pane state', async () => {
        const tree = await renderScreen();

        const panel = tree!.root.findByType('SessionRightPanel' as any);
        await act(async () => {
            panel.props.onRequestClose();
        });

        expect(closeRightSpy).toHaveBeenCalled();
        expect(routerBackSpy).toHaveBeenCalled();
    });

    it('falls back to the session route when closed without back history', async () => {
        canGoBack = false;
        const tree = await renderScreen();

        const panel = tree!.root.findByType('SessionRightPanel' as any);
        await act(async () => {
            panel.props.onRequestClose();
        });

        expect(closeRightSpy).toHaveBeenCalled();
        expect(routerBackSpy).not.toHaveBeenCalled();
        expect(routerReplaceSpy).toHaveBeenCalledWith('/session/session-1');
    });

    it('navigates to details when a details tab is opened from the shared surface', async () => {
        scopeState = {
            right: { isOpen: true, activeTabId: 'git', tabState: {} },
            details: {
                isOpen: true,
                tabs: [{ key: 'file:README.md', kind: 'file', resource: { kind: 'file', path: 'README.md' } }],
                activeTabKey: 'file:README.md',
                tabState: {},
            },
        };
        await renderScreen();

        expect(routerPushSpy).toHaveBeenCalledWith({
            pathname: '/session/[id]/details',
            params: { id: 'session-1', details: 'file', path: 'README.md' },
        });
    });

    it('does not navigate to details when tabs exist but the details pane is closed', async () => {
        scopeState = {
            right: { isOpen: true, activeTabId: 'git', tabState: {} },
            details: { isOpen: false, tabs: [{ key: 'file:README.md' }], activeTabKey: 'file:README.md', tabState: {} },
        };
        await renderScreen();

        expect(routerPushSpy).not.toHaveBeenCalled();
    });

    it('does not navigate to details when the route is not focused', async () => {
        isFocused = false;
        scopeState = {
            right: { isOpen: true, activeTabId: 'git', tabState: {} },
            details: { isOpen: true, tabs: [{ key: 'file:README.md' }], activeTabKey: 'file:README.md', tabState: {} },
        };
        await renderScreen();

        expect(routerPushSpy).not.toHaveBeenCalled();
    });

    it('encodes commit details params from commitHash resources', async () => {
        scopeState = {
            right: { isOpen: true, activeTabId: 'git', tabState: {} },
            details: {
                isOpen: true,
                tabs: [{ key: 'commit:abc1234', kind: 'commit', resource: { kind: 'commit', commitHash: 'abc1234' } }],
                activeTabKey: 'commit:abc1234',
                tabState: {},
            },
        };

        await renderScreen();

        expect(routerPushSpy).toHaveBeenCalledWith({
            pathname: '/session/[id]/details',
            params: { id: 'session-1', details: 'commit', sha: 'abc1234' },
        });
    });

    it('can navigate again when the details pane is reopened with the same active tab', async () => {
        scopeState = {
            right: { isOpen: true, activeTabId: 'git', tabState: {} },
            details: { isOpen: true, tabs: [{ key: 'scmReview:working' }], activeTabKey: 'scmReview:working', tabState: {} },
        };
        let tree = await renderScreen();

        expect(routerPushSpy).toHaveBeenCalledTimes(1);

        // This route becomes unfocused while the fullscreen details route is on top.
        // Ensure we still reset the "did push" latch so the next open can navigate again.
        isFocused = false;
        scopeState = {
            ...scopeState,
            details: { ...scopeState.details, isOpen: false },
        };

        await act(async () => {
            tree!.update(<SessionFilesRouteScreen />);
            await Promise.resolve();
        });

        isFocused = true;
        scopeState = {
            ...scopeState,
            details: { ...scopeState.details, isOpen: true },
        };

        await act(async () => {
            tree!.update(<SessionFilesRouteScreen />);
            await Promise.resolve();
        });

        expect(routerPushSpy).toHaveBeenCalledTimes(2);
    });

    it('pushes the details route again when the session id changes even if the details key is unchanged', async () => {
        scopeState = {
            right: { isOpen: true, activeTabId: 'git', tabState: {} },
            details: {
                isOpen: true,
                activeTabKey: 'file:README.md',
                tabs: [{ key: 'file:README.md', kind: 'file', resource: { kind: 'file', path: 'README.md' } }],
                tabState: {},
            },
        };

        const tree = await renderScreen();

        expect(routerPushSpy).toHaveBeenCalledTimes(1);
        expect(routerPushSpy).toHaveBeenLastCalledWith({
            pathname: '/session/[id]/details',
            params: { id: 'session-1', details: 'file', path: 'README.md' },
        });

        mockSessionId = 'session-2';

        await act(async () => {
            tree.update(<SessionFilesRouteScreen />);
            await Promise.resolve();
        });

        expect(routerPushSpy).toHaveBeenCalledTimes(2);
        expect(routerPushSpy).toHaveBeenLastCalledWith({
            pathname: '/session/[id]/details',
            params: { id: 'session-2', details: 'file', path: 'README.md' },
        });
    });
});
