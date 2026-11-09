import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { SessionCompanionContent } from '../companion/SessionCompanionContent';
import { HIDDEN_SESSION_COMPANION_PREFERENCE_V1 } from '../companion/state/sessionCompanionPreference';
import type { SessionCompanionController } from '../companion/state/useSessionCompanionController';
import type { CallerHostedHtmlRuntime } from '@/components/ui/surfaces/hostedHtml/HostedHtmlSurfaceAdapter';
import { SessionBoardSurface } from './SessionBoardSurface';
import { loadPluginUiHostSupport } from '@/components/plugins/hostApi/loadPluginUiHostSupport';
import type { BrowserFrameEngineConfig } from '@/components/browser/frame/types';
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


const ADDRESS: SessionAddress = { serverId: 'home-1', sessionId: 'session-1' };
// The physical browser frame is the only substituted boundary. Viewport, controller,
// Companion, widget host, admission and hosted-frame lifecycle remain real.
const frames = vi.hoisted(() => ({ active: 0, maximum: 0 }));
vi.mock('@/components/browser/frame/BrowserViewFrame.web', () => ({
    BrowserViewFrame: (props: Readonly<{ engine: BrowserFrameEngineConfig }>) => {
        expect(props.engine).toMatchObject({ kind: 'webIframe', html: expect.any(String) });
        const [document] = React.useState(() => ({}));
        React.useEffect(() => {
            frames.active += 1;
            frames.maximum = Math.max(frames.maximum, frames.active);
            return () => { frames.active -= 1; };
        }, []);
        return React.createElement('BrowserViewFrame', { document });
    },
}));
const actions = createSessionBoardActionsPort(ADDRESS);
const pluginRuntime = {
    pluginUiProjection: null,
    pluginBrowserProjection: null,
    phase: 'unavailable' as const,
    interactionEnabled: false,
    machineId: null,
    accountLifetime: null,
    serverId: ADDRESS.serverId,
    platform: 'web' as const,
};

type Probe = {
    mounted: MountedSessionBoardController | null;
    continuity: ReturnType<typeof useSessionBoardContinuity>;
};

afterEach(() => { standardCleanup(); });

const session = createSessionFixture({ id: ADDRESS.sessionId, serverId: ADDRESS.serverId });
const available = () => ({ kind: 'available' as const });
const callerRuntime: CallerHostedHtmlRuntime = {
    serverIdentityId: 'home-1', accountId: 'alice', accountEncryptionMode: 'plain', hostOrigin: 'https://app.example.test',
    admittedHostMethods: [],
    createRequestController: () => ({ handleRequest: async () => null, dispose: () => {} }),
    lifetime: { isCurrent: () => true, onRetire: () => ({ dispose: () => {} }) },
};
const companion: SessionCompanionController = {
    preference: { ...HIDDEN_SESSION_COMPANION_PREFERENCE_V1, visible: true, items: [{ kind: 'widget', widgetId: 'item-b' }] },
    availability: 'ready', preferenceExists: true, realmKey: 'alice:home-1:session-1',
    show: () => null, hide: () => null, setCollapsed: () => null, setEdge: () => null, setDensity: () => null,
    addItem: () => null, removeItem: () => null, moveItem: () => null, setItemFrameStyle: () => null, applyLocalInverse: () => false,
    setInstanceInputs: () => { throw new Error('Instance input mutation is outside this mount fixture'); },
    setInstanceNetwork: () => { throw new Error('Instance network mutation is outside this mount fixture'); },
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
            source: { kind: 'hostedHtml', source: artifactHtmlBundleFromBodyV1('<main>One live B</main>') },
        } } }]]),
        capabilities: { readTranscript: true, editSessionRecords: true }, freshness: 'fresh',
        reachability: 'reachable', loading: 'idle', incomplete: false,
    });
}
function ViewportContents(props: Readonly<{ probe: Probe; expanded: boolean; retained: boolean; boardVisible: boolean; companionVisible: boolean }>): React.ReactElement {
    const mounted = useMountedSessionBoardController(ADDRESS)!;
    props.probe.mounted = mounted;
    props.probe.continuity = useSessionBoardContinuity(ADDRESS);
    return <>
        {props.boardVisible ? <SessionBoardSurface
            sessionId={ADDRESS.sessionId} serverId={ADDRESS.serverId} session={session} controller={mounted.controller}
            host="details" density="full" layout="single"
            retained={props.retained}
            callerHostedHtmlRuntime={callerRuntime}
        /> : null}
        {props.expanded ? <SessionBoardSurface
            sessionId={ADDRESS.sessionId} serverId={ADDRESS.serverId} session={session} controller={mounted.controller}
            host="details" density="full" layout="single" focusedItemId="item-b" testID="expanded"
            callerHostedHtmlRuntime={callerRuntime}
        /> : null}
        {props.companionVisible ? <SessionCompanionContent session={session} serverId={ADDRESS.serverId} controller={companion}
            boardBinding={mounted.binding}
            callerHostedHtmlRuntime={callerRuntime} resolveSourceAvailability={available} /> : null}
    </>;
}
function ViewportHarness(props: Readonly<{ probe: Probe; recovered: boolean; expanded?: boolean; retained?: boolean; boardVisible?: boolean; companionVisible?: boolean }>): React.ReactElement {
    const binding = React.useMemo(() => ({ status: 'ready' as const, snapshot: viewportSnapshot(props.recovered) }), [props.recovered]);
    return <SessionBoardContinuityProvider sessionId={ADDRESS.sessionId} serverId={ADDRESS.serverId}>
        <SessionBoardControllerOwner address={ADDRESS}
            input={{ ...ADDRESS, binding, actions, resolveSourceAvailability: available }}
            binding={binding} actions={actions} pluginRuntime={pluginRuntime}
            callerHostedHtmlRuntime={callerRuntime}>
            <ViewportContents probe={props.probe} expanded={props.expanded === true} retained={props.retained === true}
                boardVisible={props.boardVisible !== false} companionVisible={props.companionVisible !== false} />
        </SessionBoardControllerOwner>
    </SessionBoardContinuityProvider>;
}

