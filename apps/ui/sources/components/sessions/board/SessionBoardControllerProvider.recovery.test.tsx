import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, createSessionFixture, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot, setActiveServer } from '@/sync/domains/server/serverRuntime';
import { removeServerProfile, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { disconnectActiveServerConnection } from '@/sync/runtime/orchestration/connectionManager';
import { SessionCurrentProjectionRecordV1Schema} from '@happier-dev/protocol/sessions/listing/response';
import { SessionSystemRecordStoredSchema, type SessionSystemRecordStored } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordRoutes';
import { SessionBoardLayoutV1Schema, SessionSurfaceItemV1Schema } from '@happier-dev/protocol/sessions/board';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { useAppPaneScope, type AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { SessionCompanionPresentationBridge, type SessionPresentationIntentApplier } from '../companion/presentation/SessionCompanionPresentationBridge';
import { createSessionCompanionPanePresentation } from '../companion/presentation/sessionCompanionPanePresentation';

installDisconnectedServerSocketBoundary();

// Static storage/runtime imports need the canonical Socket boundary during collection.
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

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
    removalMode: 'none' as 'none' | 'populated',
    homeId: '',
    secondHomeId: '',
    push: vi.fn(),
    replace: vi.fn(),
    alert: vi.fn(),
    show: vi.fn(),
    presentationNote: false,
    recordLists: 0,
    recordListGate: null as Promise<void> | null,
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
    return createExpoRouterMock({ router: { push: harness.push, replace: harness.replace } }).module;
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: {
        alert: harness.alert,
        show: harness.show,
    } }).module;
});
// The editor wrapper selects its platform module through a bundler-only require.
vi.mock('@/components/ui/code/editor/CodeEditor', () => ({ CodeEditor: () => null }));

function record(localId: string, kind: string, value: unknown): SessionSystemRecordStored {
    return SessionSystemRecordStoredSchema.parse({
        id: localId, address: { owner: 'host', namespace: 'surface', kind, localId },
        content: { t: 'plain', v: value }, revision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ',
        createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
    });
}

function sessionWire(id: string) {
    const fixture = createSessionFixture({ id });
    return SessionCurrentProjectionRecordV1Schema.parse({
        id, seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
        encryptionMode: harness.layoutLocked ? 'e2ee' : 'plain', dataEncryptionKey: null,
        metadataLayoutVersion: 0, metadataVersion: 1,
        metadata: harness.layoutLocked ? 'encrypted-metadata' : JSON.stringify({ path: '/repo', host: 'test' }),
        agentState: null, agentStateVersion: 1, share: null,
        effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], audienceContext: null,
            capabilities: fixture.access!.capabilities },
        responsibleAccountId: null, responsibleAccount: null,
    });
}

// Only HTTP is substituted. Credentials, scoped Sync, the repository, codec,
// projection, feature decision and mounted provider all consume these wire rows.
async function request(input: RequestInfo | URL): Promise<Response> {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/auth/ping' || path === '/health') return Response.json({ status: 'ok' });
    if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({
        features: { sessions: { board: { enabled: true } } },
    }));
    if (path.endsWith('/system-records')) {
        harness.recordLists += 1;
        await harness.recordListGate;
        // A lone Board view has no tab strip; focus-return tests need a real multi-view Board.
        const layout = record('layout', 'layout.v1', SessionBoardLayoutV1Schema.parse({ v: 1, tabs: harness.removalMode === 'none' ? [] : [
            { id: 'overview', title: 'Overview', items: [] }, {
            id: 'research', title: 'Research', items: harness.removalMode === 'populated'
                ? [{ itemId: 'item-1', width: 'medium' }] : [],
        }] }));
        if (harness.layoutLocked) layout.content = { t: 'encrypted', c: 'encrypted-layout' };
        return Response.json({ records: [layout, record('item-1', 'item.v1', SessionSurfaceItemV1Schema.parse({
            v: 1, title: 'Status', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
            source: harness.presentationNote ? { kind: 'declarative', document: { version: 1,
                root: { kind: 'markdown', text: 'Release checklist' } } } : { kind: 'widget', instance: { v: 1, id: 'instance-1', definition: {
                kind: 'installed', surface: { pluginId: 'acme.board', localId: 'status' },
            }, bindings: {} } },
        })), ...(harness.presentationNote ? [record('unreadable', 'item.v1', { v: 1 })] : [])], nextCursor: null, hasNext: false });
    }
    if (path === '/v1/account/encryption/currentness') return Response.json({
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    });
    if (path === '/v2/sessions/metadata-upgrades') return Response.json({ sessionIds: [] });
    if (path === '/v2/sessions' || path === '/v2/sessions/active') return Response.json({
        sessions: ['session-1', 'session-2'].map(sessionWire), nextCursor: null, hasNext: false,
    });
    if (path === '/v2/sessions/session-1' || path === '/v2/sessions/session-2') return Response.json({ session: sessionWire(path.split('/').at(-1)!) });
    return new Response(null, { status: 404 });
}

