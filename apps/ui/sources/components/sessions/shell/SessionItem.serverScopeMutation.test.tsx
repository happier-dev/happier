import React from 'react';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture, createPlainAccountEncryptionCurrentnessFixture, createRootLayoutFeaturesResponse, createSessionFixture, pressTestInstanceAsync, renderScreen as renderCanonicalScreen, standardCleanup } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { observeMachinePresenceForTest } from '@/dev/testkit/harness/machinePresence';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
    createModelBackedSessionItemTestComponent,
    type ModelBackedSessionItemTestProps,
} from './sessionItemRowViewModelTestFixture';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';
import {
    SESSION_ACTION_ARCHIVE_ID,
    SESSION_ACTION_DELETE_ID,
    SESSION_ACTION_MARK_READ_ID,
    SESSION_ACTION_MARK_UNREAD_ID,
    SESSION_ACTION_MOVE_TO_FOLDER_ID,
    SESSION_ACTION_STOP_ID,
} from '@/components/sessions/actions/sessionActionIds';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;


vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/components/ui/forms/dropdown/ContextMenu', () => ({
    ContextMenu: (props: any) => React.createElement('ContextMenu', props),
}));

vi.mock('react-native-gesture-handler', () => ({
    Swipeable: (props: any) => React.createElement('Swipeable', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: 'Avatar',
}));

vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: 'StatusDot',
}));

vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => vi.fn(),
}));

const modalConfirmSpy = vi.fn(async () => true);
let hideInactiveSessions = false;
let rejectFirstArchive = false;

const modalAlertSpy = vi.fn();

installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            confirmResult: true,
            spies: {
                alert: modalAlertSpy,
                confirm: modalConfirmSpy,
            },
        }).module;
    },
    storage: async (importOriginal) => importOriginal(),
});

// The common presentation harness must not replace the registered state owner.
vi.doUnmock('@/sync/domains/state/storage');
vi.doUnmock('@/hooks/session/useDraft');
vi.doUnmock('@/agents/registry/registryUiBehavior');
const network = await installSessionOpsNetworkBoundary();
const { getSessionStatus } = await import('@/utils/sessions/sessionUtils');
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
let previousState: ReturnType<typeof storage.getState>;
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
const mutationRequests: Array<{ url: string; method: string; token: string | null; body: unknown }> = [];
const mutationOrder: string[] = [];
afterAll(() => network.dispose());

