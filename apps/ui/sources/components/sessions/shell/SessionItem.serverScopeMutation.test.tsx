import React from 'react';
import { createPlainMachineReadHttpResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { act } from 'react-test-renderer';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture, createPlainAccountEncryptionCurrentnessFixture, createRootLayoutFeaturesResponse, createSessionFixture, pressTestInstanceAsync, renderScreen as renderCanonicalScreen, standardCleanup } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createExternalActionAccountHttpBoundary, type ExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readSessionAuthoredDisplayV1 } from '@happier-dev/protocol/sessions/metadata/sessionDisplaySchemasV1';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { HappyError } from '@/utils/errors/errors';
import {
    createModelBackedSessionItemTestComponent,
    type ModelBackedSessionItemTestProps,
} from './sessionItemRowViewModelTestFixture';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';
import {
    SESSION_ACTION_ARCHIVE_ID,
    SESSION_ACTION_CLEAR_STATUS_ID,
    SESSION_ACTION_DELETE_ID,
    SESSION_ACTION_MARK_READ_ID,
    SESSION_ACTION_MARK_UNREAD_ID,
    SESSION_ACTION_MOVE_TO_FOLDER_ID,
    SESSION_ACTION_RENAME_ID,
    SESSION_ACTION_STOP_ID,
} from '@/components/sessions/actions/sessionActionIds';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;