let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
beforeAll(loadSyncSingletonForTests);
afterEach(async () => {
    standardCleanup();
    await connection?.dispose();
    // These scenarios change/remove their Home, so the captured fixture's generation
    // guard can intentionally leave the connection they switched to alive.
    await disconnectActiveServerConnection();
    storage.setState(storage.getInitialState(), true);
    connection = undefined;
});

function AuthorizedBoard(props: React.PropsWithChildren<{ serverId?: string; sessionId?: string }>): React.ReactElement {
    return <InjectedAuthProvider credentials={connection!.credentials}>
        <SessionBoardControllerProvider serverId={props.serverId ?? harness.homeId} sessionId={props.sessionId ?? 'session-1'}>
            {props.children}
        </SessionBoardControllerProvider>
    </InjectedAuthProvider>;
}

import { SessionBoardControllerProvider, useMountedSessionBoardController, type MountedSessionBoardController } from './SessionBoardControllerProvider';
import { SessionBoardPane } from './SessionBoardPane';
import type { SessionBoardController } from './useSessionBoardController';

let observedController: SessionBoardController | null = null;
let observedBoard: MountedSessionBoardController | null = null;

function ControllerProbe(): React.ReactElement | null {
    observedBoard = useMountedSessionBoardController({ serverId: harness.homeId, sessionId: 'session-1' });
    observedController = observedBoard?.controller ?? null;
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
        <AuthorizedBoard>
            <ControllerProbe />
            <SessionBoardPane
                sessionId="session-1"
                serverId={harness.homeId}
                host="details"
                density="full"
                layout="grid"
            />
        </AuthorizedBoard>,
    );
}

function PresentedBoard(props: Readonly<{
    applierRef: React.MutableRefObject<SessionPresentationIntentApplier | null>;
    paneRef: React.MutableRefObject<AppPaneScopeApi | null>;
    bridgeSessionId?: string;
}>): React.ReactElement {
    const pane = useAppPaneScope('board-presentation');
    props.paneRef.current = pane;
    const paneRef = props.paneRef;
    const presentation = React.useMemo(() => createSessionCompanionPanePresentation({
        readPane: () => paneRef.current!, readMainColumn: () => null, isUndoCurrent: () => true,
    }), [paneRef]);
    return <>
        <ControllerProbe />
        <SessionCompanionPresentationBridge sessionId={props.bridgeSessionId ?? 'session-1'} serverId={harness.homeId}
            applierRef={props.applierRef} {...presentation} openFullSurface={() => ({ status: 'unavailable' })} />
        {pane.scopeState?.details.isOpen ? <SessionBoardPane sessionId="session-1" serverId={harness.homeId}
            host="details" density="full" layout="grid" /> : null}
    </>;
}

