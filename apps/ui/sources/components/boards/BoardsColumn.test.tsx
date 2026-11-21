import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent} from '@happier-dev/protocol/storage/artifactStoredContent';
import { buildWorkBoardArtifactHeaderV1} from '@happier-dev/protocol/boards/workBoardArtifactV1';
import { createWorkBoardV1, type WorkBoardV1 } from '@happier-dev/protocol/boards/workBoardV1';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { createDeferred, createPlainAccountEncryptionCurrentnessFixture, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getStorage } from '@/sync/domains/state/storage';
import { BoardsColumn } from './BoardsColumn';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { BoardScreen } from './BoardScreen';
import { BoardsIndex } from './BoardsIndex';
import { AppShellColumnContext } from '@/components/navigation/shell/appRail/appShellColumnContext';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { PinnedBoardNeedsYouCount } from './PinnedBoardNeedsYouCount';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { act } from 'react-test-renderer';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import type { Artifact } from '@/sync/domains/artifacts/artifactTypes';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderMountedCurrentUiContext } from '@/dev/testkit/harness/mountedCurrentUiContext';
import { CurrentUiContextCommandsProvider, useCurrentUiContextComposedCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { usePublishCurrentUiContext } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { CurrentUiContextSnapshotV1Schema } from '@happier-dev/protocol/plugins/ui/currentUiContext';
import { router } from 'expo-router';
import { t } from '@/text';

// Native and navigation adapters are external boundaries; the Board store and collection stay real.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
const route = vi.hoisted(() => ({ pathname: '/boards/alpha' }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: () => route.pathname }).module;
});
// The applied connection is a network/environment boundary. Keep Account lifetime and readers real,
// as in workflowLibraryReads.test.tsx, while declaring this HTTP fixture's Home connected.
vi.mock('@/sync/runtime/orchestration/connectionManager', async importOriginal => {
    const actual = await importOriginal<typeof import('@/sync/runtime/orchestration/connectionManager')>();
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    return { ...actual, getAppliedActiveServerSnapshot: () => getActiveServerSnapshot(), isAppliedActiveServerRuntimeAvailable: () => true };
});

const boards = [createWorkBoardV1({ id: 'alpha', name: 'Alpha release' }), createWorkBoardV1({ id: 'beta', name: 'Beta work' })];
const artifacts = boards.map(board => ({
    id: board.id, header: encodePlainArtifactStoredContent(buildWorkBoardArtifactHeaderV1(board)),
    body: encodePlainArtifactStoredContent({ body: JSON.stringify(board) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
    headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
    ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
} satisfies Artifact));
let home: Awaited<ReturnType<typeof serveActionHomes>> | null = null;
let credentials: AuthCredentials | null = null;
let unreadableAlpha: 'malformed_json' | 'content_unavailable' | null = null;
let liveBoard: WorkBoardV1 | null = null;
let bodyGate: Promise<void> | null = null;
let indexGate: Promise<void> | null = null;
let failIndex = false;
let noBoards = false;
let previousStorageState = getStorage().getState();

const deviceState = vi.hoisted(() => ({ type: 'tablet' as 'phone' | 'tablet' }));
vi.mock('@/utils/platform/responsive', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/platform/responsive')>(),
    useDeviceType: () => deviceState.type,
}));

function CommandPublication() {
    const commands = useCurrentUiContextComposedCommands();
    const enrichment = React.useMemo(() => ({ commands }), [commands]);
    usePublishCurrentUiContext(enrichment);
    return null;
}
function CommandPage({ children }: React.PropsWithChildren) {
    return <CurrentUiContextCommandsProvider authority={captureActiveServerAccountScopeLifetime()}>
        <CommandPublication />{children}
    </CurrentUiContextCommandsProvider>;
}

