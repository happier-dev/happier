import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { SessionSystemRecordStoredSchema } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordRoutes';
import { createSessionSurfaceNoteDocumentV1, SessionBoardLayoutV1Schema, SessionSurfaceItemV1Schema } from '@happier-dev/protocol/sessions/board';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { storage } from '@/sync/domains/state/storageStore';

const continuity = vi.hoisted(() => ({
    width: 1440,
    height: 1000,
    mounts: 0,
    focusOtherView: false,
    dimensionListeners: new Set<() => void>(),
    firstFrameIdentity: null as string | null,
    currentFrameIdentity: null as string | null,
}));
// BrowserViewFrame is the physical browser boundary; all Session owners and adapters stay real.
vi.mock('@/components/browser/frame/BrowserViewFrame.web', () => ({
    BrowserViewFrame: (props: Readonly<{ engine: { kind: string; html?: string } }>) => {
        const frameIdentity = props.engine.html?.match(/&quot;instanceId&quot;:&quot;([^&]+)&quot;/)?.[1]
            ?? props.engine.html?.match(/"instanceId":"([^"]+)"/)?.[1]
            ?? null;
        continuity.currentFrameIdentity = frameIdentity;
        if (frameIdentity && continuity.firstFrameIdentity === null) continuity.firstFrameIdentity = frameIdentity;
        const [count, setCount] = React.useState(0);
        React.useEffect(() => { continuity.mounts += 1; }, []);
        return props.engine.kind === 'webIframe'
            ? React.createElement('PhysicalCounter', { count, increment: () => setCount(value => value + 1) })
            : React.createElement('PhysicalUnavailable');
    },
}));

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
// The native/browser window and portal are the measurement boundary; the Add flow stays real.
vi.mock('@/components/ui/popover', async importOriginal =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));
// Register boundary factories before the real storage/runtime import graph reads native modules.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
        Platform: { OS: 'web' }, useWindowDimensions: () => ({ width: continuity.width, height: continuity.height }),
        Dimensions: {
            get: () => ({ width: continuity.width, height: continuity.height, scale: 1, fontScale: 1 }),
            addEventListener: (_event: string, listener: () => void) => {
                continuity.dimensionListeners.add(listener);
                return { remove: () => { continuity.dimensionListeners.delete(listener); } };
            },
        },
    }));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/utils/web/radixCjs', async () => (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
// The global navigation SDK boundary only passes containers through. This composed fixture
// needs its selected initial scene; all Happier scene selection and screen owners remain real.
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock({
    renderInitialNavigatorScreen: true,
}));

const item = SessionSurfaceItemV1Schema.parse({ v: 1, title: 'Build notes', frame: 'card',
    height: { mode: 'auto', fallback: 'regular' },
    source: { kind: 'declarative', document: createSessionSurfaceNoteDocumentV1('The release checks passed.') },
});
const layout = SessionBoardLayoutV1Schema.parse({ v: 1,
    tabs: [{ id: 'overview', title: 'Overview', items: [{ itemId: 'note-1', width: 'medium' }, { itemId: 'counter', width: 'medium' }] }],
});
const focusedLayout = SessionBoardLayoutV1Schema.parse({ v: 1, tabs: [
    { id: 'overview', title: 'Overview', items: [{ itemId: 'note-1', width: 'medium' }] },
    { id: 'other', title: 'Other', items: [{ itemId: 'counter', width: 'medium' }] },
] });
const counter = SessionSurfaceItemV1Schema.parse({ v: 1, title: 'Interactive counter', frame: 'card',
    height: { mode: 'auto', fallback: 'regular' },
    source: { kind: 'hostedHtml', source: artifactHtmlBundleFromBodyV1('<button>Increment</button>') },
});
const records = [['layout', 'layout.v1', layout], ['note-1', 'item.v1', item], ['counter', 'item.v1', counter]].map(([localId, kind, value]) =>
    SessionSystemRecordStoredSchema.parse({ id: localId,
        address: { owner: 'host', namespace: 'surface', kind, localId }, content: { t: 'plain', v: value },
        revision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ', createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z',
    }));
