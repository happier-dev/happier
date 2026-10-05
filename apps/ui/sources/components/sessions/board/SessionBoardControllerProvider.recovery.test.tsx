import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { SessionBoardSnapshot } from '@/sync/domains/session/board';

/**
 * Recovery and orientation reach the mounted product surface.
 *
 * Each behaviour here was already implemented and unit-green at the controller
 * while having NO production caller: the Board's locked-layout card asked
 * `supports('item.prepareEncryption')`, which no mounted host ever answered
 * `true`, and the approved "Ask the agent" orientation action had no producer at
 * all. These tests mount the real provider, the real controller and the real
 * Board surface, so a green result means the person can actually get out.
 */

const harness = vi.hoisted(() => ({
    layoutLocked: false,
    removalMode: 'none' as 'none' | 'populated' | 'empty',
    openResult: 'opened' as 'opened' | 'blocked',
    openRoute: vi.fn(),
    openAccountSecurity: vi.fn(),
    push: vi.fn(),
    alert: vi.fn(),
    show: vi.fn(),
    confirm: vi.fn(),
}));

function nodeHasTestId(element: unknown, testID: string): boolean {
    if (typeof element !== 'object' || element === null || !('props' in element)) return false;
    const props = element.props;
    return typeof props === 'object'
        && props !== null
        && 'testID' in props
        && props.testID === testID;
}

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: harness.push } }).module;
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: {
        alert: harness.alert,
        show: harness.show,
        confirm: harness.confirm,
    } }).module;
});
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ refreshFromActiveServer: vi.fn(async () => undefined) }),
}));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({ useFeatureEnabled: () => true }));
vi.mock('@/sync/domains/server/selection/openRouteWithEstablishedHome', () => ({
    openRouteWithEstablishedHome: async (input: Readonly<{ serverId: string; navigate: () => void }>) => {
        harness.openRoute(input);
        if (harness.openResult === 'opened') input.navigate();
        return harness.openResult;
    },
}));
vi.mock('@/components/settings/account/openAccountSecurityForHome', () => ({
    openAccountSecurityForHome: async (input: Readonly<{ serverId: string }>) => {
        harness.openAccountSecurity(input);
        return harness.openResult === 'opened';
    },
}));
vi.mock('@/components/sessions/plugins/useSessionPluginRuntime', () => ({
    useSessionPluginRuntime: () => ({ serverId: 'home-1', machineId: null, pluginUiProjection: null }),
}));
vi.mock('@/components/ui/surfaces/hostedHtml/useSessionCallerHostedHtmlRuntime', () => ({
    useSessionCallerHostedHtmlRuntime: () => null,
}));
vi.mock('@/components/widgets/widgetCatalog', () => ({
    selectWidgetCandidates: () => [],
    selectCurrentSessionWidgetCandidates: () => [],
}));
vi.mock('@/components/sessions/companion/state/useSessionCompanionController', () => ({
    useSessionCompanionController: () => ({
        preference: { items: [] },
        availability: 'unavailable',
        show: vi.fn(),
        removeItem: vi.fn(),
    }),
}));
vi.mock('@/components/sessions/presentation/presentationNotices', () => ({
    publishPresentationNotice: vi.fn(),
}));
vi.mock('./useSessionBoardHostActionBindings', () => ({
    useSessionBoardHostActionBindings: () => undefined,
}));
// The editor wrapper selects its platform module through a bundler-only require.
vi.mock('@/components/ui/code/editor/CodeEditor', () => ({ CodeEditor: () => null }));

function boardSnapshot(): SessionBoardSnapshot {
    const removalViews = harness.removalMode === 'none'
        ? [{ id: 'overview', title: null, synthetic: true, placements: [] }]
        : [
            { id: 'overview', title: null, synthetic: true, placements: [] },
            {
                id: 'research',
                title: 'Research',
                synthetic: false,
                placements: harness.removalMode === 'populated'
                    ? [{ itemId: 'item-1', width: 'medium' as const }]
                    : [],
            },
        ];
    return {
        layoutState: harness.layoutLocked ? { kind: 'locked' } : { kind: 'ready' },
        layoutRevision: 'rev-layout',
        views: removalViews,
        itemsById: new Map([['item-1', {
            itemId: 'item-1',
            revision: 'rev-item-1',
            state: {
                kind: 'ready',
                item: {
                    v: 1,
                    title: 'Status',
                    frame: 'card',
                    height: { mode: 'auto', fallback: 'regular' },
                    source: {
                        kind: 'widget',
                        instance: { v: 1, id: 'instance-1', definition: { kind: 'installed', surface: { pluginId: 'acme.board', localId: 'status' } }, bindings: {} },
                    },
                },
            },
        }]]),
        unplacedItemIds: ['item-1'],
        capabilities: { readTranscript: true, editSessionRecords: true },
        canEdit: true,
        freshness: 'fresh',
        reachability: 'reachable',
        loading: 'idle',
        incomplete: false,
    } as unknown as SessionBoardSnapshot;
}