vi.mock('react-native-gesture-handler', () => ({
    Swipeable: (props: any) => React.createElement('Swipeable', props),
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
// Real menu dependencies retain Socket consumers, so install the SDK boundary first.
const network = await installSessionOpsNetworkBoundary();
const { getSessionStatus } = await import('@/utils/sessions/sessionUtils');
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { AuthProvider } = await import('@/auth/context/AuthContext');
let previousState: ReturnType<typeof storage.getState>;
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let rowMachine: ReturnType<typeof createMachineFixture>;
const deleteReplies: Response[] = [];
const mutationRequests: Array<{ url: string; method: string; token: string | null; body: unknown }> = [];
const metadataPatchRequests: Array<{ url: string; token: string | null }> = [];
const mutationOrder: string[] = [];
afterAll(() => network.dispose());

async function renderScreen(
    element: React.ReactElement<ModelBackedSessionItemTestProps>,
    options: {
        machineBound?: boolean;
        machineOnline?: boolean;
        nativeDelete?: { serverIdentityId: string; boundary: ExternalActionAccountHttpBoundary };
    } = {},
) {
    const { machineBound = true, machineOnline = true, nativeDelete } = options;
    const props = element.props;
    if (props.session && props.serverId) {
        const homeUrl = `https://${props.serverId.replaceAll('_', '-')}.test`;
        const home = await network.addHome(homeUrl, 'row-account', { serverIdentityId: nativeDelete?.serverIdentityId });
        rowMachine = createMachineFixture({
            id: 'machine-row',
            active: machineOnline,
            activeAt: machineOnline ? Date.now() : 1,
            access: createPlainMachineRowFixture({ id: 'machine-row', accountId: 'row-account' }).access,
        });
        const session = createSessionFixture({ ...props.session, serverId: home.id,
            metadata: {
                path: '/repo', host: 'tester.local', name: 'Scoped row',
                ...('agentState' in props.session ? props.session.metadata : undefined),
                ...(machineBound ? { machineId: 'machine-row' } : {}),
            },
        });
        const sessionHttp = createSessionMetadataHttpBoundary(() => ({ [session.id]: session }));
        account = await restoreServerAccountForTest({ serverUrl: homeUrl, accountId: 'row-account',
            ...(nativeDelete ? { serverIdentityId: nativeDelete.serverIdentityId, credentials: { token: home.token } } : {}),
            request: createSessionReadBatchFetchBoundary(async (input, init) => {
            const url = new URL(String(input));
            const method = init?.method ?? 'GET';
            if (url.pathname === '/v1/account/profile') return Response.json(AccountProfileSchema.parse({ id: 'row-account' }));
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (url.pathname === '/v1/features' || url.pathname === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            const nativeResponse = await nativeDelete?.boundary.handle(url, init);
            if (nativeResponse) return nativeResponse;
            const machineResponse = createPlainMachineReadHttpResponseFixture(url.pathname, init, 'row-account', rowMachine);
            if (machineResponse) return machineResponse;
            if (url.pathname === '/v1/machines') return Response.json([createPlainMachineRowFixture({ id: 'machine-row', accountId: 'row-account', machine: rowMachine })]);
            if (method === 'DELETE' && url.pathname === `/v1/sessions/${session.id}`) {
                mutationRequests.push({ url: url.href, method, token: new Headers(init?.headers).get('authorization'), body: null });
                mutationOrder.push('delete');
                return deleteReplies.shift() ?? Response.json({ success: true });
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
            const sessionResponse = sessionHttp.handle(input, init);
            if (method === 'PATCH' && url.pathname === `/v2/sessions/${session.id}` && sessionResponse?.ok) {
                metadataPatchRequests.push({ url: url.href, token: new Headers(init?.headers).get('authorization') });
            }
            return sessionResponse ?? Response.json({}, { status: 404 });
        }) });
        storage.getState().applyMachines([rowMachine], true, { sourceServerId: home.id });
        await publishMachineInventoryForTest({ serverId: home.id, accountId: 'row-account' }, [rowMachine]);
        storage.getState().applySessions([session]);
        return renderCanonicalScreen(<AuthProvider initialCredentials={account.credentials}>
            {React.cloneElement(element, { ...props, session, serverId: home.id })}
        </AuthProvider>, {
            createNodeMock: (element) => element.type === 'Swipeable' ? { close() {} } : {
                measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) =>
                    callback(16, 32, 280, 48),
            },
        });
    }
    return renderCanonicalScreen(element);
}

function menuOptionTestId(actionId: string): string {
    return `dropdown-option-${actionId.replaceAll('.', '_')}`;
}

async function openRowMenu(screen: Awaited<ReturnType<typeof renderScreen>>, sessionId: string) {
    const rowId = `session-list-item-${sessionId}`;
    await act(async () => { screen.findHostByTestId(rowId)!.props.onLongPress(); });
}

async function pressRowMenuAction(screen: Awaited<ReturnType<typeof renderScreen>>, actionId: string) {
    const testId = menuOptionTestId(actionId);
    await vi.waitFor(() => expect(screen.findHostByTestId(testId)).toBeTruthy());
    await screen.pressByTestIdAsync(testId);
}

async function expectStopRequest(sessionId: string) {
    await vi.waitFor(() => expect({
        requests: network.requests.filter((request) => request.method === RPC_METHODS.STOP_SESSION),
        alerts: modalAlertSpy.mock.calls,
    }, JSON.stringify(modalAlertSpy.mock.calls)).toEqual({
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
    it('clears the authored note and progress through the row menu on their owning Home', async () => {
        const SessionItem = await importSessionItem();
        const sessionId = 'sess_clear_status';
        const screen = await renderScreen(<SessionItem
            session={createSessionFixture({ id: sessionId, metadata: {
                path: '/repo', host: 'tester.local',
                work: { statusReason: 'Check Session rows', statusReasonSetAt: 12,
                    statusProgress: { label: 'QA', done: 1, total: 24 } },
            } })}
            serverId="server_a" selected={false} compact={false}
        />, { machineBound: false });
        const readStatus = () => readSessionAuthoredDisplayV1(
            readSessionOwnerMetadataView(storage.getState().sessions[sessionId])?.work,
        );
        expect(readStatus()).toMatchObject({
            statusReason: 'Check Session rows', statusProgress: { label: 'QA', done: 1, total: 24 },
        });

        await openRowMenu(screen, sessionId);
        await pressRowMenuAction(screen, SESSION_ACTION_CLEAR_STATUS_ID);

        await vi.waitFor(() => {
            expect(readStatus()?.statusReason ?? null).toBeNull();
            expect(readStatus()?.statusProgress ?? null).toBeNull();
        });
        expect(metadataPatchRequests).toEqual([{
            url: `${account!.home.serverUrl}/v2/sessions/${sessionId}`,
            token: `Bearer ${account!.credentials.token}`,
        }]);
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it('deletes an archived row through its native menu, confirmation and exact-Home Action transport', async () => {
        const SessionItem = await importSessionItem();
        const screen = await renderScreen(<SessionItem
            session={createSessionFixture({ id: 'sess_archived_delete', active: false, activeAt: 0, presence: 0, archivedAt: 42,
                metadata: { path: '/repo', host: 'tester.local' } })}
            serverId="server_a" selected={false} compact={false}
        />, { machineBound: false });
        await openRowMenu(screen, 'sess_archived_delete');
        await pressRowMenuAction(screen, SESSION_ACTION_DELETE_ID);
        await vi.waitFor(() => expect(mutationRequests.filter(request => request.method === 'DELETE')).toEqual([{
            url: `${account!.home.serverUrl}/v1/sessions/sess_archived_delete`, method: 'DELETE',
            token: `Bearer ${account!.credentials.token}`, body: null,
        }]));
        expect(modalConfirmSpy).toHaveBeenCalledWith('sessionInfo.deleteSession', expect.any(String), expect.objectContaining({ destructive: true }));
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it('sends a confirmed archived Session Delete to its owning Machine', async () => {
        const SessionItem = await importSessionItem();
        const sessionId = 'sess_archived_native_delete';
        const serverIdentityId = 'srv_row_delete_home';
        const received = vi.fn();
        const boundary = await createExternalActionAccountHttpBoundary({
            serverUrl: 'https://server-native-delete.test', serverIdentityId, accountId: 'row-account',
            machineId: 'machine-row', actionId: 'session.delete', tokenEpoch: 0,
            execute(input, { target, invocation, requestHeaders }) {
                received(input, target, invocation.presentUserConfirmation, requestHeaders.get('authorization'));
                return { success: true };
            },
        });
        const screen = await renderScreen(<SessionItem
            session={createSessionFixture({ id: sessionId, active: false, activeAt: 0, presence: 0, archivedAt: 42 })}
            serverId="server_native_delete" selected={false} compact={false}
        />, { nativeDelete: { serverIdentityId, boundary } });

        await openRowMenu(screen, sessionId);
        await pressRowMenuAction(screen, SESSION_ACTION_DELETE_ID);
        await vi.waitFor(() => expect(received).toHaveBeenCalledWith(
            expect.objectContaining({ sessionId }),
            { kind: 'machine', machineId: 'machine-row' },
            expect.objectContaining({ actionId: 'session.delete' }),
            `Bearer ${account!.credentials.token}`,
        ));
        expect(modalConfirmSpy).toHaveBeenCalledTimes(1);
        expect(mutationRequests).toEqual([]);
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it.each(['document', 'account'] as const)('ART-CREATE-QUOTA explains the %s budget with ordered size and limit in the lifecycle alert message and retains the Session after native Delete fails', async budget => {
        const SessionItem = await importSessionItem();
        const sessionId = `sess_quota_${budget}`;
        const serverIdentityId = 'srv_row_delete_quota';
        const boundary = await createExternalActionAccountHttpBoundary({
            serverUrl: 'https://server-native-delete.test', serverIdentityId, accountId: 'row-account',
            machineId: 'machine-row', actionId: 'session.delete', tokenEpoch: 0,
            execute: () => null,
            failure: () => ({ errorCode: 'quota_exceeded', error: 'quota_exceeded',
                details: { budget, limitBytes: 1024, usedBytes: 2048 } }),
        });
        await renderScreen(<SessionItem
            session={createSessionFixture({ id: sessionId, active: false, activeAt: 0, presence: 0, archivedAt: 42 })}
            serverId="server_native_delete" selected={false} compact={false}
        />, { nativeDelete: { serverIdentityId, boundary } });
        // The current row's native menu fixture cannot expose Delete. Exercise the real shared
        // owner and HTTP boundary; header, row and Info display this exact HappyError.message.
        const { createSessionActionTarget } = await import('@/components/sessions/actions/sessionActionContext');
        const { executeSessionAction } = await import('@/components/sessions/actions/sessionActionExecution');
        const session = storage.getState().sessions[sessionId]!;
        const target = createSessionActionTarget({ session, serverId: account!.home.id, isConnected: false });
        expect(target.canDelete).toBe(true);
        const failure = await executeSessionAction({ actionId: SESSION_ACTION_DELETE_ID, target,
            context: { confirmed: true } }).then(() => null, error => error);
        expect(failure).toBeInstanceOf(HappyError);
        expect(failure.code).toBe('quota_exceeded');
        expect(failure.message).toContain(budget === 'document' ? 'Too large to save' : 'Artifact storage is full');
        expect(failure.message).toContain(budget === 'document' ? 'each artifact can hold up to' : 'versions included');
        expect(failure.message).toContain(budget === 'document'
            ? 'This would be 2.05 KB; each artifact can hold up to 1.02 KB.'
            : '2.05 KB of 1.02 KB used');
        expect(failure.message).not.toContain('Your edits are still here');
        if (budget === 'document') {
            const { describeArtifactQuota } = await import('@/components/artifacts/ArtifactQuotaNotice');
            expect(describeArtifactQuota({ budget, limitBytes: 1024, usedBytes: 2048 }).description)
                .toContain('Your edits are still here');
        }
        expect(storage.getState().sessions[sessionId]).toBeDefined();
        expect(mutationRequests).toEqual([]);
        expect(modalConfirmSpy).not.toHaveBeenCalled();
    });

    it('surfaces a Home delete conflict after confirmation', async () => {
        const SessionItem = await importSessionItem();
        const sessionId = 'sess_archived_changed';
        const screen = await renderScreen(<SessionItem
            session={createSessionFixture({ id: sessionId, active: false, activeAt: 0, presence: 0, archivedAt: 42, metadata: { path: '/repo', host: 'tester.local' } })}
            serverId="server_a" selected={false} compact={false}
        />, { machineBound: false });
        const error = 'Session delete condition was lost';
        deleteReplies.push(Response.json({ error }, { status: 409 }));

        await openRowMenu(screen, sessionId);
        await pressRowMenuAction(screen, SESSION_ACTION_DELETE_ID);
        await vi.waitFor(() => expect(modalAlertSpy).toHaveBeenCalledWith('common.error', error, expect.any(Array)));
        expect(mutationOrder).toEqual(['delete']);
        expect(storage.getState().sessions[sessionId]).toBeDefined();
    });

    it('accepts a Home response that the archived Session is already absent', async () => {
        const SessionItem = await importSessionItem();
        const sessionId = 'sess_archived_missing';
        const screen = await renderScreen(<SessionItem
            session={createSessionFixture({ id: sessionId, active: false, activeAt: 0, presence: 0, archivedAt: 42, metadata: { path: '/repo', host: 'tester.local' } })}
            serverId="server_a" selected={false} compact={false}
        />, { machineBound: false });
        deleteReplies.push(Response.json({ error: 'Session not found or not owned by user' }, { status: 404 }));

        await openRowMenu(screen, sessionId);
        await pressRowMenuAction(screen, SESSION_ACTION_DELETE_ID);
        await vi.waitFor(() => expect(mutationOrder).toEqual(['delete']));
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it('warns that an offline managed archived row keeps its machine folder', async () => {
        const SessionItem = await importSessionItem();
        const screen = await renderScreen(<SessionItem
            session={createSessionFixture({ id: 'sess_archived_managed', active: false, activeAt: 0, presence: 0, archivedAt: 42,
                metadata: { path: '/managed', host: 'tester.local', machineId: 'machine-row', sessionDirectoryV1: { v: 1, kind: 'managed' } } })}
            serverId="server_a" selected={false} compact={false}
        />, { machineOnline: false });
        modalConfirmSpy.mockResolvedValueOnce(false);
        await openRowMenu(screen, 'sess_archived_managed');
        await pressRowMenuAction(screen, SESSION_ACTION_DELETE_ID);
        await vi.waitFor(() => expect(modalConfirmSpy).toHaveBeenCalledWith('sessionInfo.deleteSession',
            expect.stringContaining('sessionDirectoryRecovery.offlineDelete'), expect.objectContaining({ destructive: true })));
        expect(mutationRequests.filter(request => request.method === 'DELETE')).toEqual([]);
    });

    it('keeps an archived session when the delete confirmation is declined', async () => {
        const SessionItem = await importSessionItem();
        const screen = await renderScreen(<SessionItem
            session={createSessionFixture({ id: 'sess_archived_cancel', active: false, activeAt: 0, presence: 0, archivedAt: 42 })}
            serverId="server_a" selected={false} compact={false}
        />);
        modalConfirmSpy.mockResolvedValueOnce(false);
        await openRowMenu(screen, 'sess_archived_cancel');
        await pressRowMenuAction(screen, SESSION_ACTION_DELETE_ID);
        await vi.waitFor(() => expect(modalConfirmSpy).toHaveBeenCalled());
        expect(mutationRequests.filter(request => request.method === 'DELETE')).toEqual([]);
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it('stops directly through the shared Action policy without a local confirmation', async () => {
        const SessionItem = await importSessionItem();
        const screen = await renderScreen(<SessionItem
            session={createSessionFixture({ id: 'sess_direct_stop', active: true })}
            serverId="server_a" serverName="Server A" showServerBadge={true}
            selected={false}
            compact={false}
        />);
        await openRowMenu(screen, 'sess_direct_stop');
        await pressRowMenuAction(screen, SESSION_ACTION_STOP_ID);
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
        metadataPatchRequests.length = 0;
        mutationOrder.length = 0;
        deleteReplies.length = 0;
        rejectFirstArchive = false;
        modalConfirmSpy.mockReset().mockResolvedValue(true);
        modalAlertSpy.mockClear();
        storage.setState({ sessions: {}, sessionListRowsByServerId: {}, machines: {}, machineListByServerId: {} });
    });
    afterEach(async () => {
        await standardCleanup();
        await account?.dispose();
        account = undefined;
        storage.setState(previousState, true);
        hideInactiveSessions = false;
    });

    it('archives active sessions from the swipe action using server scope when serverId is provided', async () => {
        rejectFirstArchive = true;
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
        await expectArchiveRequests('sess_1', 2);
        expect(mutationOrder).toEqual(['archive', 'stop', 'archive']);
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
        rejectFirstArchive = true;
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
        await expectArchiveRequests('sess_3', 2);
        expect(mutationOrder).toEqual(['archive', 'stop', 'archive']);
    });

    it('offers an archive action for active sessions in the more menu and stops before archiving', async () => {
        rejectFirstArchive = true;
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
                compact={false}
            />,
        );

        await openRowMenu(screen, 'sess_active_archive');
        await vi.waitFor(() => expect(screen.findHostByTestId(menuOptionTestId(SESSION_ACTION_STOP_ID))).toBeTruthy());
        await pressRowMenuAction(screen, SESSION_ACTION_ARCHIVE_ID);
        expect(modalConfirmSpy).not.toHaveBeenCalled();
        expect(modalAlertSpy).not.toHaveBeenCalled();

        await expectStopRequest('sess_active_archive');
        await expectArchiveRequests('sess_active_archive', 2);
        expect(mutationOrder).toEqual(['archive', 'stop', 'archive']);
    });

    it('archives pinned active sessions from the swipe action when hidden inactive sessions are enabled', async () => {
        rejectFirstArchive = true;
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
        await expectArchiveRequests('sess_4', 2);
        expect(mutationOrder).toEqual(['archive', 'stop', 'archive']);
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
                compact={false}
            />,
        );

        await openRowMenu(screen, 'sess_read');
        await pressRowMenuAction(screen, SESSION_ACTION_MARK_UNREAD_ID);
        await vi.waitFor(() => expect(mutationRequests).toHaveLength(1));
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
                compact={false}
            />,
        );

        await openRowMenu(screen, 'sess_raw_seq');
        await vi.waitFor(() => expect(screen.findHostByTestId(menuOptionTestId(SESSION_ACTION_RENAME_ID))).toBeTruthy());
        expect(screen.findHostByTestId(menuOptionTestId(SESSION_ACTION_MARK_READ_ID))).toBeNull();
        expect(screen.findHostByTestId(menuOptionTestId(SESSION_ACTION_MARK_UNREAD_ID))).toBeNull();
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
                compact={false}
                onMoveToFolder={onMoveToFolder}
                onMoveToWorkspaceRoot={onMoveToWorkspaceRoot}
                onMoveUp={onMoveUp}
                onMoveDown={onMoveDown}
            />,
        );

        await openRowMenu(screen, 'sess_accessible_move');
        await pressRowMenuAction(screen, SESSION_ACTION_MOVE_TO_FOLDER_ID);
        await vi.waitFor(() => expect(onMoveToFolder).toHaveBeenCalledTimes(1));

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
                compact={false}
            />,
        );

        await openRowMenu(screen, 'sess_archived_read');
        await vi.waitFor(() => expect(screen.findHostByTestId(menuOptionTestId(SESSION_ACTION_RENAME_ID))).toBeTruthy());
        expect(screen.findHostByTestId(menuOptionTestId(SESSION_ACTION_MARK_READ_ID))).toBeNull();
        expect(screen.findHostByTestId(menuOptionTestId(SESSION_ACTION_MARK_UNREAD_ID))).toBeNull();
    });
});
