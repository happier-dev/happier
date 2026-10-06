import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { SessionCompanionContent } from '../companion/SessionCompanionContent';
import { HIDDEN_SESSION_COMPANION_PREFERENCE_V1 } from '../companion/state/sessionCompanionPreference';
import type { SessionCompanionController } from '../companion/state/useSessionCompanionController';
import type { CallerHostedHtmlRuntime } from '@/components/ui/surfaces/hostedHtml/HostedHtmlSurfaceAdapter';
import { SessionBoardSurface } from './SessionBoardSurface';
import {
    createSessionBoardActionsPort,
    projectSessionBoard,
    type SessionBoardSnapshot,
} from '@/sync/domains/session/board';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

import { SessionBoardContinuityProvider, useSessionBoardContinuity } from './SessionBoardContinuity';
import {
    SessionBoardControllerOwner,
    useMountedSessionBoardController,
    type MountedSessionBoardController,
} from './SessionBoardControllerProvider';
import {
    resolveSessionBoardHostVisibility,
    resolveSessionBoardItemPrimaryMountHost,
    type SessionBoardPlacementPrimaryMountResolver,
} from './sessionBoardHostVisibility';

const ADDRESS: SessionAddress = { serverId: 'home-1', sessionId: 'session-1' };
// The physical browser frame is the only substituted boundary. Viewport, controller,
// Companion, widget host, admission and hosted-frame lifecycle remain real.
const frames = vi.hoisted(() => ({ active: 0, maximum: 0 }));
vi.mock('@/components/browser/frame/BrowserViewFrame.web', () => ({
    BrowserViewFrame: () => {
        React.useEffect(() => {
            frames.active += 1;
            frames.maximum = Math.max(frames.maximum, frames.active);
            return () => { frames.active -= 1; };
        }, []);
        return React.createElement('BrowserViewFrame');
    },
}));
const actions = createSessionBoardActionsPort(ADDRESS);
const pluginRuntime = {
    pluginUiProjection: null,
    pluginBrowserProjection: null,
    phase: 'unavailable' as const,
    interactionEnabled: false,
    machineId: null,
    serverId: ADDRESS.serverId,
    platform: 'web' as const,
};

/** View A holds item A, view B holds item B. */
function twoViewSnapshot(): SessionBoardSnapshot {
    return projectSessionBoard({
        layout: {
            revision: 'ssr1:layout',
            outcome: {
                status: 'ready',
                value: {
                    v: 1,
                    tabs: [
                        { id: 'view-a', title: 'A', items: [{ itemId: 'item-a', width: 'medium' }] },
                        { id: 'view-b', title: 'B', items: [{ itemId: 'item-b', width: 'medium' }] },
                    ],
                },
            },
        },
        items: new Map(),
        capabilities: { readTranscript: true, editSessionRecords: true },
        freshness: 'fresh',
        reachability: 'reachable',
        loading: 'idle',
        incomplete: false,
    } as Parameters<typeof projectSessionBoard>[0]);
}

// The Session shell's real derivation for this window: a generic Board tab is the
// active Details tab and the Companion rail is reserved, with both items in it.
const visibility = resolveSessionBoardHostVisibility({
    foreground: true,
    panes: {
        detailsOpen: true,
        detailsShowsBoard: true,
        detailsShowsGenericBoard: true,
        detailsExpandedItemIds: [],
        detailsFocusModeActive: false,
        rightOpen: false,
        rightActiveTabId: null,
    },
    companionPlacement: { kind: 'reserved_rail', edge: 'trailing', widthPx: 280 },
    mobileSurface: null,
});
const shellResolver: SessionBoardPlacementPrimaryMountResolver = (itemId, destination, boardView) => (
    resolveSessionBoardItemPrimaryMountHost({
        visibility,
        itemVisibleInCompanion: true,
        itemId,
        ...(destination ? { detailsDestination: destination } : {}),
        ...(boardView ? { boardView } : {}),
    })
);