async function renderScreen(element: React.ReactElement<ModelBackedSessionItemTestProps>) {
    const props = element.props;
    if (props.session && props.serverId) {
        const homeUrl = `https://${props.serverId.replaceAll('_', '-')}.test`;
        const home = await network.addHome(homeUrl, 'row-account');
        const session = createSessionFixture({ ...props.session, serverId: home.id,
            metadata: { ...('agentState' in props.session ? props.session.metadata : undefined), path: '/repo', host: 'tester.local', machineId: 'machine-row', name: 'Scoped row' },
        });
        const sessionHttp = createSessionMetadataHttpBoundary(() => ({ [session.id]: session }));
        account = await restoreServerAccountForTest({ serverUrl: homeUrl, accountId: 'row-account', request: createSessionReadBatchFetchBoundary(async (input, init) => {
            const url = new URL(String(input));
            const method = init?.method ?? 'GET';
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (url.pathname === '/v1/features' || url.pathname === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (url.pathname === '/v1/machines/read-batch' && method === 'POST') return createMachineReadBatchResponseFixture(init?.body,
                id => id === 'machine-row' ? createPlainMachineRowFixture({ id, accountId: 'row-account' }) : null);
            if (url.pathname.startsWith('/v1/machines/')) return Response.json({ machine: { id: 'machine-row', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } });
            if (method === 'DELETE' && url.pathname === `/v1/sessions/${session.id}`) {
                mutationRequests.push({ url: url.href, method, token: new Headers(init?.headers).get('authorization'), body: null });
                return Response.json({ success: true });
            }
            if (method === 'POST' && (url.pathname.endsWith('/archive') || url.pathname.endsWith('/read-state'))) {
                mutationRequests.push({ url: url.href, method, token: new Headers(init?.headers).get('authorization'), body: init?.body ? JSON.parse(String(init.body)) : null });
                mutationOrder.push(url.pathname.endsWith('/archive') ? 'archive' : 'read-state');
                if (url.pathname.endsWith('/archive')) {
                    if (rejectFirstArchive) { rejectFirstArchive = false; return Response.json({ error: 'session_active' }, { status: 409 }); }
                    return Response.json({ archivedAt: 1 });
                }
                return Response.json({ success: true, state: 'unread', lastViewedSessionSeq: 0, didChange: true });
            }
            return sessionHttp.handle(input, init) ?? Response.json({}, { status: 404 });
        }) });
        storage.getState().applyMachines([createMachineFixture({ id: 'machine-row' })], true, { sourceServerId: home.id });
        observeMachinePresenceForTest({ serverId: home.id, accountId: 'row-account' }, ['machine-row']);
        storage.getState().applySessions([session]);
        return renderCanonicalScreen(React.cloneElement(element, { ...props, session, serverId: home.id }));
    }
    return renderCanonicalScreen(element);
}

async function expectStopRequest(sessionId: string) {
    await vi.waitFor(() => expect({
        requests: network.requests.filter((request) => request.method === RPC_METHODS.STOP_SESSION),
        alerts: modalAlertSpy.mock.calls,
    }).toEqual({
        requests: [expect.objectContaining({ serverUrl: account!.home.serverUrl, targetId: 'machine-row', payload: { sessionId }, token: account!.credentials.token })],
        alerts: [],
    }));
}

async function expectArchiveRequests(sessionId: string, count = 1) {
    await vi.waitFor(() => {
    expect(mutationRequests.filter((request) => request.url.endsWith('/archive'))).toEqual(Array.from({ length: count }, () => ({
        url: `${account!.home.serverUrl}/v2/sessions/${sessionId}/archive`, method: 'POST', token: `Bearer ${account!.credentials.token}`, body: null,
    })));
    expect(storage.getState().sessions[sessionId]?.archivedAt).toBe(1);
    });
}

async function importSessionItem() {
    const { SessionItem } = await import('./SessionItem');
    return createModelBackedSessionItemTestComponent(SessionItem, {
        resolveRowViewModelOverrides: (props) => ({ hideInactiveSessions, sessionStatus: getSessionStatus(props.session) }),
    });
}

describe('SessionItem server-scoped mutations', () => {
    it('deletes an archived row through its native menu, confirmation and exact-Home Action transport', async () => {
        const SessionItem = await importSessionItem();
        const screen = await renderScreen(<SessionItem
            session={createSessionFixture({ id: 'sess_archived_delete', active: false, activeAt: 0, presence: 0, archivedAt: 42,
                metadata: { path: '/repo', host: 'tester.local' } })}
            serverId="server_a" selected={false} variant="default" compact={false}
        />);
        const menu = screen.root.findAll(node => String(node.type) === 'ContextMenu').find(node =>
            Array.isArray(node.props.items) && node.props.items.some((item: { id?: string }) => item.id === SESSION_ACTION_DELETE_ID));
        expect(menu).toBeTruthy();
        await act(async () => { menu!.props.onSelect(SESSION_ACTION_DELETE_ID); });
        await vi.waitFor(() => expect(mutationRequests.filter(request => request.method === 'DELETE')).toEqual([{
            url: `${account!.home.serverUrl}/v1/sessions/sess_archived_delete`, method: 'DELETE',
            token: `Bearer ${account!.credentials.token}`, body: null,
        }]));
        expect(modalConfirmSpy).toHaveBeenCalledWith('sessionInfo.deleteSession', expect.any(String), expect.objectContaining({ destructive: true }));
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it.each(['active', 'preserved terminal', 'lost access'] as const)(
        'does not delete when the current row changes to %s while confirmation is open', async (change) => {
            const SessionItem = await importSessionItem();
            const sessionId = 'sess_archived_changed';
            const screen = await renderScreen(<SessionItem
                session={createSessionFixture({ id: sessionId, active: false, activeAt: 0, presence: 0, archivedAt: 42 })}
                serverId="server_a" selected={false} variant="default" compact={false}
            />);
            const menu = screen.root.findAll(node => String(node.type) === 'ContextMenu').find(node =>
                Array.isArray(node.props.items) && node.props.items.some((item: { id?: string }) => item.id === SESSION_ACTION_DELETE_ID));
            expect(menu).toBeTruthy();
            modalConfirmSpy.mockImplementationOnce(async () => {
                const current = storage.getState().sessions[sessionId]!;
                const changed = createSessionFixture({ ...current,
                    metadataVersion: current.metadataVersion + 1,
                    ...(change === 'active' ? { active: true, activeAt: Date.now(), presence: 'online' } : {}),
                    ...(change === 'preserved terminal' ? { metadata: { ...current.metadata,
                        path: '/repo', host: 'tester.local', terminal: { controlServiceabilityV1: {
                            v: 1, state: 'recoverable_unservable', observedAt: Date.now(), retired: false,
                        } },
                    } } : {}),
                    ...(change === 'lost access' ? { access: null } : {}),
                });
                storage.getState().applyServerScopedSessionListRows(account!.home.id,
                    [buildSessionListRenderableFromSession(changed)], { source: 'archived', mode: 'append' });
                expect(storage.getState().sessions[sessionId]!.active).toBe(false);
                return true;
            });
            await act(async () => { menu!.props.onSelect(SESSION_ACTION_DELETE_ID); });
            await vi.waitFor(() => expect(modalAlertSpy).toHaveBeenCalled());
            expect(mutationRequests.filter(request => request.method === 'DELETE')).toEqual([]);
        },
    );

    it('warns that an offline managed archived row keeps its machine folder', async () => {
        const SessionItem = await importSessionItem();
        const screen = await renderScreen(<SessionItem
            session={createSessionFixture({ id: 'sess_archived_managed', active: false, activeAt: 0, presence: 0, archivedAt: 42,
                metadata: { path: '/managed', host: 'tester.local', machineId: 'machine-row', sessionDirectoryV1: { v: 1, kind: 'managed' } } })}
            serverId="server_a" selected={false} variant="default" compact={false}
        />);
        storage.getState().applyMachines([createMachineFixture({ id: 'machine-row', active: false, activeAt: 0 })], true,
            { sourceServerId: account!.home.id });
        observeMachinePresenceForTest({ serverId: account!.home.id, accountId: 'row-account' }, ['machine-row']);
        const menu = screen.root.findAll(node => String(node.type) === 'ContextMenu').find(node =>
            Array.isArray(node.props.items) && node.props.items.some((item: { id?: string }) => item.id === SESSION_ACTION_DELETE_ID));
        expect(menu).toBeTruthy();
        modalConfirmSpy.mockResolvedValueOnce(false);
        await act(async () => { menu!.props.onSelect(SESSION_ACTION_DELETE_ID); });
        await vi.waitFor(() => expect(modalConfirmSpy).toHaveBeenCalledWith('sessionInfo.deleteSession',
            expect.stringContaining('sessionDirectoryRecovery.offlineDelete'), expect.objectContaining({ destructive: true })));
        expect(mutationRequests.filter(request => request.method === 'DELETE')).toEqual([]);
    });

    it('keeps an archived session when the delete confirmation is declined', async () => {
        const SessionItem = await importSessionItem();
        const screen = await renderScreen(<SessionItem
            session={createSessionFixture({ id: 'sess_archived_cancel', active: false, activeAt: 0, presence: 0, archivedAt: 42 })}
            serverId="server_a" selected={false} variant="default" compact={false}
        />);
        const menu = screen.root.findAll(node => String(node.type) === 'ContextMenu').find(node =>
            Array.isArray(node.props.items) && node.props.items.some((item: { id?: string }) => item.id === SESSION_ACTION_DELETE_ID));
        expect(menu).toBeTruthy();
        modalConfirmSpy.mockResolvedValueOnce(false);
        await act(async () => { menu!.props.onSelect(SESSION_ACTION_DELETE_ID); });
        expect(modalConfirmSpy).toHaveBeenCalled();
        expect(mutationRequests.filter(request => request.method === 'DELETE')).toEqual([]);
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it('stops directly through the shared Action policy without a local confirmation', async () => {
        const SessionItem = await importSessionItem();
        const screen = await renderScreen(<SessionItem
            session={createSessionFixture({ id: 'sess_direct_stop', active: true })}
            serverId="server_a" serverName="Server A" showServerBadge={true}
            selected={false}
            variant="default" compact={false}
        />);
        const menu = screen.root.findAll(node => String(node.type) === 'ContextMenu').find(node =>
            Array.isArray(node.props.items) && node.props.items.some((item: { id?: string }) => item.id === SESSION_ACTION_STOP_ID));
        expect(menu).toBeTruthy();
        await act(async () => { await menu!.props.onSelect(SESSION_ACTION_STOP_ID); });
        await expectStopRequest('sess_direct_stop');
        expect(modalConfirmSpy).not.toHaveBeenCalled();
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    beforeEach(() => {
        previousState = storage.getState();
        network.resetRequests();
        network.setRpcResponder(async (request) => {
            if (request.method !== RPC_METHODS.STOP_SESSION) throw new Error(`Unexpected row RPC: ${request.method}`);
            mutationOrder.push('stop');
            return { status: 'stopped' };
        });
        mutationRequests.length = 0;
        mutationOrder.length = 0;
        rejectFirstArchive = false;
        modalConfirmSpy.mockReset().mockResolvedValue(true);
        modalAlertSpy.mockClear();
        storage.setState({ sessions: {}, sessionListRowsByServerId: {}, machines: {}, machineListByServerId: {} });
    });
    afterEach(async () => {
        standardCleanup();
        await account?.dispose();
        account = undefined;
        storage.setState(previousState, true);
        hideInactiveSessions = false;
    });

    it('archives active sessions from the swipe action using server scope when serverId is provided', async () => {
        modalAlertSpy.mockClear();

        const SessionItem = await importSessionItem();

        const session = createSessionFixture({
            id: 'sess_1',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        });

        const screen = await renderScreen(
            <SessionItem
                session={session}
                serverId="server_a"
                serverName="Server A"
                showServerBadge={true}
                selected={false}
                variant="default"
                compact={false}
            />,
        );

        const swipeable = screen.find((node: any) => typeof node.props?.renderRightActions === 'function');
        const rightActions = swipeable.props.renderRightActions();
        const rightActionsScreen = await renderScreen(rightActions);
        await act(async () => {
            await pressTestInstanceAsync(
                rightActionsScreen.find((node: any) => node.type === 'Pressable'),
                'session swipe action',
            );
        });

        expect(modalConfirmSpy).not.toHaveBeenCalled();
        expect(modalAlertSpy).not.toHaveBeenCalled();

        await expectStopRequest('sess_1');
        await expectArchiveRequests('sess_1');
        expect(mutationOrder).toEqual(['stop', 'archive']);
    });

    it('archives inactive sessions using server scope when serverId is provided', async () => {
        modalAlertSpy.mockClear();
        modalConfirmSpy.mockClear();

        const SessionItem = await importSessionItem();

        const session = createSessionFixture({
            id: 'sess_2',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: false,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 0,
        });

        const screen = await renderScreen(
            <SessionItem
                session={session}
                serverId="server_b"
                serverName="Server B"
                showServerBadge={true}
                selected={false}
                variant="default"
                compact={false}
            />,
        );

        const swipeable = screen.find((node: any) => typeof node.props?.renderRightActions === 'function');
        const rightActions = swipeable.props.renderRightActions();
        const rightActionsScreen = await renderScreen(rightActions);
        await act(async () => {
            await pressTestInstanceAsync(
                rightActionsScreen.find((node: any) => node.type === 'Pressable'),
                'session swipe action',
            );
        });

        expect(modalConfirmSpy).not.toHaveBeenCalled();
        expect(modalAlertSpy).not.toHaveBeenCalled();

        await expectArchiveRequests('sess_2');
        expect(mutationOrder).toEqual(['archive']);
        expect(network.requests.filter((request) => request.method === RPC_METHODS.STOP_SESSION)).toEqual([]);
    });

    it('stops and retries archiving when an inactive-looking session is still active server-side', async () => {
        rejectFirstArchive = true;
        modalAlertSpy.mockClear();
        modalConfirmSpy.mockClear();

        const SessionItem = await importSessionItem();

        const session = createSessionFixture({
            id: 'sess_stale_inactive',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: false,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 0,
        });

        const screen = await renderScreen(
            <SessionItem
                session={session}
                serverId="server_b"
                serverName="Server B"
                showServerBadge={true}
                selected={false}
                variant="default"
                compact={false}
            />,
        );

        const swipeable = screen.find((node: any) => typeof node.props?.renderRightActions === 'function');
        const rightActions = swipeable.props.renderRightActions();
        const rightActionsScreen = await renderScreen(rightActions);
        await act(async () => {
            await pressTestInstanceAsync(
                rightActionsScreen.find((node: any) => node.type === 'Pressable'),
                'session swipe action',
            );
        });

        expect(modalConfirmSpy).not.toHaveBeenCalled();
        expect(modalAlertSpy).not.toHaveBeenCalled();
        await expectStopRequest('sess_stale_inactive');
        await expectArchiveRequests('sess_stale_inactive', 2);
        expect(mutationOrder).toEqual(['archive', 'stop', 'archive']);
    });

    it('archives active sessions from the swipe action when hidden inactive sessions are enabled', async () => {
        hideInactiveSessions = true;
        modalAlertSpy.mockClear();
        modalConfirmSpy.mockClear();

        const SessionItem = await importSessionItem();

        const session = createSessionFixture({
            id: 'sess_3',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        });

        const screen = await renderScreen(
            <SessionItem
                session={session}
                serverId="server_c"
                serverName="Server C"
                showServerBadge={true}
                selected={false}
                variant="default"
                compact={false}
            />,
        );

        const swipeable = screen.find((node: any) => typeof node.props?.renderRightActions === 'function');
        const rightActions = swipeable.props.renderRightActions();
        const rightActionsScreen = await renderScreen(rightActions);
        await act(async () => {
            await pressTestInstanceAsync(
                rightActionsScreen.find((node: any) => node.type === 'Pressable'),
                'session swipe action',
            );
        });

        expect(modalConfirmSpy).not.toHaveBeenCalled();
        expect(modalAlertSpy).not.toHaveBeenCalled();

        await expectStopRequest('sess_3');
        await expectArchiveRequests('sess_3');
        expect(mutationOrder).toEqual(['stop', 'archive']);
    });

    it('offers an archive action for active sessions in the more menu and stops before archiving', async () => {
        hideInactiveSessions = false;
        modalAlertSpy.mockClear();
        modalConfirmSpy.mockClear();

        const SessionItem = await importSessionItem();

        const session = createSessionFixture({
            id: 'sess_active_archive',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        });

        const screen = await renderScreen(
            <SessionItem
                session={session}
                serverId="server_d"
                serverName="Server D"
                showServerBadge={true}
                selected={false}
                variant="default"
                compact={false}
            />,
        );

        const contextMenus = screen.root.findAll((node: any) => node.type === 'ContextMenu');
        const moreMenu = contextMenus.find((node: any) =>
            Array.isArray(node.props?.items) && node.props.items.some((item: any) => item?.id === SESSION_ACTION_ARCHIVE_ID),
        );
        expect(moreMenu).toBeTruthy();
        expect(moreMenu!.props.items.some((item: any) => item?.id === SESSION_ACTION_STOP_ID)).toBe(true);

        await act(async () => {
            moreMenu!.props.onSelect(SESSION_ACTION_ARCHIVE_ID);
        });

        expect(modalConfirmSpy).not.toHaveBeenCalled();
        expect(modalAlertSpy).not.toHaveBeenCalled();

        await expectStopRequest('sess_active_archive');
        await expectArchiveRequests('sess_active_archive');
        expect(mutationOrder).toEqual(['stop', 'archive']);
    });

    it('archives pinned active sessions from the swipe action when hidden inactive sessions are enabled', async () => {
        hideInactiveSessions = true;
        modalAlertSpy.mockClear();
        modalConfirmSpy.mockClear();

        const SessionItem = await importSessionItem();

        const session = createSessionFixture({
            id: 'sess_4',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        });

        const screen = await renderScreen(
            <SessionItem
                session={session}
                serverId="server_d"
                serverName="Server D"
                showServerBadge={true}
                selected={false}
                variant="default"
                compact={false}
                pinned={true}
            />,
        );

        const swipeable = screen.find((node: any) => typeof node.props?.renderRightActions === 'function');
        const rightActions = swipeable.props.renderRightActions();
        const rightActionsScreen = await renderScreen(rightActions);
        await act(async () => {
            await pressTestInstanceAsync(
                rightActionsScreen.find((node: any) => node.type === 'Pressable'),
                'session swipe action',
            );
        });

        expect(modalConfirmSpy).not.toHaveBeenCalled();
        expect(modalAlertSpy).not.toHaveBeenCalled();

        await expectStopRequest('sess_4');
        await expectArchiveRequests('sess_4');
        expect(mutationOrder).toEqual(['stop', 'archive']);
    });

    it('offers manual mark-unread in the context menu and uses server scope', async () => {
        const SessionItem = await importSessionItem();

        const session = createSessionFixture({
            id: 'sess_read',
            seq: 3,
            lastViewedSessionSeq: 3,
            latestTurnStatus: 'completed',
            createdAt: 1,
            updatedAt: 1,
            active: false,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 0,
        });

        const screen = await renderScreen(
            <SessionItem
                session={session}
                serverId="server_read"
                serverName="Server Read"
                showServerBadge={true}
                selected={false}
                variant="default"
                compact={false}
            />,
        );

        const contextMenu = screen.root.findAll((node: any) => node.type === 'ContextMenu').find((node: any) =>
            Array.isArray(node.props?.items) && node.props.items.some((item: any) => item?.id === SESSION_ACTION_MARK_UNREAD_ID),
        );
        expect(contextMenu).toBeTruthy();

        await act(async () => {
            contextMenu!.props.onSelect(SESSION_ACTION_MARK_UNREAD_ID);
        });

        expect(mutationRequests).toEqual([{ url: `${account!.home.serverUrl}/v2/sessions/sess_read/read-state`, method: 'POST', token: `Bearer ${account!.credentials.token}`, body: { state: 'unread' } }]);
        expect(storage.getState().sessions.sess_read.lastViewedSessionSeq).toBe(0);
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it('does not offer read-state actions in the context menu from non-terminal raw seq', async () => {
        const SessionItem = await importSessionItem();

        const session = createSessionFixture({
            id: 'sess_raw_seq',
            seq: 5,
            lastViewedSessionSeq: 4,
            latestTurnStatus: 'in_progress',
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        });

        const screen = await renderScreen(
            <SessionItem
                session={session}
                serverId="server_raw"
                serverName="Server Raw"
                showServerBadge={true}
                selected={false}
                variant="default"
                compact={false}
            />,
        );

        const contextMenus = screen.root.findAll((node: any) => node.type === 'ContextMenu');
        expect(contextMenus.some((node: any) =>
            Array.isArray(node.props?.items) && node.props.items.some((item: any) => item?.id === SESSION_ACTION_MARK_UNREAD_ID || item?.id === SESSION_ACTION_MARK_READ_ID),
        )).toBe(false);
    });

    it('routes the move-to-folder menu item and accessibility actions through the accessible move callbacks', async () => {
        const onMoveToFolder = vi.fn();
        const onMoveToWorkspaceRoot = vi.fn();
        const onMoveUp = vi.fn();
        const onMoveDown = vi.fn();
        const SessionItem = await importSessionItem();

        const session = createSessionFixture({
            id: 'sess_accessible_move',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: false,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 0,
        });

        const screen = await renderScreen(
            <SessionItem
                session={session}
                serverId="server_folder"
                serverName="Server Folder"
                showServerBadge={true}
                selected={false}
                variant="default"
                compact={false}
                onMoveToFolder={onMoveToFolder}
                onMoveToWorkspaceRoot={onMoveToWorkspaceRoot}
                onMoveUp={onMoveUp}
                onMoveDown={onMoveDown}
            />,
        );

        const contextMenu = screen.root.findAll((node: any) => node.type === 'ContextMenu').find((node: any) =>
            Array.isArray(node.props?.items) && node.props.items.some((item: any) => item?.id === SESSION_ACTION_MOVE_TO_FOLDER_ID),
        );
        expect(contextMenu).toBeTruthy();
        const moveToFolderItem = contextMenu!.props.items.find((item: any) => item?.id === SESSION_ACTION_MOVE_TO_FOLDER_ID);
        expect(moveToFolderItem.submenu).toBeUndefined();

        await act(async () => {
            contextMenu!.props.onSelect(SESSION_ACTION_MOVE_TO_FOLDER_ID);
        });
        expect(onMoveToFolder).toHaveBeenCalledTimes(1);

        const row = screen.findByProps({ testID: 'session-list-item-sess_accessible_move' });
        expect(row.props.accessibilityActions).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'moveUp' }),
            expect.objectContaining({ name: 'moveDown' }),
            expect.objectContaining({ name: 'moveToFolder' }),
            expect.objectContaining({ name: 'moveToWorkspaceRoot' }),
        ]));

        await act(async () => {
            row.props.onAccessibilityAction({ nativeEvent: { actionName: 'moveUp' } });
            row.props.onAccessibilityAction({ nativeEvent: { actionName: 'moveDown' } });
            row.props.onAccessibilityAction({ nativeEvent: { actionName: 'moveToFolder' } });
            row.props.onAccessibilityAction({ nativeEvent: { actionName: 'moveToWorkspaceRoot' } });
        });

        expect(onMoveUp).toHaveBeenCalledTimes(1);
        expect(onMoveDown).toHaveBeenCalledTimes(1);
        expect(onMoveToFolder).toHaveBeenCalledTimes(2);
        expect(onMoveToWorkspaceRoot).toHaveBeenCalledTimes(1);
    });

    it('hides manual read-state actions for archived sessions', async () => {
        const SessionItem = await importSessionItem();

        const session = createSessionFixture({
            id: 'sess_archived_read',
            seq: 3,
            lastViewedSessionSeq: 3,
            createdAt: 1,
            updatedAt: 1,
            active: false,
            activeAt: 1,
            archivedAt: 2,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 0,
        });

        const screen = await renderScreen(
            <SessionItem
                session={session}
                serverId="server_archived"
                serverName="Server Archived"
                showServerBadge={true}
                selected={false}
                variant="default"
                compact={false}
            />,
        );

        const contextMenus = screen.root.findAll((node: any) => node.type === 'ContextMenu');
        expect(contextMenus.some((node: any) =>
            Array.isArray(node.props?.items) && node.props.items.some((item: any) => item?.id === SESSION_ACTION_MARK_UNREAD_ID || item?.id === SESSION_ACTION_MARK_READ_ID),
        )).toBe(false);
    });
});
