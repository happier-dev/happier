import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let mockSessionId = 'session-1';
let isFocused = true;
let sessionHydrated = true;
let mockDetailsParam: string | undefined;
let mockPathParam: string | undefined;
let mockShaParam: string | undefined;
const routerBackSpy = vi.fn();
const routerReplaceSpy = vi.fn();
const ensureSessionVisibleSpy = vi.fn((_sessionId: string) => Promise.resolve());
const closeDetailsSpy = vi.fn();
const openDetailsTabSpy = vi.fn();
let canGoBack = true;

type DetailsTab = Readonly<{ key: string }>;
type MockScopeState = Readonly<{
    details:
        | null
        | Readonly<{
              isOpen?: boolean;
              tabs?: readonly DetailsTab[];
              activeTabKey?: string | null;
              tabState?: Record<string, unknown>;
          }>;
}>;

let scopeState: MockScopeState = { details: null };

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
    useLocalSearchParams: () => ({ id: mockSessionId, details: mockDetailsParam, path: mockPathParam, sha: mockShaParam }),
    useRouter: () => ({ back: routerBackSpy, replace: routerReplaceSpy }),
    useNavigation: () => ({ canGoBack: () => canGoBack }),
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => {
        const [state, setState] = React.useState<MockScopeState>(scopeState);
        return {
            scopeId: `session:${mockSessionId}`,
            scopeState: state,
            setDetailsTabState: vi.fn(),
            openDetailsTab: (tab: any) => {
                openDetailsTabSpy(tab);
                setState((prev) => ({
                    ...prev,
                    details: {
                        isOpen: true,
                        tabs: [tab],
                        activeTabKey: tab.key,
                        tabState: {},
                    },
                }));
            },
            closeDetails: () => {
                closeDetailsSpy();
                setState((prev) => ({
                    ...prev,
                    details: prev.details ? { ...prev.details, isOpen: false } : prev.details,
                }));
            },
            closeDetailsTab: vi.fn(),
            setActiveDetailsTab: vi.fn(),
            pinDetailsTab: vi.fn(),
        };
    },
}));

vi.mock('@/components/sessions/panes/SessionDetailsPanel', () => ({
    SessionDetailsPanel: (props: any) => React.createElement('SessionDetailsPanel', props),
}));

vi.mock('@/components/sessions/panes/url/sessionPaneUrlState', () => ({
    parseSessionPaneUrlState: () => {
        if (mockDetailsParam === 'file' && mockPathParam) {
            return { details: { kind: 'file', path: mockPathParam } };
        }
        if (mockDetailsParam === 'commit' && mockShaParam) {
            return { details: { kind: 'commit', sha: mockShaParam } };
        }
        return null;
    },
    applySessionPaneUrlState: (pane: any, state: any) => {
        if (state?.details?.kind === 'file') {
            pane.openDetailsTab({
                key: `file:${state.details.path}`,
                kind: 'file',
                resource: { kind: 'file', path: state.details.path },
            });
            return;
        }
        if (state?.details?.kind === 'commit') {
            pane.openDetailsTab({
                key: `commit:${state.details.sha}`,
                kind: 'commit',
                resource: { kind: 'commit', commitHash: state.details.sha },
            });
        }
    },
}));

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: (sessionId: string) => {
        ensureSessionVisibleSpy(sessionId);
        return sessionHydrated;
    },
}));

vi.mock('@/components/sessions/shell/SessionInvalidLinkFallback', () => ({
    SessionInvalidLinkFallback: () => React.createElement('SessionInvalidLinkFallback', { testID: 'session-invalid-link' }),
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSessionVisibleForMessageRoute: (sessionId: string) => ensureSessionVisibleSpy(sessionId),
    },
}));

describe('/session/[id]/details', () => {
    beforeEach(() => {
        mockSessionId = 'session-1';
        isFocused = true;
        sessionHydrated = true;
        mockDetailsParam = undefined;
        mockPathParam = undefined;
        mockShaParam = undefined;
        canGoBack = true;
        scopeState = { details: null };
        routerBackSpy.mockClear();
        routerReplaceSpy.mockClear();
        ensureSessionVisibleSpy.mockClear();
        closeDetailsSpy.mockClear();
        openDetailsTabSpy.mockClear();
        vi.clearAllMocks();
    });

    it('restores file details from route params before falling back to the session route', async () => {
        mockDetailsParam = 'file';
        mockPathParam = 'README.md';
        const Screen = (await import('@/app/(app)/session/[id]/details')).default;

        await act(async () => {
            renderer.create(<Screen />);
        });

        expect(openDetailsTabSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                key: 'file:README.md',
                kind: 'file',
                resource: { kind: 'file', path: 'README.md' },
            })
        );
        expect(routerBackSpy).not.toHaveBeenCalled();
    });

    it('navigates back when there are no details tabs to display', async () => {
        const Screen = (await import('@/app/(app)/session/[id]/details')).default;
        await act(async () => {
            renderer.create(<Screen />);
        });
        expect(routerBackSpy).toHaveBeenCalled();
    });

    it('does not redirect away before the session has hydrated', async () => {
        sessionHydrated = false;
        const Screen = (await import('@/app/(app)/session/[id]/details')).default;
        await act(async () => {
            renderer.create(<Screen />);
        });

        expect(routerBackSpy).not.toHaveBeenCalled();
        expect(routerReplaceSpy).not.toHaveBeenCalled();
    });

    it('renders the shared SessionDetailsPanel when tabs exist', async () => {
        scopeState = { details: { tabs: [{ key: 'file:README.md' }], activeTabKey: 'file:README.md' } };
        const Screen = (await import('@/app/(app)/session/[id]/details')).default;
        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<Screen />);
        });
        const panel = tree!.root.findByType('SessionDetailsPanel' as any);
        expect(panel.props.sessionId).toBe('session-1');
        expect(panel.props.scopeId).toBe('session:session-1');
    });

    it('hydrates the session for deep links by requesting session visibility', async () => {
        scopeState = { details: { tabs: [{ key: 'file:README.md' }], activeTabKey: 'file:README.md' } };
        const Screen = (await import('@/app/(app)/session/[id]/details')).default;
        await act(async () => {
            renderer.create(<Screen />);
        });
        expect(ensureSessionVisibleSpy).toHaveBeenCalledWith('session-1');
    });

    it('passes an onRequestClose that closes the pane and navigates back', async () => {
        scopeState = { details: { isOpen: true, tabs: [{ key: 'file:README.md' }], activeTabKey: 'file:README.md' } };
        const Screen = (await import('@/app/(app)/session/[id]/details')).default;
        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<Screen />);
        });

        const panel = tree!.root.findByType('SessionDetailsPanel' as any);
        await act(async () => {
            panel.props.onRequestClose();
        });

        expect(closeDetailsSpy).toHaveBeenCalled();
        expect(routerBackSpy).toHaveBeenCalledTimes(1);
    });

    it('falls back to the parent session route when there is no back stack', async () => {
        canGoBack = false;
        scopeState = { details: { isOpen: true, tabs: [{ key: 'file:README.md' }], activeTabKey: 'file:README.md' } };
        const Screen = (await import('@/app/(app)/session/[id]/details')).default;
        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<Screen />);
        });

        const panel = tree!.root.findByType('SessionDetailsPanel' as any);
        await act(async () => {
            panel.props.onRequestClose();
        });

        expect(routerBackSpy).not.toHaveBeenCalled();
        expect(routerReplaceSpy).toHaveBeenCalledWith('/session/session-1');
    });
});
