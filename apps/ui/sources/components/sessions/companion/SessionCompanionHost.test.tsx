import * as React from 'react';
import { createRequire } from 'node:module';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { flattenTestStyle } from '@/dev/testkit/harness/popoverHarness';
import { readPresentationNotice, retirePresentationNotice } from '@/components/sessions/presentation/presentationNotices';

vi.mock('@/text', () => createTextModuleMock());

vi.mock('./summary/useSessionSummaryModel', () => ({
    useSessionSummaryModel: () => ({
        scope: 'exact' as const,
        title: 'Teams lane 08',
        agentLabel: 'Claude',
        agentId: null,
        status: { state: 'thinking' as const, statusText: 'Working', quiet: false },
        stale: false,
        availability: 'complete' as const,
        encryption: 'plain' as const,
        identityDestination: 'sessionInfo' as const,
        rows: [],
        needsYou: null,
        sinceMs: null,
        progress: null,
        plan: null,
        facts: [],
    }),
}));

const boardSnapshot = vi.fn();
vi.mock('@/components/sessions/board/useSessionBoardSnapshot', () => ({
    useSessionBoardSnapshot: () => boardSnapshot(),
}));

// Every geometry fact below is what an incumbent owner reports. The real
// placement resolver runs on top of them; nothing is stubbed optimistically.
const geometry = {
    paneLayout: null as unknown,
    mainVisible: true,
    keyboardHeightPx: 0,
    bottomChromePx: 0,
    safeAreaTopPx: 0,
    safeAreaBottomPx: 0,
    fontScale: 1,
    bottomPaneOpen: false,
};
vi.mock('react-native', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    Platform: { OS: 'web', select: (options: { web?: unknown; default?: unknown }) => options.web ?? options.default },
    useWindowDimensions: () => ({
        width: 1440,
        height: 900,
        scale: 1,
        fontScale: geometry.fontScale,
    }),
}));
vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeId: 'session:s1',
        scopeState: {
            right: { isOpen: false, activeTabId: null },
            details: { isOpen: false, activeTabKey: null },
            bottom: { isOpen: geometry.bottomPaneOpen },
        },
    }),
}));
vi.mock('@/components/appShell/panes/hooks/useAppPaneScopeLayout', () => ({
    useOptionalAppPaneScopeLayout: () => geometry.paneLayout,
}));
vi.mock('@/sync/domains/session/sessionSurfaceVisibility', () => ({
    isSessionSurfaceVisible: () => geometry.mainVisible,
}));
vi.mock('@/hooks/ui/useKeyboardHeight', () => ({
    useKeyboardHeight: () => geometry.keyboardHeightPx,
}));
vi.mock('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry', () => ({
    useSessionCockpitBottomChromeHeight: () => geometry.bottomChromePx,
    useSessionCockpitComposerChromeHeight: () => 0,
}));
vi.mock('react-native-safe-area-context', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    useSafeAreaInsets: () => ({
        top: geometry.safeAreaTopPx,
        bottom: geometry.safeAreaBottomPx,
        left: 0,
        right: 0,
    }),
}));

const storedPreference = { value: undefined as unknown };
const mutate = vi.fn();
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit');
    // Substitute device persistence while retaining the real preference/controller logic.
    return createStorageModuleStub({
        useSessionCompanionPreferenceSlot: () => ({
            stored: storedPreference.value,
            storageKey: 'server-a account-a session-1',
        }),
        useMutateSessionCompanionPreference: () => mutate,
        // The Companion's Appearance frame default (Widgets); unset falls back to the placement default.
        useLocalSetting: () => undefined,
    });
});

vi.mock('@/components/sessions/board/SessionWidgetHost', () => ({
    SessionWidgetHost: () => null,
}));

import { projectSessionBoard } from '@/sync/domains/session/board';
import type { Session } from '@/sync/domains/state/storageTypes';

import { SessionCompanionHost } from './SessionCompanionHost';
import { publishSessionCompanionCardBounds } from './layout/sessionCompanionCardMeasurement';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const session = { id: 'session-1' } as unknown as Session;

const wideLayout = {
    containerWidthPx: 1440,
    containerHeightPx: 900,
    mainRegionHeightPx: 900,
    mainRegionWidthPx: 1000,
    multiPaneEnabled: true,
    deviceType: 'tablet' as const,
    bottomPresentation: 'docked' as const,
    layout: { kind: 'single', right: 'hidden', details: 'hidden' },
};