vi.mock('./useSessionBoardSnapshot', () => ({
    useSessionBoardSnapshot: () => ({ status: 'ready', refresh: vi.fn(), snapshot: boardSnapshot() }),
}));

import { SessionBoardControllerProvider, useMountedSessionBoardController } from './SessionBoardControllerProvider';
import { SessionBoardPane } from './SessionBoardPane';
import type { SessionBoardController } from './useSessionBoardController';

let observedController: SessionBoardController | null = null;

function ControllerProbe(): React.ReactElement | null {
    observedController = useMountedSessionBoardController({ serverId: 'home-1', sessionId: 'session-1' })?.controller ?? null;
    return null;
}

function AddressedControllerProbe(props: Readonly<{
    serverId: string;
    sessionId: string;
    onController: (controller: SessionBoardController | null) => void;
}>): React.ReactElement | null {
    props.onController(useMountedSessionBoardController({
        serverId: props.serverId,
        sessionId: props.sessionId,
    })?.controller ?? null);
    return null;
}

async function mountBoard(): Promise<Awaited<ReturnType<typeof renderScreen>>> {
    return await renderScreen(
        <SessionBoardControllerProvider sessionId="session-1" serverId="home-1">
            <ControllerProbe />
            <SessionBoardPane
                sessionId="session-1"
                serverId="home-1"
                host="details"
                resolvePrimaryHost={() => 'details'}
                density="full"
                layout="grid"
            />
        </SessionBoardControllerProvider>,
    );
}