type Probe = {
    mounted: MountedSessionBoardController | null;
    continuity: ReturnType<typeof useSessionBoardContinuity>;
};

function ProbeReader(props: Readonly<{ probe: Probe }>): React.ReactElement {
    const mounted = useMountedSessionBoardController(ADDRESS)!;
    props.probe.mounted = mounted;
    props.probe.continuity = useSessionBoardContinuity(ADDRESS);
    return <SessionBoardSurface sessionId={ADDRESS.sessionId} controller={mounted.controller}
        host="details" density="full" layout="single" resolvePrimaryHost={mounted.resolvePrimaryHost}
        onBodyEligibilityChange={mounted.onBodyEligibilityChange} />;
}

function Harness(props: Readonly<{ probe: Probe }>): React.ReactElement {
    const binding = { status: 'ready' as const, snapshot: twoViewSnapshot() };
    return (
        <SessionBoardContinuityProvider sessionId={ADDRESS.sessionId} serverId={ADDRESS.serverId}>
            <SessionBoardControllerOwner
                address={ADDRESS}
                input={{ sessionId: ADDRESS.sessionId, serverId: ADDRESS.serverId, binding, actions }}
                binding={binding}
                actions={actions}
                pluginRuntime={pluginRuntime}
                callerHostedHtmlRuntime={null}
                resolvePrimaryHost={shellResolver}
            >
                <ProbeReader probe={props.probe} />
            </SessionBoardControllerOwner>
        </SessionBoardContinuityProvider>
    );
}

afterEach(() => { standardCleanup(); });
beforeAll(async () => { await loadSyncSingletonForTests(); });