const focusedRecords = records.map(record => record.address.kind === 'layout.v1'
    ? SessionSystemRecordStoredSchema.parse({ ...record, content: { t: 'plain', v: focusedLayout } }) : record);
const runtime = installSessionPaneRuntimeTestHarness({
    features: () => createRootLayoutFeaturesResponse({ features: { sessions: { board: { enabled: true } } } }),
    request: async url => new URL(String(url)).pathname.endsWith('/system-records')
        ? Response.json({ records: continuity.focusOtherView ? focusedRecords : records, nextCursor: null, hasNext: false }) : null,
});
// Load the real composition after its transport boundaries are installed, outside the timed gesture.
const { SessionDetailsDestinationBody } = await import('./SessionDetailsDestinationBody');
const { SessionView } = await import('./SessionView');
const { SessionCockpitShell } = await import('@/components/workspaceCockpit/session/SessionCockpitShell');
const { useMobileWorkspaceExperienceState } = await import('@/components/workspaceCockpit/useMobileWorkspaceExperienceState');
const { SessionBoardControllerProvider, useMountedSessionBoardController } = await import('@/components/sessions/board/SessionBoardControllerProvider');
const { normalizeSessionAddress } = await import('@/sync/domains/session/sessionAddress');
const { loadPluginUiHostSupport } = await import('@/components/plugins/hostApi/loadPluginUiHostSupport');

