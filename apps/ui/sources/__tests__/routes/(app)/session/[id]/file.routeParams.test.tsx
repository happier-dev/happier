import * as React from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const openDetailsTabSpy = vi.hoisted(() => vi.fn());
const routerReplaceSpy = vi.hoisted(() => vi.fn());
const capturedScopeIdRef = vi.hoisted(() => ({ current: '' }));
const paneScopeMock = vi.hoisted(() => ({
    openDetailsTab: openDetailsTabSpy,
    closeDetailsTab: vi.fn(),
    closeDetails: vi.fn(),
    pinDetailsTab: vi.fn(),
    setActiveDetailsTab: vi.fn(),
    setRightTab: vi.fn(),
    setRightTabState: vi.fn(),
    openRight: vi.fn(),
    closeRight: vi.fn(),
    scopeState: { details: { isOpen: false, tabs: [] } },
}));

const routerMock = createExpoRouterMock({
    params: { id: ['s1', 's2'], path: 'src/a.txt' },
    router: {
        push: vi.fn(),
        back: vi.fn(),
        replace: routerReplaceSpy,
        setParams: vi.fn(),
    },
});

vi.mock('expo-router', () => routerMock.module);

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        Platform: { OS: 'ios', select: (spec: Record<string, unknown>) => spec.ios ?? spec.default },
        useWindowDimensions: () => ({ width: 1024, height: 768 }),
    });
});

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: (scopeId: string) => {
        capturedScopeIdRef.current = scopeId;
        return {
            ...paneScopeMock,
        };
    },
}));

vi.mock('@/components/sessions/files/views/SessionFileDetailsView', () => ({
    SessionFileDetailsView: (props: any) => React.createElement('SessionFileDetailsView', props),
}));

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: (sessionId: string) => ({ kind: 'available', sessionId }),
}));

vi.mock('@/components/ui/panels/shouldRedirectDetailsRouteToPanes', () => ({
    shouldRedirectDetailsRouteToPanes: () => false,
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'phone',
}));

const storageMock = createStorageModuleStub({
    useLocalSetting: (key: string) => (key === 'uiMultiPanePanelsEnabled' ? false : undefined),
});

vi.mock('@/sync/domains/state/storage', () => storageMock);

describe('session file route', () => {
    beforeEach(() => {
        openDetailsTabSpy.mockClear();
        paneScopeMock.openRight.mockClear();
        paneScopeMock.setRightTab.mockClear();
        routerReplaceSpy.mockClear();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('normalizes array session ids before opening the file details pane', async () => {
        const { default: FileRoute } = await import('@/app/(app)/session/[id]/file');

        await renderScreen(<FileRoute />);

        expect(openDetailsTabSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                key: 'file:src/a.txt',
                kind: 'file',
                title: 'a.txt',
                resource: expect.objectContaining({
                    kind: 'file',
                    path: 'src/a.txt',
                }),
            }),
            expect.objectContaining({ intent: 'preview' }),
        );
        expect(capturedScopeIdRef.current).toBe('session:s1');
        expect(paneScopeMock.openRight).not.toHaveBeenCalled();
        expect(paneScopeMock.setRightTab).not.toHaveBeenCalled();
        expect(routerReplaceSpy).toHaveBeenCalledWith({
            pathname: '/session/[id]/details',
            params: expect.objectContaining({ id: 's1' }),
        });
    });
});