describe('mounted Board recovery navigation', () => {
    beforeEach(() => {
        standardCleanup();
        observedController = null;
        harness.layoutLocked = false;
        harness.removalMode = 'none';
        harness.openResult = 'opened';
        harness.openRoute.mockReset();
        harness.openAccountSecurity.mockReset();
        harness.push.mockReset();
        harness.alert.mockReset();
        harness.show.mockReset();
        harness.show.mockImplementation((config: Readonly<{ onRequestClose?: () => void }>) => {
            queueMicrotask(() => config.onRequestClose?.());
            return 'modal-id';
        });
        harness.confirm.mockReset();
        harness.confirm.mockResolvedValue(false);
    });

    it('gives a locked shared layout a reachable encryption recovery in the mounted Board', async () => {
        harness.layoutLocked = true;
        const screen = await mountBoard();

        const action = screen.findByTestId('session-board-pane-surface-state-action');
        expect(action).toBeTruthy();
        await act(async () => { await action?.props.onPress?.(); });

        expect(harness.openAccountSecurity).toHaveBeenCalledWith(
            expect.objectContaining({ serverId: 'home-1' }),
        );
    });

    it('reports a blocked Home switch instead of silently dropping encryption recovery', async () => {
        harness.layoutLocked = true;
        harness.openResult = 'blocked';
        await mountBoard();

        await act(async () => { await observedController?.run({ kind: 'item.prepareEncryption' }); });

        expect(harness.openAccountSecurity).toHaveBeenCalledWith(
            expect.objectContaining({ serverId: 'home-1' }),
        );
        expect(harness.alert).toHaveBeenCalledWith('Error', 'An unknown error occurred');
    });

    it('establishes the exact Session Home before opening an installed plugin recovery route', async () => {
        await mountBoard();

        expect(observedController?.supports('item.managePlugin')).toBe(true);
        await act(async () => { await observedController?.run({ kind: 'item.managePlugin', itemId: 'item-1' }); });

        expect(harness.openRoute).toHaveBeenCalledWith(expect.objectContaining({ serverId: 'home-1' }));
        expect(harness.push).toHaveBeenCalledWith(expect.objectContaining({
            params: { pluginId: 'acme.board' },
        }));
    });

    it('constructs a legitimate nested owner instead of borrowing a different exact Session', async () => {
        let outerController: SessionBoardController | null = null;
        let innerController: SessionBoardController | null = null;

        await renderScreen(
            <SessionBoardControllerProvider sessionId="session-1" serverId="home-1">
                <AddressedControllerProbe
                    serverId="home-1"
                    sessionId="session-1"
                    onController={(controller) => { outerController = controller; }}
                />
                <SessionBoardControllerProvider sessionId="session-2" serverId="home-1">
                    <AddressedControllerProbe
                        serverId="home-1"
                        sessionId="session-2"
                        onController={(controller) => { innerController = controller; }}
                    />
                </SessionBoardControllerProvider>
            </SessionBoardControllerProvider>,
        );

        expect(outerController).toBeTruthy();
        expect(innerController).toBeTruthy();
        expect(innerController).not.toBe(outerController);
    });

    it('replaces viewer-local controller and drafts when the provider address changes', async () => {
        const probeState: { current: SessionBoardController | null } = { current: null };

        function Probe(props: Readonly<{ serverId: string }>) {
            probeState.current = useMountedSessionBoardController({
                serverId: props.serverId,
                sessionId: 'session-1',
            })?.controller ?? null;
            return null;
        }

        const renderOwner = (serverId: string) => (
            <SessionBoardControllerProvider sessionId="session-1" serverId={serverId}>
                <Probe serverId={serverId} />
            </SessionBoardControllerProvider>
        );
        const screen = await renderScreen(renderOwner('home-1'));
        const firstController = probeState.current;
        await act(async () => {
            await probeState.current?.run({ kind: 'add', intent: 'note' });
        });
        expect(probeState.current?.noteDraft).not.toBeNull();

        await screen.update(renderOwner('home-2'));

        expect(probeState.current).not.toBe(firstController);
        expect(probeState.current?.noteDraft).toBeNull();
    });

    it('registers the mounted view tab as the disposition modal focus-return target', async () => {
        harness.removalMode = 'populated';
        const researchFocus = vi.fn();
        await renderScreen(
            <SessionBoardControllerProvider sessionId="session-1" serverId="home-1">
                <ControllerProbe />
                <SessionBoardPane
                    sessionId="session-1"
                    serverId="home-1"
                    host="details"
                    resolvePrimaryHost={() => 'details'}
                    density="full"
                    layout="grid"
                />
            </SessionBoardControllerProvider>,
            {
                createNodeMock: (element) => nodeHasTestId(element, 'session-board-pane-surface-views-view-research')
                    ? { focus: researchFocus }
                    : {},
            },
        );

        await act(async () => {
            await observedController?.run({ kind: 'view.remove', viewId: 'research' });
        });

        const modalConfig = harness.show.mock.calls[0]?.[0] as Readonly<{
            focusReturnRef?: Readonly<{ current: Readonly<{ focus?: () => void }> | null }>;
        }> | undefined;
        expect(modalConfig?.focusReturnRef?.current).toBeTruthy();
        modalConfig?.focusReturnRef?.current?.focus?.();
        expect(researchFocus).toHaveBeenCalledOnce();
    });

    it('gives item removal the exact source-view focus target', async () => {
        harness.removalMode = 'populated';
        const researchFocus = vi.fn();
        await renderScreen(
            <SessionBoardControllerProvider sessionId="session-1" serverId="home-1">
                <ControllerProbe />
                <SessionBoardPane
                    sessionId="session-1"
                    serverId="home-1"
                    host="details"
                    resolvePrimaryHost={() => 'details'}
                    density="full"
                    layout="grid"
                />
            </SessionBoardControllerProvider>,
            {
                createNodeMock: (element) => nodeHasTestId(element, 'session-board-pane-surface-views-view-research')
                    ? { focus: researchFocus }
                    : {},
            },
        );

        await act(async () => {
            await observedController?.run({ kind: 'view.select', viewId: 'research' });
        });
        await act(async () => {
            await observedController?.run({ kind: 'item.remove', itemId: 'item-1' });
        });

        const confirmOptions = harness.confirm.mock.calls[0]?.[2] as Readonly<{
            focusReturnRef?: Readonly<{ current: Readonly<{ focus?: () => void }> | null }>;
        }> | undefined;
        expect(confirmOptions?.focusReturnRef?.current).toBeTruthy();
        confirmOptions?.focusReturnRef?.current?.focus?.();
        expect(researchFocus).toHaveBeenCalledOnce();
    });

    it('gives the destructive confirmation the exact source-tab focus target', async () => {
        harness.removalMode = 'empty';
        const researchFocus = vi.fn();
        await renderScreen(
            <SessionBoardControllerProvider sessionId="session-1" serverId="home-1">
                <ControllerProbe />
                <SessionBoardPane
                    sessionId="session-1"
                    serverId="home-1"
                    host="details"
                    resolvePrimaryHost={() => 'details'}
                    density="full"
                    layout="grid"
                />
            </SessionBoardControllerProvider>,
            {
                createNodeMock: (element) => nodeHasTestId(element, 'session-board-pane-surface-views-view-research')
                    ? { focus: researchFocus }
                    : {},
            },
        );

        await act(async () => {
            await observedController?.run({ kind: 'view.remove', viewId: 'research' });
        });

        const confirmOptions = harness.confirm.mock.calls[0]?.[2] as Readonly<{
            focusReturnRef?: Readonly<{ current: Readonly<{ focus?: () => void }> | null }>;
        }> | undefined;
        expect(confirmOptions?.focusReturnRef?.current).toBeTruthy();
        confirmOptions?.focusReturnRef?.current?.focus?.();
        expect(researchFocus).toHaveBeenCalledOnce();
    });
});
