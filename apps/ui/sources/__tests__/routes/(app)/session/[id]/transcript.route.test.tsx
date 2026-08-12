import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { installSessionRouteCommonModuleMocks } from './sessionRouteTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routeState = vi.hoisted(() => ({
    id: 'session-1' as string,
    sidechainId: 'wf/a1' as string,
    title: 'Reviewer' as string | undefined,
    hydration: 'available' as 'available' | 'missing' | 'loading',
}));
const layoutState = vi.hoisted(() => ({ windowWidthPx: 390, deviceType: 'phone' as 'phone' | 'tablet' }));
const routerReplaceSpy = vi.hoisted(() => vi.fn());
const openDetailsTabSpy = vi.hoisted(() => vi.fn());
const transcriptViewSpy = vi.hoisted(() => vi.fn());

installSessionRouteCommonModuleMocks({
    router: async () =>
        createExpoRouterMock({
            router: { back: vi.fn(), push: vi.fn(), replace: routerReplaceSpy, setParams: vi.fn() },
            params: () => ({ id: routeState.id, sidechainId: routeState.sidechainId, title: routeState.title }),
        }).module,
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: (props: any) => React.createElement('View', props, props.children),
            useWindowDimensions: () => ({ width: layoutState.windowWidthPx, height: 900, scale: 1, fontScale: 1 }),
            Platform: Object.defineProperty({}, 'OS', { get: () => 'ios', enumerable: true }) as any,
        });
    },
    storageModule: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useLocalSetting: (key: string) => (key === 'uiMultiPanePanelsEnabled' ? true : null),
        });
    },
});

vi.mock('@/utils/platform/responsive', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/platform/responsive')>();
    return { ...actual, useDeviceType: () => layoutState.deviceType, getDeviceType: () => layoutState.deviceType };
});

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: (scopeId: string) => ({
        scopeId,
        scopeState: null,
        openRight: vi.fn(),
        setRightTab: vi.fn(),
        openDetailsTab: openDetailsTabSpy,
    }),
}));

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: (sessionId: string) => ({
        kind: routeState.hydration,
        sessionId,
        ...(routeState.hydration === 'missing' ? { cause: 'not_found' } : null),
        ...(routeState.hydration === 'loading' ? { reason: 'cold' } : null),
    }),
}));

vi.mock('@/components/sessions/panes/details/SessionTranscriptDetailsView', () => ({
    SessionTranscriptDetailsView: (props: any) => {
        transcriptViewSpy(props);
        return React.createElement('SessionTranscriptDetailsView', props);
    },
}));

vi.mock('@/components/sessions/shell/SessionInvalidLinkFallback', () => ({
    SessionInvalidLinkFallback: () => React.createElement('SessionInvalidLinkFallback', { testID: 'session-invalid-link' }),
}));

const SessionAgentTranscriptScreen = (await import('@/app/(app)/session/[id]/transcript')).default;

/**
 * The other screen this corridor added, and the other one that shipped untested. An imported
 * workflow-agent sidechain has no owning tool message, so before this route existed its transcript
 * could be previewed on a phone and never read.
 */
describe('session agent transcript route', () => {
    beforeEach(() => {
        routeState.id = 'session-1';
        routeState.sidechainId = 'wf/a1';
        routeState.title = 'Reviewer';
        routeState.hydration = 'available';
        layoutState.windowWidthPx = 390;
        layoutState.deviceType = 'phone';
        routerReplaceSpy.mockClear();
        openDetailsTabSpy.mockClear();
        transcriptViewSpy.mockClear();
    });

    it('mounts the shared transcript view on the sidechain the link names', async () => {
        const screen = await renderScreen(<SessionAgentTranscriptScreen />);

        expect(screen.findByTestId('session-agent-transcript-screen')).toBeTruthy();
        expect(transcriptViewSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                scope: { kind: 'sidechain', sessionId: 'session-1', sidechainId: 'wf/a1' },
            }),
        );
    });

    it('falls back to the invalid-link surface without a sidechain id and for a missing session', async () => {
        routeState.sidechainId = '';
        const noSidechain = await renderScreen(<SessionAgentTranscriptScreen />);
        expect(noSidechain.findByTestId('session-invalid-link')).toBeTruthy();
        expect(transcriptViewSpy).not.toHaveBeenCalled();

        routeState.sidechainId = 'wf/a1';
        routeState.hydration = 'missing';
        const missing = await renderScreen(<SessionAgentTranscriptScreen />);
        expect(missing.findByTestId('session-invalid-link')).toBeTruthy();
        expect(transcriptViewSpy).not.toHaveBeenCalled();
    });

    it('hands a deep link back to the details pane when the window can dock one', async () => {
        layoutState.windowWidthPx = 1400;
        layoutState.deviceType = 'tablet';

        const screen = await renderScreen(<SessionAgentTranscriptScreen />);
        await flushHookEffects();

        expect(openDetailsTabSpy).toHaveBeenCalledWith(
            expect.objectContaining({ key: 'transcript:sidechain:wf/a1', kind: 'transcript', title: 'Reviewer' }),
            { intent: 'preview' },
        );
        expect(routerReplaceSpy).toHaveBeenCalledWith('/session/session-1');
        expect(transcriptViewSpy).not.toHaveBeenCalled();
    });
});