const render = (input: Readonly<{
    sessionId?: string;
    paneScopeId?: string;
    openFullSurface?: () => void;
}> = {}) => {
    const sessionId = input.sessionId ?? 'session-1';
    const paneScopeId = input.paneScopeId ?? 'session:s1';
    return renderScreen(
    <SessionCompanionHost
        session={{ ...session, id: sessionId }}
        address={{ serverId: 'server-a', sessionId }}
        boardBinding={boardSnapshot()}
        pluginRuntime={{
            serverId: 'server-a',
            machineId: 'machine-from-session-shell',
            pluginUiProjection: null,
            pluginBrowserProjection: null,
            phase: 'current',
            interactionEnabled: true,
            platform: 'web',
        }}
        openFullSurface={input.openFullSurface ?? (() => {})}
        paneScopeId={paneScopeId}
        resolvePrimaryHost={() => 'companion'}
    />,
    );
};

describe('SessionCompanionHost (mounted, desktop/tablet)', () => {
    beforeEach(() => {
        mutate.mockClear();
        mutate.mockImplementation((_sessionId: string, project: (stored: unknown) => unknown) => {
            const next = project(storedPreference.value);
            if (next !== null) storedPreference.value = next;
            return next !== null;
        });
        retirePresentationNotice();
        boardSnapshot.mockReturnValue({
            status: 'ready',
            snapshot: projectSessionBoard({
                layout: undefined,
                items: new Map(),
                capabilities: null,
                freshness: 'fresh',
                reachability: 'reachable',
                loading: 'idle',
                incomplete: false,
            }),
            refresh: () => {},
        });
        geometry.paneLayout = wideLayout;
        geometry.mainVisible = true;
        geometry.keyboardHeightPx = 0;
        geometry.bottomChromePx = 0;
        geometry.safeAreaTopPx = 0;
        geometry.safeAreaBottomPx = 0;
        geometry.fontScale = 1;
        geometry.bottomPaneOpen = false;
        storedPreference.value = {
            v: 1,
            visible: true,
            collapsed: false,
            edge: 'trailing',
            density: 'compact',
            items: [{ kind: 'builtin', id: 'session_summary' }],
        };
        publishSessionCompanionCardBounds({
            sessionId: 'session-1',
            serverId: 'server-a',
            paneScopeId: 'session:s1',
            density: 'compact',
            fontScale: 1,
        }, { widthPx: 280, heightPx: 168 });
    });

    it('reserves a dedicated rail when the pane owner proves the room exists', async () => {
        const renderer = await render();

        expect(renderer.findByTestId('session-companion-reserved-rail')).not.toBeNull();
        expect(renderer.findByTestId('session-companion-content')).not.toBeNull();
    });

    it('measures outer rail bounds and stabilizes repeated cold/visible layout cycles at the readable child floor', async () => {
        const openFullSurface = vi.fn();
        const renderer = await render({
            sessionId: 'session-bootstrap',
            paneScopeId: 'session:session-bootstrap',
            openFullSurface,
        });

        expect(renderer.findByTestId('session-companion-reserved-rail')).toBeNull();
        const probe = renderer.findByTestId('session-companion-measurement-rail');
        expect(probe).not.toBeNull();
        expect(flattenTestStyle(probe?.props.style).width).toBe(264);
        expect(probe?.props.pointerEvents).toBe('none');
        expect(probe?.props.accessibilityElementsHidden).toBe(true);
        expect(probe?.props.importantForAccessibility).toBe('no-hide-descendants');
        // Exercise the installed DOM boundary, not the RN test stub: native-only
        // hidden props do not prevent RN-web descendants from receiving focus.
        // The shared CJS shim intentionally stubs the bare RN-web specifier.
        // Resolve its installed View entry to exercise the real DOM adapter.
        const nodeRequire = createRequire(import.meta.url);
        const WebView = nodeRequire(nodeRequire.resolve('react-native-web/dist/cjs/exports/View/index.js')) as typeof import('react-native')['View'];
        const measurementHtml = renderToStaticMarkup(React.createElement(
            WebView,
            probe?.props,
            React.createElement('button', { type: 'button' }, 'Summary destination'),
        ));
        expect(measurementHtml).toContain('inert=""');
        expect(measurementHtml).toContain('aria-hidden="true"');

        const card = renderer.findByTestId(
            'session-companion-measurement-content-item-builtin:session_summary',
        );
        React.act(() => card?.props.onLayout?.({
            nativeEvent: { layout: { x: 0, y: 0, width: 240, height: 168 } },
        }));

        expect(renderer.findByTestId('session-companion-measurement-rail')).toBeNull();
        const visibleRail = renderer.findByTestId('session-companion-reserved-rail');
        expect(flattenTestStyle(visibleRail?.props.style).width).toBe(264);
        expect(renderer.findByTestId('session-companion-content')).not.toBeNull();
        const visibleHtml = renderToStaticMarkup(React.createElement(
            WebView,
            visibleRail?.props,
            React.createElement('button', { type: 'button' }, 'Summary destination'),
        ));
        expect(visibleHtml).not.toContain('inert=""');
        expect(visibleHtml).not.toContain('aria-hidden="true"');

        const visibleCard = renderer.findByTestId(
            'session-companion-content-item-builtin:session_summary',
        );
        React.act(() => visibleCard?.props.onLayout?.({
            nativeEvent: { layout: { x: 0, y: 0, width: 240, height: 168 } },
        }));

        expect(flattenTestStyle(
            renderer.findByTestId('session-companion-reserved-rail')?.props.style,
        ).width).toBe(264);
        expect(openFullSurface).not.toHaveBeenCalled();
    });

    it.each(['internal', 'external'] as const)(
        'uses the pane owner\'s already header/safe-area-adjusted height in %s header mode',
        async (headerMode) => {
            const sessionId = `session-safe-area-${headerMode}`;
            const paneScopeId = `session:${sessionId}`;
            geometry.safeAreaTopPx = 100;
            geometry.paneLayout = {
                ...wideLayout,
                containerHeightPx: 500,
                mainRegionHeightPx: 400,
            };
            publishSessionCompanionCardBounds({
                sessionId,
                serverId: 'server-a',
                paneScopeId,
                density: 'compact',
                fontScale: 1,
            }, { widthPx: 280, heightPx: 350 });

            const renderer = await render({ sessionId, paneScopeId });

            expect(renderer.findByTestId('session-companion-reserved-rail')).not.toBeNull();
        },
    );

    it('does not borrow a measurement from another exact Session identity', async () => {
        publishSessionCompanionCardBounds({
            sessionId: 'session-other',
            serverId: 'server-a',
            paneScopeId: 'session:session-isolated',
            density: 'compact',
            fontScale: 1,
        }, { widthPx: 280, heightPx: 168 });

        const renderer = await render({
            sessionId: 'session-isolated',
            paneScopeId: 'session:session-isolated',
        });

        expect(renderer.findByTestId('session-companion-reserved-rail')).toBeNull();
        expect(renderer.findByTestId('session-companion-measurement-rail')).not.toBeNull();
    });

    it('keeps a known oversized card collapsed without treating it as missing measurement', async () => {
        publishSessionCompanionCardBounds({
            sessionId: 'session-oversized',
            serverId: 'server-a',
            paneScopeId: 'session:session-oversized',
            density: 'compact',
            fontScale: 1,
        }, { widthPx: 900, heightPx: 168 });

        const renderer = await render({
            sessionId: 'session-oversized',
            paneScopeId: 'session:session-oversized',
        });

        expect(renderer.findByTestId('session-companion-reserved-rail')).toBeNull();
    });

    // A styled line of text is a heading to sighted readers and nothing at all to
    // a screen reader, which then has no way into the rail except arrowing.
    it('names the rail with a real heading', async () => {
        const renderer = await render();

        expect(renderer.findByTestId('session-companion-reserved-rail-heading')?.props.accessibilityRole)
            .toBe('header');
    });

    it('yields to the canonical header affordance instead of squeezing Chat when the main region narrows', async () => {
        geometry.paneLayout = { ...wideLayout, mainRegionWidthPx: 600 };
        const renderer = await render();

        expect(renderer.findByTestId('session-companion-reserved-rail')).toBeNull();
        expect(renderer.findByTestId('session-companion-collapsed-control')).toBeNull();
    });

    it('collapses rather than letting the software keyboard overlap the card', async () => {
        geometry.paneLayout = { ...wideLayout, containerHeightPx: 500, mainRegionHeightPx: 500 };
        geometry.keyboardHeightPx = 400;
        const renderer = await render();

        expect(renderer.findByTestId('session-companion-reserved-rail')).toBeNull();
        expect(renderer.findByTestId('session-companion-collapsed-control')).toBeNull();
    });

    it('collapses when pane geometry has not been measured, never guessing a width', async () => {
        geometry.paneLayout = null;
        const renderer = await render();

        expect(renderer.findByTestId('session-companion-reserved-rail')).toBeNull();
        expect(renderer.findByTestId('session-companion-collapsed-control')).toBeNull();
    });

    it('mounts nothing behind a hidden main region', async () => {
        geometry.mainVisible = false;
        const hidden = await render();
        expect(hidden.findByTestId('session-companion-reserved-rail')).toBeNull();
        expect(hidden.findByTestId('session-companion-collapsed-control')).toBeNull();
    });

    it('keeps the rail for an open docked bottom pane and consumes its reduced main-region height', async () => {
        geometry.bottomPaneOpen = true;
        geometry.paneLayout = {
            ...wideLayout,
            mainRegionHeightPx: 520,
            bottomPresentation: 'docked',
        };

        const docked = await render();
        expect(docked.findByTestId('session-companion-reserved-rail')).not.toBeNull();

        geometry.paneLayout = {
            ...wideLayout,
            mainRegionHeightPx: 120,
            bottomPresentation: 'docked',
        };
        const obstructed = await render();
        expect(obstructed.findByTestId('session-companion-reserved-rail')).toBeNull();
    });

    it('hides only while an open bottom pane is actually presented as an overlay', async () => {
        geometry.paneLayout = { ...wideLayout, bottomPresentation: 'overlay' };

        const closedOverlayCapability = await render();
        expect(closedOverlayCapability.findByTestId('session-companion-reserved-rail')).not.toBeNull();

        geometry.bottomPaneOpen = true;
        const modal = await render();
        expect(modal.findByTestId('session-companion-reserved-rail')).toBeNull();
        expect(modal.findByTestId('session-companion-collapsed-control')).toBeNull();
    });

    it('renders nothing at all for a hidden preference and writes no default on mount', async () => {
        storedPreference.value = undefined;
        const renderer = await render();

        expect(renderer.findByTestId('session-companion-reserved-rail')).toBeNull();
        expect(renderer.findByTestId('session-companion-collapsed-control')).toBeNull();
        expect(mutate).not.toHaveBeenCalled();
    });

    it('exposes the full controller surface from one reachable menu', async () => {
        const renderer = await render();
        const [menu] = renderer.findAll((node) => (
            node.props?.overflowTriggerTestID === 'session-companion-menu'
        ));
        const ids = (menu?.props.actions as ReadonlyArray<{ id: string }>).map((action) => action.id);

        expect(ids).toEqual([
            'edge-leading',
            'edge-trailing',
            'density-compact',
            'density-comfortable',
            'open-full',
            'collapse',
            'hide',
        ]);
    });

    it('routes rail edge, density, collapse, and hide through applied-only feedback', async () => {
        const renderer = await render();
        const [menu] = renderer.findAll((node) => (
            node.props?.overflowTriggerTestID === 'session-companion-menu'
        ));
        const actions = menu?.props.actions as ReadonlyArray<{ id: string; onPress?: () => void }>;

        actions.find((action) => action.id === 'edge-leading')?.onPress?.();
        expect(readPresentationNotice()).toMatchObject({ message: 'sessionBoard.companion.notices.moved' });
        retirePresentationNotice();

        actions.find((action) => action.id === 'density-comfortable')?.onPress?.();
        expect(readPresentationNotice()).toMatchObject({ message: 'sessionBoard.companion.actions.comfortable' });
        retirePresentationNotice();

        actions.find((action) => action.id === 'collapse')?.onPress?.();
        expect(readPresentationNotice()).toMatchObject({ message: 'sessionBoard.companion.actions.collapse' });
        retirePresentationNotice();

        actions.find((action) => action.id === 'hide')?.onPress?.();
        expect(readPresentationNotice()).toMatchObject({
            message: 'sessionBoard.companion.notices.hidden',
            undo: { label: 'sessionBoard.companion.actions.undo' },
        });
    });
});