describe('Session Details destination Board composition', () => {
    beforeEach(async () => {
        continuity.width = 1440; continuity.height = 1000; continuity.mounts = 0; continuity.focusOtherView = false;
        continuity.firstFrameIdentity = null; continuity.currentFrameIdentity = null;
        storage.getState().applySettingsLocal({ mobileWorkspaceExperienceV1: 'classic', experiments: true });
        // The real caller-frame runtime reads its embedding browser's origin.
        vi.stubGlobal('location', new URL('https://session-pane-ui.test'));
        await act(async () => { await loadPluginUiHostSupport(); });
        await import('@/components/plugins/hostedWeb/guestBootstrap.generated');
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    it.each([
        { sessionRouteHandoff: false, mobileExperience: 'classic' as const, focusOtherView: false },
        { sessionRouteHandoff: true, mobileExperience: 'classic' as const, focusOtherView: false },
        { sessionRouteHandoff: false, mobileExperience: 'cockpit' as const, focusOtherView: false },
        { sessionRouteHandoff: false, mobileExperience: 'cockpit' as const, focusOtherView: true },
    ])('renders the current body across phone width ($mobileExperience, Session route handoff: $sessionRouteHandoff, focused other view: $focusOtherView)', async ({ sessionRouteHandoff, mobileExperience, focusOtherView }) => {
        continuity.focusOtherView = focusOtherView;
        let focusedItemId = 'counter';
        storage.getState().applySettingsLocal({ mobileWorkspaceExperienceV1: mobileExperience, experiments: true });
        const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        await getServerFeaturesSnapshot({ serverId: runtime.serverId, force: true });
        let mobileState: ReturnType<typeof useMobileWorkspaceExperienceState> | null = null;
        const currentOwner: { current: ReturnType<typeof useMountedSessionBoardController> } = { current: null };
        function PresentationProbe() {
            mobileState = useMobileWorkspaceExperienceState();
            currentOwner.current = useMountedSessionBoardController(normalizeSessionAddress(runtime.serverId, 's1'));
            return null;
        }
        const destination = () => <runtime.Wrapper>
            <DestinationInstanceHost tabId="details-responsive" ref={{ kind: !sessionRouteHandoff || continuity.width === 390 ? 'sessionDetails' : 'session',
                params: { id: 's1', serverId: runtime.serverId, details: 'board', ...(focusOtherView ? { boardItemId: focusedItemId } : {}) } }}
                pathname={!sessionRouteHandoff || continuity.width === 390 ? '/session/s1/details' : '/session/s1'} focused visible phone={continuity.width === 390}
                navigation={{ push: () => {}, replace: () => {}, back: () => {}, setParams: () => {} }}>
                <PresentationProbe />
                {!sessionRouteHandoff || continuity.width === 390 ? <SessionDetailsDestinationBody /> : <SessionView id="s1" routeServerId={runtime.serverId}
                    paneUrlState={{ details: { kind: 'board' } }} />}
            </DestinationInstanceHost>
        </runtime.Wrapper>;
        const screen = await renderScreen(destination());
        const measureBoard = async () => await act(async () => {
            for (const node of screen.tree.root.findAll(node => typeof node.props.onLayout === 'function'
                && typeof node.props.testID === 'string' && (node.props.testID.endsWith('-scroll') || node.props.testID.endsWith('-placement-counter')))) {
                node.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: continuity.width, height: 400 } } });
            }
        });
        await flushHookEffects({ cycles: 30 });
        await measureBoard();
        await vi.waitFor(async () => {
            await act(async () => { await Promise.resolve(); });
            expect(screen.tree.findAllByType('PhysicalCounter'), screen.getTextContent()).toHaveLength(1);
        });
        const frame = () => screen.tree.findByType('PhysicalCounter');
        await act(async () => { frame().props.increment(); });
        expect(frame().props.count).toBe(1);
        await act(async () => {
            continuity.width = 390;
            continuity.height = 844;
            for (const listener of [...continuity.dimensionListeners]) listener();
        });
        await screen.update(destination());
        await flushHookEffects({ cycles: 30 });
        await measureBoard();
        if (mobileExperience === 'cockpit') {
            expect(mobileState).toMatchObject({ deviceType: 'phone', mobileWorkspaceExperience: 'cockpit', cockpitEnabled: true });
            expect(screen.tree.findAllByType(SessionCockpitShell), 'Phone width must reach the real Cockpit composition').toHaveLength(1);
        }
        await vi.waitFor(async () => {
            await act(async () => { await Promise.resolve(); });
            expect(screen.tree.findAllByType('PhysicalCounter'), screen.getTextContent()).toHaveLength(1);
        });
        await act(async () => {
            continuity.width = 1440;
            continuity.height = 1000;
            for (const listener of [...continuity.dimensionListeners]) listener();
        });
        await screen.update(destination());
        await flushHookEffects({ cycles: 30 });
        await measureBoard();
        expect(screen.tree.findAllByType('PhysicalCounter')).toHaveLength(1);
        if (mobileExperience === 'cockpit' && !focusOtherView) {
            await act(async () => {
                for (const node of screen.tree.root.findAll(node => typeof node.props.onLayout === 'function'
                    && typeof node.props.testID === 'string' && node.props.testID.endsWith('-placement-counter'))) {
                    node.props.onLayout({ nativeEvent: { layout: { x: 0, y: 5000, width: continuity.width, height: 400 } } });
                }
            });
            await flushHookEffects({ cycles: 30 });
            // Measured withdrawal is stronger than the visual route hint, even before a
            // retiring source has committed its own deferred projection.
            expect(screen.tree.findAllByType('PhysicalCounter')).toHaveLength(0);
            await measureBoard();
            await vi.waitFor(async () => {
                await act(async () => { await Promise.resolve(); });
                expect(screen.tree.findAllByType('PhysicalCounter')).toHaveLength(1);
            });
        }
        if (focusOtherView) {
            await act(async () => { await currentOwner.current?.controller.run({ kind: 'view.select', viewId: 'other' }); });
            expect(currentOwner.current?.controller.activeViewId).toBe('other');
            focusedItemId = 'note-1';
            await screen.update(destination());
            await flushHookEffects({ cycles: 30 });
            expect(screen.tree.findAllByType('PhysicalCounter'), 'Changing the exact focus must retire the old item, even when its view is selected').toHaveLength(0);
            focusedItemId = 'counter';
            await screen.update(destination());
            await flushHookEffects({ cycles: 30 });
            await vi.waitFor(async () => {
                await act(async () => { await Promise.resolve(); });
                expect(screen.tree.findAllByType('PhysicalCounter')).toHaveLength(1);
            });
        }
        const session = storage.getState().sessions.s1;
        if (!session?.access) throw new Error('Expected the admitted Session fixture');
        const access = session.access;
        await act(async () => {
            storage.getState().applySessions([{ ...session, access: { ...access,
                capabilities: { ...access.capabilities, readTranscript: false } } }]);
        });
        await flushHookEffects({ cycles: 30 });
        expect(screen.tree.findAllByType('PhysicalCounter'), 'Revoked Session authority must retire the retained executable').toHaveLength(0);
    });

    it('disposes the last executable when fullscreen Details closes to the same Session', async () => {
        continuity.width = 390; continuity.height = 844;
        storage.getState().applySettingsLocal({ mobileWorkspaceExperienceV1: 'classic', experiments: true });
        const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        await getServerFeaturesSnapshot({ serverId: runtime.serverId, force: true });
        const { SessionDetailsPanel } = await import('@/components/sessions/panes/SessionDetailsPanel');
        let details = true;
        const destination = () => <runtime.Wrapper>
            <DestinationInstanceHost tabId="details-close" ref={{ kind: details ? 'sessionDetails' : 'session',
                params: { id: 's1', serverId: runtime.serverId, ...(details ? { details: 'board' } : {}) } }}
                pathname={details ? '/session/s1/details' : '/session/s1'} focused visible phone
                navigation={{ push: () => {}, replace: () => { details = false; }, back: () => {} }}>
                {details ? <SessionDetailsDestinationBody /> : <SessionView id="s1" routeServerId={runtime.serverId} />}
            </DestinationInstanceHost>
        </runtime.Wrapper>;
        const screen = await renderScreen(destination());
        await flushHookEffects({ cycles: 30 });
        expect(screen.tree.findAllByType('PhysicalCounter')).toHaveLength(1);
        await act(async () => { screen.tree.findByType(SessionDetailsPanel).props.onRequestClose(); });
        expect(details).toBe(false);
        await screen.update(destination());
        await flushHookEffects({ cycles: 30 });
        expect(screen.tree.findAllByType('PhysicalCounter')).toHaveLength(0);
    });

    it('reads the existing Board and opens Add from the phone instance route', async () => {
        continuity.width = 390; continuity.height = 844;
        storage.getState().applySettingsLocal({ mobileWorkspaceExperienceV1: 'classic', experiments: true });
        const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        expect((await getServerFeaturesSnapshot({ serverId: runtime.serverId, force: true })).status).toBe('ready');
        const { SessionBoardSurface } = await import('@/components/sessions/board/SessionBoardSurface');
        const { BoardWidgetAddPopover } = await import('@/components/widgets/add/BoardWidgetAddPopover');
        const destination = (focused: boolean, visible = true) => <runtime.Wrapper>
            <DestinationInstanceHost tabId="details-phone" ref={{ kind: 'sessionDetails',
                params: { id: 's1', serverId: runtime.serverId, details: 'board' } }}
                pathname="/session/s1/details" focused={focused} visible={visible} phone
                navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
                <SessionDetailsDestinationBody />
            </DestinationInstanceHost>
        </runtime.Wrapper>;
        const screen = await renderScreen(destination(true));
        await flushHookEffects({ cycles: 30 });
        expect(screen.findHostByTestId('session-board-pane'), 'The hydrated phone route must render its Board destination').not.toBeNull();
        const surface = screen.tree.findAllByType(SessionBoardSurface)[0];
        expect(surface, 'The phone Details route must reach the real Board controller').toBeDefined();
        const controller = surface!.props.controller;
        expect(controller.snapshot?.itemsById.get('note-1')?.state).toMatchObject({ kind: 'ready', item });
        expect(screen.tree.findAllByType('PhysicalCounter')).toHaveLength(1);
        await screen.update(destination(false));
        expect(screen.tree.findAllByType('PhysicalCounter')).toHaveLength(1);
        await screen.update(destination(false, false));
        expect(screen.tree.findAllByType('PhysicalCounter')).toHaveLength(0);
        await screen.update(destination(true));
        await flushHookEffects({ cycles: 30 });
        expect(screen.findHostByTestId('session-board-pane-surface-placement-note-1')).not.toBeNull();
        expect(screen.findByTestId('session-board-pane-surface-add-trigger')).not.toBeNull();
        await screen.pressByTestIdAsync('session-board-pane-surface-add-trigger');
        await vi.waitFor(async () => {
            await act(async () => { await Promise.resolve(); });
            expect(screen.tree.findByType(BoardWidgetAddPopover).props.open).toBe(true);
        });
    });
});
