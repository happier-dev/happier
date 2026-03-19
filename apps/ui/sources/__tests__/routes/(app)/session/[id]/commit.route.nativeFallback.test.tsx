import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let mockShaParam = '';
const routerReplaceSpy = vi.fn();
const openDetailsTabSpy = vi.fn();

vi.mock('expo-router', () => ({
    useLocalSearchParams: () => ({
        id: 'session-1',
        sha: mockShaParam,
    }),
    useRouter: () => ({
        back: vi.fn(),
        push: vi.fn(),
        replace: routerReplaceSpy,
    }),
}));

vi.mock('react-native', async () => {
    const actual = await vi.importActual<typeof import('react-native')>('react-native');
    return {
        ...actual,
        Platform: { ...actual.Platform, OS: 'ios', select: (value: any) => value?.ios ?? value?.default ?? null },
        View: (props: any) => React.createElement('View', props, props.children),
        useWindowDimensions: () => ({
            width: 1400,
            height: 900,
            scale: 1,
            fontScale: 1,
        }),
    };
});

vi.mock('@/sync/domains/state/storage', () => ({
    useLocalSetting: () => false,
}));

vi.mock('@/utils/platform/responsive', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/platform/responsive')>();
    return {
        ...actual,
        useDeviceType: () => 'tablet',
        getDeviceType: () => 'tablet',
    };
});

vi.mock('@/components/ui/panels/shouldRedirectDetailsRouteToPanes', () => ({
    shouldRedirectDetailsRouteToPanes: () => false,
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        openDetailsTab: openDetailsTabSpy,
    }),
}));

vi.mock('@/components/sessions/files/views/SessionCommitDetailsView', () => ({
    SessionCommitDetailsView: () => React.createElement('SessionCommitDetailsView'),
}));

vi.mock('@/components/sessions/panes/url/sessionPaneUrlState', () => ({
    serializeSessionPaneUrlState: (state: any) => state?.details?.kind === 'commit'
        ? { details: 'commit', sha: state.details.sha }
        : {},
}));

vi.mock('@/components/sessions/shell/SessionInvalidLinkFallback', () => ({
    SessionInvalidLinkFallback: () => React.createElement('SessionInvalidLinkFallback', { testID: 'session-invalid-link' }),
}));

describe('CommitScreen native route fallback', () => {
    it('renders the invalid link fallback when the sha param is missing', async () => {
        vi.resetModules();
        const { default: CommitScreen } = await import('@/app/(app)/session/[id]/commit');
        mockShaParam = '';
        routerReplaceSpy.mockClear();
        openDetailsTabSpy.mockClear();
        let tree: renderer.ReactTestRenderer | undefined;
        try {
            act(() => {
                tree = renderer.create(React.createElement(CommitScreen));
            });
            await act(async () => {
                await new Promise((r) => setTimeout(r, 0));
            });

            expect(tree!.root.findByProps({ testID: 'session-invalid-link' })).toBeTruthy();
            expect(routerReplaceSpy).not.toHaveBeenCalled();
            expect(openDetailsTabSpy).not.toHaveBeenCalled();
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('re-opens details when the sha param changes on the same native screen instance', async () => {
        vi.resetModules();
        const { default: CommitScreen } = await import('@/app/(app)/session/[id]/commit');
        mockShaParam = 'abc123';
        routerReplaceSpy.mockClear();
        openDetailsTabSpy.mockClear();
        let tree: renderer.ReactTestRenderer | undefined;
        try {
            await act(async () => {
                tree = renderer.create(React.createElement(CommitScreen));
                await Promise.resolve();
            });

            expect(openDetailsTabSpy).toHaveBeenCalledTimes(1);
            expect(routerReplaceSpy).toHaveBeenCalledTimes(1);
            expect(routerReplaceSpy).toHaveBeenLastCalledWith({
                pathname: '/session/[id]/details',
                params: { id: 'session-1', details: 'commit', sha: 'abc123' },
            });

            mockShaParam = 'def456';

            await act(async () => {
                tree!.update(React.createElement(CommitScreen));
                await Promise.resolve();
            });

            expect(openDetailsTabSpy).toHaveBeenCalledTimes(2);
            expect(routerReplaceSpy).toHaveBeenCalledTimes(2);
            expect(routerReplaceSpy).toHaveBeenNthCalledWith(1, {
                pathname: '/session/[id]/details',
                params: { id: 'session-1', details: 'commit', sha: 'abc123' },
            });
            expect(routerReplaceSpy).toHaveBeenNthCalledWith(2, {
                pathname: '/session/[id]/details',
                params: { id: 'session-1', details: 'commit', sha: 'def456' },
            });
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });
});