describe('Session visual surface bodies', () => {
    beforeEach(async () => {
        await loadSyncSingletonForTests();
        // Load the real frame's generated bootstrap before measuring document mounts.
        await import('@/components/plugins/hostedWeb/guestBootstrap.generated');
    });

    it.each([false, true])('renders independent bodies and disposes them on exit (recovered=%s)', async (recovered) => {
        frames.active = 0;
        frames.maximum = 0;
        const probe: Probe = { mounted: null, continuity: null };
        const screen = await renderScreen(<ViewportHarness probe={probe} recovered={recovered} />);
        await act(async () => { await loadPluginUiHostSupport(); });
        const node = (testID: string) => screen.tree.root.findAll(candidate => candidate.props.testID === testID)[0]!;
        await act(async () => {
            node('session-companion-content').props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 280, height: 600 } } });
            screen.tree.root.findAll(candidate => candidate.props.testID === 'session-companion-content-item-widget:item-b'
                && typeof candidate.props.onLayout === 'function').at(-1)!.props.onLayout({ nativeEvent: {
                layout: { x: 0, y: 0, width: 280, height: 200 },
            } });
            node('session-board-scroll').props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 800, height: 600 } } });
            node(recovered ? 'session-board-recovered-row-item-b' : 'session-board-placement-item-b').props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 800, height: 200 } } });
        });
        await vi.waitFor(async () => {
            await act(async () => { await Promise.resolve(); });
            expect(frames.active, screen.getTextContent()).toBe(2);
        });
        const documents = screen.tree.root.findAllByType('BrowserViewFrame').map(frame => frame.props.document);
        expect(new Set(documents).size).toBe(2);
        await screen.update(<ViewportHarness probe={probe} recovered={recovered} boardVisible={false} companionVisible={false} />);
        expect(frames.active).toBe(0);
        await screen.update(<ViewportHarness probe={probe} recovered={recovered} boardVisible={false} companionVisible={false} expanded />);
        await vi.waitFor(() => expect(frames.active).toBe(1));
        expect(documents).not.toContain(screen.tree.root.findByType('BrowserViewFrame').props.document);
        await screen.unmount();
        expect(frames.active).toBe(0);
    });


});
