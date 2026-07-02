import * as React from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const hydrateSessionSpy = vi.hoisted(() => vi.fn((sessionId: string, reason: string, options?: { serverId?: string }) => ({
    kind: 'available' as const,
    sessionId,
    serverId: options?.serverId,
})));
const sessionSplitCanvasScreenSpy = vi.hoisted(() => vi.fn((props: {
    sessionId: string;
    routeServerId?: string;
    jumpToSeq?: number | null;
    paneUrlState?: unknown;
    initialAttachmentDrafts?: readonly unknown[] | null;
}) => React.createElement('SessionSplitCanvasScreen', props)));

const routerMock = createExpoRouterMock({
    params: {
        id: ['', 's1'],
        serverId: ['server-1'],
        jumpSeq: '42',
        right: 'files',
        bottom: 'terminal',
        details: 'commit',
        path: 'src/index.ts',
        sha: 'abc123',
        recoveryDataId: 'recovery-1',
    },
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
        ActivityIndicator: 'ActivityIndicator',
        Platform: { OS: 'web', select: (spec: Record<string, unknown>) => spec.web ?? spec.default },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeState: {
            right: { activeTabId: null },
            details: { isOpen: false, tabs: [] },
        },
        openDetailsTab: vi.fn(),
    }),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/components/sessions/canvas/SessionSplitCanvasScreen', () => ({
    SessionSplitCanvasScreen: (props: {
        sessionId: string;
        routeServerId?: string;
        jumpToSeq?: number | null;
        paneUrlState?: unknown;
        initialAttachmentDrafts?: readonly unknown[] | null;
    }) => sessionSplitCanvasScreenSpy(props),
}));

vi.mock('@/components/sessions/shell/SessionView', () => ({
    SessionView: (props: { id: string }) => React.createElement('SessionView', props),
}));

vi.mock('@/components/workspaceCockpit/session/SessionCockpitShell', () => ({
    SessionCockpitShell: (props: { sessionId: string }) => React.createElement('SessionCockpitShell', props),
}));

vi.mock('@/components/sessions/shell/SessionInvalidLinkFallback', () => ({
    SessionInvalidLinkFallback: () => React.createElement('SessionInvalidLinkFallback'),
}));

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: (sessionId: string, reason: string, options?: { serverId?: string }) =>
        hydrateSessionSpy(sessionId, reason, options),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ generation: 1 }),
    subscribeActiveServer: () => () => {},
}));

vi.mock('@/components/sessions/panes/url/sessionPaneUrlState', () => ({
    parseSessionPaneUrlState: () => ({
        rightTabId: 'files',
        bottomTabId: 'terminal',
        detailsTarget: {
            kind: 'commit',
            path: 'src/index.ts',
            sha: 'abc123',
        },
    }),
}));

vi.mock('@/utils/sessions/tempDataStore', () => ({
    getTempData: () => ({
        attachmentDrafts: [{ id: 'draft-1' }],
    }),
}));

describe('session index route', () => {
    beforeEach(() => {
        hydrateSessionSpy.mockClear();
        sessionSplitCanvasScreenSpy.mockClear();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('normalizes route params before hydrating and passes the full session route boundary through the session split canvas screen', async () => {
        const { default: SessionRoute } = await import('@/app/(app)/session/[id]/index');

        await renderScreen(<SessionRoute />);

        expect(hydrateSessionSpy).toHaveBeenCalledWith(
            's1',
            'SessionRoute.ensureSessionVisible gen=1',
            { serverId: 'server-1' },
        );
        expect(sessionSplitCanvasScreenSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: 's1',
                routeServerId: 'server-1',
                jumpToSeq: 42,
                paneUrlState: {
                    rightTabId: 'files',
                    bottomTabId: 'terminal',
                    detailsTarget: {
                        kind: 'commit',
                        path: 'src/index.ts',
                        sha: 'abc123',
                    },
                },
                initialAttachmentDrafts: [{ id: 'draft-1' }],
            }),
        );
    });
});