const session = createSessionFixture({ id: ADDRESS.sessionId, serverId: ADDRESS.serverId });
const available = () => ({ kind: 'available' as const });
const callerRuntime: CallerHostedHtmlRuntime = {
    serverIdentityId: 'home-1', accountId: 'alice', hostOrigin: 'https://app.example.test',
    admittedHostMethods: [], isApproved: () => true, approve: () => {}, revoke: () => {},
    createRequestController: () => ({ handleRequest: async () => null, dispose: () => {} }),
    lifetime: { isCurrent: () => true, onRetire: () => ({ dispose: () => {} }) },
};
const companion: SessionCompanionController = {
    preference: { ...HIDDEN_SESSION_COMPANION_PREFERENCE_V1, visible: true, items: [{ kind: 'widget', widgetId: 'item-b' }] },
    availability: 'ready', preferenceExists: true, realmKey: 'alice:home-1:session-1',
    show: () => null, hide: () => null, setCollapsed: () => null, setEdge: () => null, setDensity: () => null,
    addItem: () => null, removeItem: () => null, moveItem: () => null, setItemFrameStyle: () => null, applyLocalInverse: () => false,
    setInstanceInputs: () => { throw new Error('Instance input mutation is outside this mount fixture'); },
    renameInstance: () => { throw new Error('Instance rename is outside this mount fixture'); },
    openFullSurface: () => {},
};
function viewportSnapshot(recovered: boolean): SessionBoardSnapshot {
    return projectSessionBoard({
        layout: { revision: 'ssr1:layout', outcome: { status: 'ready', value: { v: 1, tabs: [{
            id: 'view-a', title: 'A', items: recovered ? [] : [{ itemId: 'item-b', width: 'full' }],
        }] } } },
        items: new Map([['item-b', { revision: 'ssr1:item', outcome: { status: 'ready', value: {
            v: 1, title: 'B', frame: 'card', height: { mode: 'fixed', size: 'regular' },
            source: { kind: 'hostedHtml', source: { kind: 'html', html: '<main>One live B</main>' } },
        } } }]]),
        capabilities: { readTranscript: true, editSessionRecords: true }, freshness: 'fresh',
        reachability: 'reachable', loading: 'idle', incomplete: false,
    });
}
function ViewportContents(props: Readonly<{ probe: Probe; expanded: boolean; retained: boolean; boardVisible: boolean }>): React.ReactElement {
    const mounted = useMountedSessionBoardController(ADDRESS)!;
    props.probe.mounted = mounted;
    props.probe.continuity = useSessionBoardContinuity(ADDRESS);
    return <>
        {props.boardVisible ? <SessionBoardSurface
            sessionId={ADDRESS.sessionId} session={session} controller={mounted.controller}
            host="details" density="full" layout="single"
            retained={props.retained} onBodyEligibilityChange={mounted.onBodyEligibilityChange}
            resolvePrimaryHost={(itemId) => mounted.resolvePrimaryHost(itemId, { detailsDestinationItemId: null })}
            callerHostedHtmlRuntime={callerRuntime}
        /> : null}
        {props.expanded ? <SessionBoardSurface
            sessionId={ADDRESS.sessionId} session={session} controller={mounted.controller}
            host="details" density="full" layout="single" focusedItemId="item-b" testID="expanded"
            resolvePrimaryHost={(itemId) => mounted.resolvePrimaryHost(itemId, { detailsDestinationItemId: 'item-b' })}
            callerHostedHtmlRuntime={callerRuntime}
        /> : null}
        <SessionCompanionContent session={session} serverId={ADDRESS.serverId} controller={companion}
            boardBinding={mounted.binding} resolvePrimaryHost={mounted.resolvePrimaryHost}
            callerHostedHtmlRuntime={callerRuntime} resolveSourceAvailability={available} />
    </>;
}
function ViewportHarness(props: Readonly<{ probe: Probe; recovered: boolean; expanded?: boolean; retained?: boolean; boardVisible?: boolean }>): React.ReactElement {
    const binding = React.useMemo(() => ({ status: 'ready' as const, snapshot: viewportSnapshot(props.recovered) }), [props.recovered]);
    const resolve = React.useCallback<SessionBoardPlacementPrimaryMountResolver>((itemId, destination, boardView) => (
        resolveSessionBoardItemPrimaryMountHost({ visibility: {
            ...visibility, detailsExpandedItemIds: props.expanded ? ['item-b'] : [],
        }, itemVisibleInCompanion: true, itemId, detailsDestination: destination, boardView })
    ), [props.expanded]);
    return <SessionBoardContinuityProvider sessionId={ADDRESS.sessionId} serverId={ADDRESS.serverId}>
        <SessionBoardControllerOwner address={ADDRESS}
            input={{ ...ADDRESS, binding, actions, resolveSourceAvailability: available }}
            binding={binding} actions={actions} pluginRuntime={pluginRuntime}
            callerHostedHtmlRuntime={callerRuntime} resolvePrimaryHost={resolve}>
            <ViewportContents probe={props.probe} expanded={props.expanded === true} retained={props.retained === true}
                boardVisible={props.boardVisible !== false} />
        </SessionBoardControllerOwner>
    </SessionBoardContinuityProvider>;
}