describe('mounted Board recovery navigation', () => {
    beforeEach(async () => {
        standardCleanup();
        observedController = null;
        observedBoard = null;
        harness.layoutLocked = false;
        harness.removalMode = 'none';
        harness.presentationNote = false;
        harness.recordLists = 0;
        harness.recordListGate = null;
        harness.push.mockReset();
        harness.replace.mockReset();
        harness.alert.mockReset();
        harness.show.mockReset();
        harness.show.mockImplementation((config: Readonly<{ onRequestClose?: () => void }>) => {
            queueMicrotask(() => config.onRequestClose?.());
            return 'modal-id';
        });
        connection = await restoreServerAccountForTest({ serverUrl: 'https://board-recovery.test', accountId: 'alice', request });
        harness.homeId = connection.home.id;
        harness.secondHomeId = (await upsertServerProfile({ serverUrl: 'https://board-recovery-second.test', name: 'Second Home' })).id;
        setRuntimeFetch(request);
        storage.getState().applySettingsLocal({ experiments: true });
        storage.setState({ sessions: Object.fromEntries(['session-1', 'session-2'].map(id => [id, createSessionFixture({
            id, serverId: harness.homeId, metadata: { path: '/repo', host: 'test' },
        })])) });
    });

    it('opens a closed Board without eager reads, then reveals its populated Note through the mounted presentation owner', async () => {
        harness.presentationNote = true;
        harness.removalMode = 'populated';
        const inventory = createDeferred<void>();
        harness.recordListGate = inventory.promise;
        const applierRef: React.MutableRefObject<SessionPresentationIntentApplier | null> = { current: null };
        const paneRef: React.MutableRefObject<AppPaneScopeApi | null> = { current: null };
        const screen = await renderScreen(<AppPaneProvider><AuthorizedBoard>
            <PresentedBoard applierRef={applierRef} paneRef={paneRef} />
        </AuthorizedBoard></AppPaneProvider>);
        await flushHookEffects({ cycles: 30 });
        expect(applierRef.current).not.toBeNull();
        expect(screen.findByTestId('session-board-pane')).toBeNull();
        expect(harness.recordLists).toBe(0);

        await act(async () => {
            expect(applierRef.current?.({ kind: 'board.open', mode: 'beside_chat' })).toEqual({ status: 'applied' });
        });
        try {
            await vi.waitFor(() => expect(harness.recordLists).toBeGreaterThan(0));
            await act(async () => {
                expect(applierRef.current?.({ kind: 'board.item.reveal', widgetId: 'item-1', viewId: 'research' }))
                    .toEqual({ status: 'unavailable' });
                expect(applierRef.current?.({ kind: 'board.view.select', viewId: 'research' }))
                    .toEqual({ status: 'unavailable' });
            });
            expect(paneRef.current?.scopeState?.details.tabs.some(tab => tab.key === 'board:item-1')).toBe(false);
        } finally {
            inventory.resolve(undefined);
        }
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(observedBoard?.binding).toMatchObject({ status: 'ready', snapshot: {
                reachability: 'reachable', loading: 'idle',
            } });
            expect(observedBoard?.binding.status === 'ready'
                && observedBoard.binding.snapshot.itemsById.get('item-1')?.state.kind).toBe('ready');
        });
        expect(screen.findByTestId('session-board-pane')).toBeTruthy();
        const readsAfterOpen = harness.recordLists;
        expect(readsAfterOpen).toBeGreaterThan(0);
        await act(async () => {
            expect(applierRef.current?.({ kind: 'board.item.reveal', widgetId: 'item-1', viewId: 'research' }))
                .toEqual({ status: 'applied' });
        });
        expect(paneRef.current?.scopeState?.details.tabs.find(tab => tab.key === 'board:item-1')?.resource)
            .toMatchObject({ kind: 'board', focusTarget: { kind: 'item', itemId: 'item-1' } });
        expect(applierRef.current?.({ kind: 'board.item.reveal', widgetId: 'missing', viewId: 'research' }))
            .toEqual({ status: 'invalidTarget' });
        expect(applierRef.current?.({ kind: 'board.item.reveal', widgetId: 'unreadable' }))
            .toEqual({ status: 'invalidTarget' });
        expect(applierRef.current?.({ kind: 'board.item.reveal', widgetId: 'item-1', viewId: 'missing' }))
            .toEqual({ status: 'invalidTarget' });
        expect(harness.recordLists).toBe(readsAfterOpen);
    });

    it('does not use a different mounted Session to reveal an item', async () => {
        const applierRef: React.MutableRefObject<SessionPresentationIntentApplier | null> = { current: null };
        const paneRef: React.MutableRefObject<AppPaneScopeApi | null> = { current: null };
        const screen = await renderScreen(<AppPaneProvider><AuthorizedBoard>
            <PresentedBoard applierRef={applierRef} paneRef={paneRef} bridgeSessionId="session-2" />
        </AuthorizedBoard></AppPaneProvider>);
        expect(applierRef.current?.({ kind: 'board.item.reveal', widgetId: 'item-1', viewId: 'research' }))
            .toEqual({ status: 'unavailable' });
        expect(screen.findByTestId('session-board-pane')).toBeNull();
        expect(harness.recordLists).toBe(0);
    });

    it('gives a locked shared layout a reachable encryption recovery in the mounted Board', async () => {
        harness.layoutLocked = true;
        storage.setState({ sessions: { ...storage.getState().sessions, 'session-1': createSessionFixture({
            serverId: harness.homeId, metadata: null, encryptionMode: 'e2ee', encryptedContentAvailability: 'encrypted_access_pending',
        }) } });
        const screen = await mountBoard();
        await flushHookEffects({ cycles: 30 });

        const action = screen.findByTestId('session-board-pane-surface-state-action');
        expect(action).toBeTruthy();
        await act(async () => { await action?.props.onPress?.(); });

        expect(harness.replace).toHaveBeenCalledWith(expect.objectContaining({
            pathname: '/settings/account/security', params: { serverId: harness.homeId },
        }));
        expect(getActiveServerSnapshot().serverId).toBe(harness.homeId);
    });

    it('reports a blocked Home switch instead of silently dropping encryption recovery', async () => {
        harness.layoutLocked = true;
        await mountBoard();
        await removeServerProfile(harness.homeId);

        await act(async () => { await observedController?.run({ kind: 'item.prepareEncryption' }); });

        expect(harness.replace).not.toHaveBeenCalled();
        expect(harness.alert).toHaveBeenCalledWith('Error', 'An unknown error occurred');
    });

    it('establishes the exact Session Home before opening an installed plugin recovery route', async () => {
        await mountBoard();
        await flushHookEffects({ cycles: 30 });
        await setActiveServer({ serverId: harness.secondHomeId, scope: 'device' });
        expect(observedBoard?.binding).toMatchObject({ status: 'ready' });
        let navigatedHome: string | undefined;
        harness.push.mockImplementation(() => { navigatedHome = getActiveServerSnapshot().serverId; });

        expect(observedController?.supports('item.managePlugin')).toBe(true);
        await act(async () => { await observedController?.run({ kind: 'item.managePlugin', itemId: 'item-1' }); });

        expect(navigatedHome).toBe(harness.homeId);
        expect(harness.push).toHaveBeenCalledWith(expect.objectContaining({
            params: { pluginId: 'acme.board' },
        }));
    });

    it('constructs a legitimate nested owner instead of borrowing a different exact Session', async () => {
        let outerController: SessionBoardController | null = null;
        let innerController: SessionBoardController | null = null;

        await renderScreen(
            <AuthorizedBoard>
                <AddressedControllerProbe
                    serverId={harness.homeId}
                    sessionId="session-1"
                    onController={(controller) => { outerController = controller; }}
                />
                <SessionBoardControllerProvider sessionId="session-2" serverId={harness.homeId}>
                    <AddressedControllerProbe
                        serverId={harness.homeId}
                        sessionId="session-2"
                        onController={(controller) => { innerController = controller; }}
                    />
                </SessionBoardControllerProvider>
            </AuthorizedBoard>,
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
            <AuthorizedBoard sessionId="session-1" serverId={serverId}>
                <Probe serverId={serverId} />
                <SessionBoardPane sessionId="session-1" serverId={serverId} host="details"
                    density="full" layout="grid" />
            </AuthorizedBoard>
        );
        const screen = await renderScreen(renderOwner(harness.homeId));
        await flushHookEffects({ cycles: 30 });
        const firstController = probeState.current;
        await act(async () => {
            await probeState.current?.run({ kind: 'add', intent: 'note' });
        });
        expect(probeState.current?.noteDraft).not.toBeNull();

        await screen.update(renderOwner(harness.secondHomeId));

        expect(probeState.current).not.toBe(firstController);
        expect(probeState.current?.noteDraft).toBeNull();
    });

    it('registers the mounted view tab as the disposition modal focus-return target', async () => {
        harness.removalMode = 'populated';
        const researchFocus = vi.fn();
        await renderScreen(
            <AuthorizedBoard>
                <ControllerProbe />
                <SessionBoardPane
                    sessionId="session-1"
                    serverId={harness.homeId}
                    host="details"
                    density="full"
                    layout="grid"
                />
            </AuthorizedBoard>,
            {
                createNodeMock: (element) => nodeHasTestId(element, 'session-board-pane-surface-views-view-research')
                    ? { focus: researchFocus }
                    : {},
            },
        );

        await flushHookEffects({ cycles: 30 });
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
});
