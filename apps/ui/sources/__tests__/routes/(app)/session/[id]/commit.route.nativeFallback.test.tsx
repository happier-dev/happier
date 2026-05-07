import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { installSessionRouteCommonModuleMocks } from './sessionRouteTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let mockShaParam = '';
let mockServerIdParam = 'server-b';
const routerReplaceSpy = vi.fn();
const openDetailsTabSpy = vi.fn();
const routerMock = createCommitRouteRouterMock();

function createCommitRouteRouterMock() {
    return createExpoRouterMock({
        router: {
            back: vi.fn(),
            push: vi.fn(),
            replace: routerReplaceSpy,
        },
        params: () => ({
            id: 'session-1',
            sha: mockShaParam,
            serverId: mockServerIdParam,
        }),
    });
}

installSessionRouteCommonModuleMocks({
    router: async () => routerMock.module,
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
                select: (value: any) => value?.ios ?? value?.default ?? null,
            },
            View: (props: any) => React.createElement('View', props, props.children),
            useWindowDimensions: () => ({
                width: 1400,
                height: 900,
                scale: 1,
                fontScale: 1,
            }),
        });
    },
    storageModule: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useLocalSetting: () => false,
        });
    },
});

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
        mockServerIdParam = 'server-b';
        routerMock.state.params = { id: 'session-1', sha: mockShaParam, serverId: mockServerIdParam };
        routerReplaceSpy.mockClear();
        openDetailsTabSpy.mockClear();
        const screen = await renderScreen(React.createElement(CommitScreen));
        try {
            await act(async () => {
                await new Promise((r) => setTimeout(r, 0));
            });

            expect(screen.findByTestId('session-invalid-link')).toBeTruthy();
            expect(routerReplaceSpy).not.toHaveBeenCalled();
            expect(openDetailsTabSpy).not.toHaveBeenCalled();
        } finally {
            act(() => {
                screen.tree.unmount();
            });
        }
    });

    it('re-opens details when the sha param changes on the same native screen instance', async () => {
        vi.resetModules();
        const { default: CommitScreen } = await import('@/app/(app)/session/[id]/commit');
        mockShaParam = 'abc123';
        mockServerIdParam = 'server-b';
        routerMock.state.params = { id: 'session-1', sha: mockShaParam, serverId: mockServerIdParam };
        routerReplaceSpy.mockClear();
        openDetailsTabSpy.mockClear();
        const screen = await renderScreen(React.createElement(CommitScreen));
        try {
            expect(openDetailsTabSpy).toHaveBeenCalledTimes(1);
            expect(routerReplaceSpy).toHaveBeenCalledTimes(1);
            expect(routerReplaceSpy).toHaveBeenLastCalledWith('/session/session-1/details?serverId=server-b&details=commit&sha=abc123');

            mockShaParam = 'def456';
            routerMock.state.params = { id: 'session-1', sha: mockShaParam, serverId: mockServerIdParam };

            await act(async () => {
                screen.tree.update(React.createElement(CommitScreen));
            });
            await flushHookEffects({ cycles: 1, turns: 1 });

            expect(openDetailsTabSpy).toHaveBeenCalledTimes(2);
            expect(routerReplaceSpy).toHaveBeenCalledTimes(2);
            expect(routerReplaceSpy).toHaveBeenNthCalledWith(1, '/session/session-1/details?serverId=server-b&details=commit&sha=abc123');
            expect(routerReplaceSpy).toHaveBeenNthCalledWith(2, '/session/session-1/details?serverId=server-b&details=commit&sha=def456');
        } finally {
            act(() => {
                screen.tree.unmount();
            });
        }
    });
});
