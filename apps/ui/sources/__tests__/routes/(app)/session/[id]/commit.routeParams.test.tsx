import * as React from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const capturedScopeIdRef = vi.hoisted(() => ({ current: '' }));
const sessionCommitDetailsViewSpy = vi.hoisted(() => vi.fn((props: any) => React.createElement('SessionCommitDetailsView', props)));

const routerMock = createExpoRouterMock({
    params: { id: ['s1', 's2'], sha: 'abc def' },
    router: {
        push: vi.fn(),
        back: vi.fn(),
        replace: vi.fn(),
        setParams: vi.fn(),
    },
});

vi.mock('expo-router', () => routerMock.module);

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        Platform: { OS: 'web', select: (spec: Record<string, unknown>) => spec.web ?? spec.default },
        useWindowDimensions: () => ({ width: 1024, height: 768 }),
    });
});

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: (scopeId: string) => {
        capturedScopeIdRef.current = scopeId;
        return {
            openDetailsTab: vi.fn(),
            closeDetailsTab: vi.fn(),
            closeDetails: vi.fn(),
            pinDetailsTab: vi.fn(),
            setActiveDetailsTab: vi.fn(),
            setRightTab: vi.fn(),
            setRightTabState: vi.fn(),
            openRight: vi.fn(),
            closeRight: vi.fn(),
            scopeState: { details: { isOpen: false, tabs: [] } },
        };
    },
}));

vi.mock('@/components/sessions/files/views/SessionCommitDetailsView', () => ({
    SessionCommitDetailsView: (props: any) => sessionCommitDetailsViewSpy(props),
}));

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: (sessionId: string) => ({
        kind: sessionId ? 'available' : 'missing',
        sessionId,
        cause: sessionId ? undefined : 'not_found',
    }),
}));

vi.mock('@/components/ui/panels/shouldRedirectDetailsRouteToPanes', () => ({
    shouldRedirectDetailsRouteToPanes: () => false,
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'phone',
}));

const storageMock = createStorageModuleStub({
    useLocalSetting: () => false,
});

vi.mock('@/sync/domains/state/storage', () => storageMock);

describe('session commit route', () => {
    beforeEach(() => {
        capturedScopeIdRef.current = '';
        sessionCommitDetailsViewSpy.mockClear();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('normalizes array session ids before opening the commit screen', async () => {
        const { default: CommitRoute } = await import('@/app/(app)/session/[id]/commit');

        await renderScreen(<CommitRoute />);

        expect(capturedScopeIdRef.current).toBe('session:s1');
        expect(sessionCommitDetailsViewSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: 's1',
                sha: 'abc',
            }),
        );
    });
});