describe('BoardsColumn collection search', () => {
    beforeEach(async () => {
        previousStorageState = getStorage().getState();
        unreadableAlpha = null;
        liveBoard = null;
        bodyGate = null;
        indexGate = null;
        failIndex = false;
        noBoards = false;
        route.pathname = '/boards/alpha';
        const artifactBoundary = createArtifactStoreBoundary({ ownerAccountId: () => 'owner', encryptionMode: 'plain' });
        home = await serveActionHomes({
            homes: [{ key: 'boards', serverUrl: 'https://boards-column.test', accountId: 'owner' }],
            route: async request => {
                if (request.path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                const rows = (noBoards ? [] : artifacts).map(artifact => liveBoard && artifact.id === liveBoard.id ? {
                    ...artifact, header: encodePlainArtifactStoredContent(buildWorkBoardArtifactHeaderV1(liveBoard)),
                    body: encodePlainArtifactStoredContent({ body: JSON.stringify(liveBoard) }),
                } : artifact);
                for (const row of rows) artifactBoundary.replaceStoredRow(row);
                if (request.path === '/v1/artifacts' && failIndex) return new Response(null, { status: 500 });
                if (request.path === '/v1/artifacts' && indexGate) await indexGate;
                // The Artifact server selects by coarse kind and reports completeness; every row here is classified.
                if (request.path === '/v1/artifacts') return Response.json(request.url.searchParams.has('kind') ? { items: rows, hasUnclassified: false } : rows);
                const artifact = rows.find(row => request.path === `/v1/artifacts/${row.id}`);
                if (artifact && bodyGate) await bodyGate;
                if (artifact?.id === 'alpha' && unreadableAlpha) return Response.json({ ...artifact,
                    body: encodePlainArtifactStoredContent(unreadableAlpha === 'malformed_json'
                        ? { body: '{ invalid Board JSON' } : { body: 42 }),
                });
                return artifact ? Response.json(artifact) : (await artifactBoundary.handle(request.path)) ?? undefined;
            },
        });
        // The HTTP helper selects a browser tab; this node renderer has no sessionStorage.
        // Establish the same real device selection that workflowLibraryReads' fixture uses.
        const { setActiveServer } = await import('@/sync/domains/server/serverRuntime');
        await setActiveServer({ serverId: home.homes.boards!.id, scope: 'device' });
        credentials = await TokenStorage.getCredentialsForServerUrl(home.homes.boards!.serverUrl);
        const scope = { serverId: home.homes.boards!.id, accountId: 'owner' };
        getStorage().setState({ isDataReady: true, profileScope: scope, settingsScope: scope });
        vi.useFakeTimers();
    });
    afterEach(async () => {
        await standardCleanup();
        vi.useRealTimers();
        await home?.dispose();
        home = null;
        retireActiveServerAccountScopeLifetime();
        invalidateAccountEncryptionModeCache();
        getStorage().setState(previousStorageState);
        vi.restoreAllMocks();
    });

    it('lets the answering agent open a named Board', async () => {
        vi.useRealTimers();
        await home!.restoreActiveConnection();
        const screen = await renderMountedCurrentUiContext(<CommandPage><BoardsColumn /></CommandPage>);
        await vi.waitFor(() => expect(screen.findByTestId('boards-column:board:beta')).not.toBeNull());
        const executor = createDefaultActionExecutor();
        const read = await executor.execute('ui.current_context.read', {}, { surface: 'agent' });
        expect(read.ok).toBe(true);
        if (!read.ok) throw new Error('Expected mounted Board commands');
        const snapshot = CurrentUiContextSnapshotV1Schema.parse(read.result);
        const open = snapshot.commands.find(command => command.title === 'Beta work');
        expect(open).toBeDefined();
        await act(async () => {
            expect(await executor.execute('ui.current_context.command.invoke', { commandId: open!.id }, { surface: 'agent' }))
                .toMatchObject({ ok: true });
        });
        expect(router.push).toHaveBeenCalledWith('/boards/beta');
        await screen.unmount();
    });

    it('lets the answering agent retry the visible failed Board projection', async () => {
        vi.useRealTimers();
        await home!.restoreActiveConnection();
        failIndex = true;
        const failed = await renderMountedCurrentUiContext(<CommandPage><BoardsColumn /></CommandPage>);
        await vi.waitFor(() => expect(failed.findAllByType(SurfaceStateCard).find(card => card.props.testID === 'boards-read-state')?.props.kind).toBe('error'));
        const executor = createDefaultActionExecutor();
        const refusal = await executor.execute('ui.current_context.read', {}, { surface: 'agent' });
        if (!refusal.ok) throw new Error('Expected mounted recovery commands');
        const retry = CurrentUiContextSnapshotV1Schema.parse(refusal.result).commands.find(command => command.title === t('surfaceState.tryAgain'));
        expect(retry).toBeDefined();
        failIndex = false;
        await act(async () => {
            expect(await executor.execute('ui.current_context.command.invoke', { commandId: retry!.id }, { surface: 'agent' }))
                .toMatchObject({ ok: true });
        });
        await vi.waitFor(() => expect(failed.findByTestId('boards-read-state')).toBeNull());
        expect(failed.findByTestId('boards-column:board:beta')).not.toBeNull();
        await failed.unmount();
    });

    // More opens this page with no tab bar and no native header, so its head is the only way out.
    it('gives the phone page its own Back, and leaves the column beside a page without one', async () => {
        deviceState.type = 'phone';
        const page = await renderScreen(<InjectedAuthProvider credentials={credentials}><BoardsColumn surface="page" /></InjectedAuthProvider>);
        await flushHookEffects({ runOnlyPendingTimers: true });
        expect(page.findHostByTestId('boards-column:back')).not.toBeNull();
        deviceState.type = 'tablet';
        const column = await renderScreen(<InjectedAuthProvider credentials={credentials}><BoardsColumn /></InjectedAuthProvider>);
        await flushHookEffects({ runOnlyPendingTimers: true });
        expect(column.findHostByTestId('boards-column:back')).toBeNull();
    });

    // F2 (WHOLE-PAGE-ACCEPT-1112): every phone main screen opens on the same head as My work and Projects.
    it('heads the phone Boards main screen with the Home line and the main-screen title row', async () => {
        deviceState.type = 'phone';
        route.pathname = '/boards';
        const page = await renderScreen(<InjectedAuthProvider credentials={credentials}><BoardsColumn surface="page" /></InjectedAuthProvider>);
        await flushHookEffects({ runOnlyPendingTimers: true });
        expect(page.findHostByTestId('main-tab-nav-row')).not.toBeNull();
        expect(page.findHostByTestId('main-header-home-line')).not.toBeNull();
        // The magnifier and "+" are the main-screen head's, on the title row.
        expect(page.findHostByTestId('boards-column:search:toggle')).not.toBeNull();
        expect(page.findHostByTestId('boards-column:new:header')).not.toBeNull();
        expect(page.findHostByTestId('boards-column:back')).toBeNull();
    });

    it('keeps search behind its toggle, filters real Board names and creates from the header instead of a list row', async () => {
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><BoardsColumn /></InjectedAuthProvider>);
        await flushHookEffects({ runOnlyPendingTimers: true });
        await flushHookEffects({ runOnlyPendingTimers: true });
        expect(screen.findHostByTestId('boards-column:board:alpha')).not.toBeNull();
        expect(screen.findHostByTestId('boards-column:board:beta')).not.toBeNull();
        // A main screen's search waits behind its magnifier; the "+" in the title row is how a board is made.
        expect(screen.findHostByTestId('boards-column:search')).toBeNull();
        expect(screen.findHostByTestId('boards-column:new:header')).not.toBeNull();
        expect(screen.findHostByTestId('boards-column:new-row')).toBeNull();
        const { Item } = await import('@/components/ui/lists/Item');
        const navigation = screen.findAllByType(Item).filter(node => node.props.testID?.startsWith('boards-column:board:'));
        expect(navigation).toHaveLength(2);
        expect(navigation.every(node => node.props.rowRole === 'item' && node.props.titleLines === 1)).toBe(true);
        // Every Board would carry the same Boards glyph, so no row draws a leading mark and the names start on
        // the list's edge (LIST-ICONS-1108).
        expect(navigation.flatMap(node => node.findAll(child => typeof child.props.name === 'string').map(child => child.props.name))).toEqual([]);

        screen.pressByTestId('boards-column:search:toggle');
        await flushHookEffects();
        screen.changeTextByTestId('boards-column:search', '  ALPHA  ');
        await flushHookEffects();
        expect(screen.findHostByTestId('boards-column:board:alpha')).not.toBeNull();
        expect(screen.findHostByTestId('boards-column:board:beta')).toBeNull();

        screen.changeTextByTestId('boards-column:search', 'not a board');
        await flushHookEffects();
        expect(screen.findHostByTestId('boards-column:board:alpha')).toBeNull();
        screen.changeTextByTestId('boards-column:search', '');
        await flushHookEffects();
        expect(screen.findHostByTestId('boards-column:board:beta')).not.toBeNull();
    });

    it('selects no row on the phone main screen while the column beside a page selects the board it shows', async () => {
        route.pathname = '/boards';
        const selectedRows = async (surface: 'page' | 'plane') => {
            const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><BoardsColumn surface={surface} /></InjectedAuthProvider>);
            await flushHookEffects({ runOnlyPendingTimers: true });
            await flushHookEffects({ runOnlyPendingTimers: true });
            const { Item } = await import('@/components/ui/lists/Item');
            expect(screen.findHostByTestId('boards-column:board:alpha')).not.toBeNull();
            return screen.findAllByType(Item).filter(node => node.props.testID?.startsWith('boards-column:board:') && node.props.selected === true)
                .map(node => node.props.testID);
        };
        // On the main screen nothing is open, so nothing is selected; beside a page the first board is what it shows.
        deviceState.type = 'phone';
        expect(await selectedRows('page')).toEqual([]);
        deviceState.type = 'tablet';
        expect(await selectedRows('plane')).toHaveLength(1);
    });

    it('draws the phone main screen\'s boards as the column\'s own rows, flat with the kind\'s mark (owner 2026-11-15: one row anatomy, no card)', async () => {
        route.pathname = '/boards';
        const boardRows = async (surface: 'page' | 'plane') => {
            const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><BoardsColumn surface={surface} /></InjectedAuthProvider>);
            await flushHookEffects({ runOnlyPendingTimers: true });
            await flushHookEffects({ runOnlyPendingTimers: true });
            const { Item } = await import('@/components/ui/lists/Item');
            const { ItemGroup } = await import('@/components/ui/lists/ItemGroup');
            expect(screen.findHostByTestId('boards-column:board:alpha')).not.toBeNull();
            const row = screen.findAllByType(Item).find(node => node.props.testID === 'boards-column:board:alpha')!;
            return { row, grouped: screen.findAllByType(ItemGroup).some(group => group.findAll(node => node.props.testID === 'boards-column:board:alpha').length > 0) };
        };
        deviceState.type = 'phone';
        const page = await boardRows('page');
        // No card around the list and no chevron on its content rows; the row leads with the kind's mark.
        expect(page.grouped).toBe(false);
        expect(page.row.props.showChevron).toBe(false);
        expect(page.row.props.icon).toBeTruthy();
        deviceState.type = 'tablet';
        const column = await boardRows('plane');
        expect(column.grouped).toBe(false);
        expect(column.row.props.showChevron).toBe(false);
    });

    it('gives the empty phone page the Boards empty state with its New board action', async () => {
        noBoards = true;
        deviceState.type = 'phone';
        const page = await renderScreen(<InjectedAuthProvider credentials={credentials}><BoardsColumn surface="page" /></InjectedAuthProvider>);
        await flushHookEffects({ runOnlyPendingTimers: true });
        await flushHookEffects({ runOnlyPendingTimers: true });
        expect(page.findHostByTestId('boards-column:empty')).not.toBeNull();
        expect(page.findHostByTestId('boards-column:empty:new')).not.toBeNull();
        deviceState.type = 'tablet';
        // Beside the page, the page's own empty state says it once; the column stays quiet.
        const column = await renderScreen(<InjectedAuthProvider credentials={credentials}><BoardsColumn /></InjectedAuthProvider>);
        await flushHookEffects({ runOnlyPendingTimers: true });
        await flushHookEffects({ runOnlyPendingTimers: true });
        expect(column.findHostByTestId('boards-column:empty')).toBeNull();
    });

    it('renders the index names while every Board body is still pending', async () => {
        const gate = createDeferred<void>();
        bodyGate = gate.promise;
        try {
            const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><BoardsColumn surface="page" /></InjectedAuthProvider>);
            await flushHookEffects({ runOnlyPendingTimers: true });
            await flushHookEffects({ runOnlyPendingTimers: true });
            expect(screen.findHostByTestId('boards-column:board:alpha')).not.toBeNull();
            expect(screen.findHostByTestId('boards-column:board:beta')).not.toBeNull();
            expect(screen.getTextContent()).toContain('Alpha release');
        } finally {
            bodyGate = null;
            gate.resolve();
            await flushHookEffects();
        }
    });

    // Beside the column, the column says the index's read state; the page speaks only for its own Board.
    it.each([
        ['the index', () => { const gate = createDeferred<void>(); indexGate = gate.promise; return gate; }, 'boards-read-state'],
        ['the open Board body', () => { const gate = createDeferred<void>(); bodyGate = gate.promise; return gate; }, 'board-pending'],
    ] as const)('presents the read state for %s once across the column and the page', async (_label, hold, stateId) => {
        const gate = hold();
        try {
            const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}>
                <AppShellColumnContext.Provider value={{ present: true, columnVisible: true }}>
                    <BoardsColumn /><AppPaneProvider><BoardScreen boardId="alpha" /></AppPaneProvider>
                </AppShellColumnContext.Provider>
            </InjectedAuthProvider>);
            await flushHookEffects({ runOnlyPendingTimers: true });
            await flushHookEffects({ runOnlyPendingTimers: true });
            const loading = screen.findAllByType(SurfaceStateCard)
                .filter(state => state.props.kind === 'loading' && state.props.testID === stateId);
            expect(loading).toHaveLength(1);
            expect(screen.findAllByType(SurfaceStateCard)
                .filter(state => state.props.kind === 'loading')).toHaveLength(1);
            if (stateId === 'board-pending') {
                expect(screen.findHostByTestId('board-header')).not.toBeNull();
                expect(screen.getTextContent()).toContain('Alpha release');
            }
        } finally {
            indexGate = null;
            bodyGate = null;
            gate.resolve();
            await flushHookEffects();
        }
    });

    it('still says the Board is opening when Retry re-reads a failed index and the column stays quiet over its rows', async () => {
        const { useWorkBoardReadState } = await import('./model/useWorkBoards');
        const body = createDeferred<void>();
        bodyGate = body.promise;
        let retry: () => unknown = () => undefined;
        function Retry() { retry = useWorkBoardReadState().retry; return null; }
        const index = createDeferred<void>();
        try {
            const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}>
                <AppShellColumnContext.Provider value={{ present: true, columnVisible: true }}>
                    <BoardsColumn /><AppPaneProvider><BoardScreen boardId="alpha" /></AppPaneProvider><Retry />
                </AppShellColumnContext.Provider>
            </InjectedAuthProvider>);
            const loading = () => screen.findAllByType(SurfaceStateCard).filter(state => state.props.kind === 'loading').map(state => state.props.testID);
            await waitForHomeGovernance(() => expect(loading()).toEqual(['board-pending']));
            failIndex = true;
            await act(async () => { await retry(); });
            await waitForHomeGovernance(() => expect(screen.findAllByTestId('boards-read-stale').length).toBeGreaterThan(0));
            failIndex = false;
            indexGate = index.promise;
            await act(async () => { void retry(); });
            await waitForHomeGovernance(() => expect(screen.findHostByTestId('board-header')).not.toBeNull());
            expect(loading()).toEqual(['board-pending']);
        } finally {
            failIndex = false;
            indexGate = null;
            bodyGate = null;
            index.resolve();
            body.resolve();
            await flushHookEffects();
        }
    });

    it('re-reads the index quietly while the column already shows its rows', async () => {
        const gate = createDeferred<void>();
        indexGate = gate.promise;
        try {
            const { BoardReadState } = await import('./BoardReadState');
            const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}>
                <BoardReadState place="column" size="line" retained />
            </InjectedAuthProvider>);
            await flushHookEffects({ runOnlyPendingTimers: true });
            expect(screen.getTextContent()).not.toContain('Opening Boards');
        } finally {
            indexGate = null;
            gate.resolve();
            await flushHookEffects();
        }
    });

    it('keeps the index read state on the page when no column is beside it', async () => {
        const gate = createDeferred<void>();
        indexGate = gate.promise;
        try {
            const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><BoardsIndex /></InjectedAuthProvider>);
            await flushHookEffects({ runOnlyPendingTimers: true });
            expect(screen.getTextContent().split('Opening Boards').length - 1).toBe(1);
        } finally {
            indexGate = null;
            gate.resolve();
            await flushHookEffects();
        }
    });

    it('keeps populated column and pinned chrome free of card title construction while attention stays live', async () => {
        const serverId = home!.homes.boards!.id;
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}>{null}</InjectedAuthProvider>);
        const { getSyncSingleton } = await import('@/sync/runtime/getSyncSingleton');
        await act(async () => { await getSyncSingleton().awaitBootstrapForegroundAcquisition(); });
        let titleReads = 0;
        const rows = Object.fromEntries(Array.from({ length: 40 }, (_, index) => {
            const row = createSessionListRenderableSessionFixture({ id: `chrome-${index}`, active: true, activeAt: Date.now(), metadata: {
                path: '/repo', host: 'test', homeDir: '/home/test',
                get name() { titleReads += 1; return `Session ${index}`; },
            } });
            return [row.id, row];
        }));
        liveBoard = { ...boards[0]!, pinnedInSessions: true, source: { picked: Object.keys(rows).map(id => ({ kind: 'session', qualifiedId: { serverId, id } })) } };
        getStorage().setState({ sessionListRowsByServerId: { [serverId]: rows } });
        await screen.update(<InjectedAuthProvider credentials={credentials}><BoardsColumn />
            <PinnedBoardNeedsYouCount board={{ id: 'alpha', name: liveBoard.name, pinnedInSessions: true, source: { sections: [] }, counts: null }} />
        </InjectedAuthProvider>);
        await waitForHomeGovernance(() => expect(screen.findHostByTestId('boards-column:board:alpha')).not.toBeNull());
        expect(titleReads).toBe(0);
        // The pending-timer flush crossed the original runtime observation's freshness deadline.
        // A live permission prompt needs both current runtime presence and current request evidence.
        const updated = { ...rows['chrome-7']!, activeAt: Date.now(), hasPendingPermissionRequests: true, pendingRequestObservedAt: Date.now() };
        act(() => { getStorage().setState({ sessionListRowsByServerId: { [serverId]: { ...rows, [updated.id]: updated } } }); });
        expect(screen.findHostByTestId('boards-column:board:alpha:need-you')).not.toBeNull();
        expect(screen.findHostByTestId('pinned-board:alpha:need-you')).not.toBeNull();
        expect(titleReads).toBe(0);
    });

    it.each(['malformed_json', 'content_unavailable'] as const)('opens a named unreadable Board state for %s and keeps the neighboring Board reachable', async failure => {
        unreadableAlpha = failure;
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}>
            <BoardsColumn /><AppPaneProvider><BoardScreen boardId="alpha" /></AppPaneProvider>
        </InjectedAuthProvider>);
        await flushHookEffects({ runOnlyPendingTimers: true });
        await flushHookEffects({ runOnlyPendingTimers: true });
        expect(screen.findHostByTestId('board-unreadable')).not.toBeNull();
        expect(screen.findHostByTestId('board-not-found')).toBeNull();
        expect(screen.findHostByTestId('boards-column:board:beta')).not.toBeNull();
        const state = screen.tree.findAllByType(SurfaceStateCard).find(node => node.props.testID === 'board-unreadable');
        expect(state?.props.title).toContain('Alpha release');
        expect(state?.props.action?.onPress).toBeTypeOf('function');
    });
});