describe('mounted Session Board primary placement', () => {
    it.each([false, true])('hands the one live frame across body windows, retirement and re-entry (recovered=%s)', async (recovered) => {
        frames.active = 0;
        frames.maximum = 0;
        const probe: Probe = { mounted: null, continuity: null };
        const screen = await renderScreen(<ViewportHarness probe={probe} recovered={recovered} />);
        const node = (testID: string) => screen.tree.root.findAll((candidate) => candidate.props.testID === testID).at(-1)!;
        await act(async () => {
            node('session-board-scroll').props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 800, height: 600 } } });
            node(recovered ? 'session-board-recovered-row-item-b' : 'session-board-placement-item-b').props.onLayout({
                nativeEvent: { layout: { x: 0, y: 5000, width: 800, height: 200 } },
            });
        });
        expect(probe.mounted!.resolvePrimaryHost('item-b')).toBe('companion');
        expect(frames.active).toBe(1);
        const expectFrameIn = (testID: string) => expect(node(testID).findAll((candidate) => String(candidate.type) === 'BrowserViewFrame')).toHaveLength(1);
        expectFrameIn('session-companion-widget-item-b');
        const scroll = async (y: number) => await act(async () => {
            node('session-board-scroll').props.onScroll({ nativeEvent: {
                contentOffset: { y }, contentSize: { width: 800, height: 6000 },
                layoutMeasurement: { width: 800, height: 600 },
            } });
        });
        await scroll(4800);
        expect(probe.mounted!.resolvePrimaryHost('item-b')).toBe('details');
        expect(frames.active).toBe(1);
        expectFrameIn(recovered ? 'session-board-recovered-row-item-b' : 'session-board-placement-item-b');
        await scroll(0);
        expect(probe.mounted!.resolvePrimaryHost('item-b')).toBe('companion');
        expect(frames.active).toBe(1);
        expectFrameIn('session-companion-widget-item-b');
        await screen.update(<ViewportHarness probe={probe} recovered={recovered} expanded />);
        expect(probe.mounted!.resolvePrimaryHost('item-b')).toBe('details');
        expect(frames.active).toBe(1);
        expectFrameIn('expanded-focused');
        await screen.update(<ViewportHarness probe={probe} recovered={recovered} />);
        await scroll(4800);
        expect(probe.mounted!.resolvePrimaryHost('item-b')).toBe('details');
        await screen.update(<ViewportHarness probe={probe} recovered={recovered} retained />);
        expect(probe.mounted!.resolvePrimaryHost('item-b')).toBe('companion');
        expectFrameIn('session-companion-widget-item-b');
        await screen.update(<ViewportHarness probe={probe} recovered={recovered} />);
        expect(probe.mounted!.resolvePrimaryHost('item-b')).toBe('details');
        await screen.update(<ViewportHarness probe={probe} recovered={recovered} boardVisible={false} />);
        expect(probe.mounted!.resolvePrimaryHost('item-b')).toBe('companion');
        expectFrameIn('session-companion-widget-item-b');
        await screen.update(<ViewportHarness probe={probe} recovered={recovered} />);
        expect(probe.mounted!.resolvePrimaryHost('item-b')).toBe('details');
        expect(frames.active).toBe(1);
        expect(frames.maximum).toBe(1);
    });

    it('never elects a Board tab for an item its selected view does not draw', async () => {
        const probe: Probe = { mounted: null, continuity: null };
        const screen = await renderScreen(<Harness probe={probe} />);
        const rerender = async () => await screen.update(<Harness probe={probe} />);
        await act(async () => { probe.continuity!.viewSelection.request('view-a'); });
        await rerender();
        expect(probe.mounted!.controller.activeView?.id).toBe('view-a');

        // The Details grid shows view A, which does not draw item B: the Companion runs it.
        expect(probe.mounted!.resolvePrimaryHost('item-b')).toBe('companion');
        // Item A is drawn by the Details grid, which outranks the Companion.
        expect(probe.mounted!.resolvePrimaryHost('item-a')).toBe('details');

        // Switching the Board to view B hands item B's one live mount to Details.
        await act(async () => { probe.continuity!.viewSelection.request('view-b'); });
        await rerender();
        expect(probe.mounted!.controller.activeView?.id).toBe('view-b');
        expect(probe.mounted!.resolvePrimaryHost('item-b')).toBe('details');
        expect(probe.mounted!.resolvePrimaryHost('item-a')).toBe('companion');

        // And back: the mount returns to the Companion.
        await act(async () => { probe.continuity!.viewSelection.request('view-a'); });
        await rerender();
        expect(probe.mounted!.resolvePrimaryHost('item-b')).toBe('companion');
    });
});
