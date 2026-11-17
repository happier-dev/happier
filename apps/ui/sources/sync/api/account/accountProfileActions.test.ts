import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { storage } = await import('@/sync/domains/state/storageStore');
const { profileDefaults } = await import('@/sync/domains/profiles/profile');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { activateStorageAccountScope } = await import('@/dev/testkit/runtime/storageRuntime');
const { resetScopedHomeActionExecutorsForTests, scopedHomeActionExecutor } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
const { setAccountName } = await import('./apiAccountName');
const { setAccountUsername, releaseAccountUsername } = await import('./apiUsername');
const { useMountedActionExecution } = await import('@/components/approvals/useMountedActionExecution');
const { Modal } = await import('@/modal');
const credentials = { token: createAccountTokenForTests('self', { currentAccount: true }) };
let serverId: string;
let disposeScope: (() => void) | undefined;

beforeEach(async () => {
    vi.mocked(Modal.confirm).mockReset();
    vi.mocked(Modal.confirm).mockResolvedValue(false);
    resetScopedHomeActionExecutorsForTests();
    await homes.reset();
    await loadSyncSingletonForTests();
    serverId = await homes.addHome({ name: 'Profile Home', serverUrl: 'https://profile-actions.test', accountId: 'self', currentAccount: true });
    const active = await activateStorageAccountScope({ serverId: getActiveServerSnapshot().serverId, accountId: 'self' });
    disposeScope = () => active.dispose();
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    // The HTTP Home answers; the disconnected socket boundary must not model an unreachable endpoint.
    storage.setState({ endpointStatus: 'online' });
    storage.getState().applyProfile({ ...profileDefaults, id: 'self', timestamp: 1, name: 'Before', username: 'before' });
});
afterEach(async () => { standardCleanup(); disposeScope?.(); disposeScope = undefined; await homes.reset(); });

describe('self-profile UI Action admission and acknowledgements', () => {
    it('releases a username directly by default without a native confirmation or self-approval Artifact', async () => {
        const mounted = await renderHook(() => useMountedActionExecution(serverId));
        await waitForHomeGovernance(() => expect(mounted.getCurrent().ready).toBe(true));
        const result = { username: null, released: true, reservedUntilMs: 2_592_000_000 };
        homes.answer(serverId, 'POST /v1/account/username/release', { body: result });
        await expect(releaseAccountUsername(credentials, { execute: mounted.getCurrent().execute })).resolves.toEqual(result);
        expect(storage.getState().profile.username).toBeNull();
        expect(Modal.confirm).not.toHaveBeenCalled();
        expect(homes.requestsFor('/v1/artifacts')).toHaveLength(0);
    });

    it.each([
        { actionId: 'account.name.set' as const, decision: 'approve' as const },
        { actionId: 'account.name.set' as const, decision: 'reject' as const },
        { actionId: 'account.username.set' as const, decision: 'approve' as const },
        { actionId: 'account.username.set' as const, decision: 'reject' as const },
        { actionId: 'account.username.release' as const, decision: 'approve' as const },
        { actionId: 'account.username.release' as const, decision: 'reject' as const },
    ])('keeps the original $actionId save pending until $decision returns the typed result', async ({ actionId, decision }) => {
        await homes.requireUiApproval(serverId, actionId);
        let decide!: (value: boolean) => void;
        vi.mocked(Modal.confirm).mockImplementationOnce(() => new Promise<boolean>(resolve => { decide = resolve; }));
        const mounted = await renderHook(() => useMountedActionExecution(serverId));
        await waitForHomeGovernance(() => expect(mounted.getCurrent().ready).toBe(true));
        const response = actionId === 'account.name.set'
            ? { name: 'Acknowledged', firstName: 'Acknowledged', lastName: null, timestamp: 2 }
            : actionId === 'account.username.release' ? { username: null, released: true, reservedUntilMs: 2_592_000_000 }
                : { username: 'acknowledged' };
        const path = actionId === 'account.name.set' ? '/v1/account/profile'
            : actionId === 'account.username.release' ? '/v1/account/username/release' : '/v1/account/username';
        homes.answer(serverId, `POST ${path}`, { body: response });
        let settled = false;
        let save: Promise<unknown>;
        await act(async () => {
            const options = { execute: mounted.getCurrent().execute };
            save = actionId === 'account.name.set' ? setAccountName(credentials, 'Requested', options)
                : actionId === 'account.username.release' ? releaseAccountUsername(credentials, options)
                    : setAccountUsername(credentials, 'requested', options);
            void save.then(() => { settled = true; }, () => { settled = true; });
            await waitForHomeGovernance(() => expect(Modal.confirm).toHaveBeenCalledOnce());
        });
        expect(settled).toBe(false);
        expect(mounted.getCurrent().approval.approvalPending).toBe(false);
        expect(homes.requestsFor(path)).toHaveLength(0);
        expect(storage.getState().profile).toMatchObject({ name: 'Before', username: 'before' });
        expect(homes.requestsFor('/v1/artifacts')).toHaveLength(0);
        await act(async () => { decide(decision === 'approve'); });
        if (decision === 'approve') {
            await expect(save!).resolves.toEqual(response);
            expect(storage.getState().profile).toMatchObject(actionId === 'account.name.set' ? { name: 'Acknowledged' }
                : { username: actionId === 'account.username.release' ? null : 'acknowledged' });
        } else {
            await expect(save!).rejects.toMatchObject({ code: 'approval_canceled', canTryAgain: false });
            expect(homes.requestsFor(path)).toHaveLength(0);
            expect(storage.getState().profile).toMatchObject({ name: 'Before', username: 'before' });
        }
    });

    it.each(['account.username.set', 'account.username.release'] as const)('retires pending %s when its Account leaves, without publishing another Account’s acknowledgement', async (actionId) => {
        await homes.requireUiApproval(serverId, actionId);
        let decide!: (value: boolean) => void;
        vi.mocked(Modal.confirm).mockImplementationOnce(() => new Promise<boolean>(resolve => { decide = resolve; }));
        const mounted = await renderHook(() => useMountedActionExecution(serverId));
        await waitForHomeGovernance(() => expect(mounted.getCurrent().ready).toBe(true));
        let save: Promise<unknown>;
        await act(async () => {
            const execution = { execute: mounted.getCurrent().execute };
            save = actionId === 'account.username.release' ? releaseAccountUsername(credentials, execution)
                : setAccountUsername(credentials, 'requested', execution);
            void save.catch(() => {});
            await waitForHomeGovernance(() => expect(Modal.confirm).toHaveBeenCalledOnce());
        });
        expect(mounted.getCurrent().approval.approvalPending).toBe(false);
        await act(async () => {
            homes.answer(serverId, 'GET /v1/account/profile', {
                body: { ...profileDefaults, id: 'successor', username: 'successor' },
            });
            await homes.switchAccount(serverId, 'successor');
            storage.getState().activateProfileScope({ serverId, accountId: 'successor' });
            storage.getState().applyProfile({ ...profileDefaults, id: 'successor', username: 'successor' });
            decide(true);
        });
        await expect(save!).rejects.toMatchObject({ name: 'HappyError', canTryAgain: false });
        expect(storage.getState().profile).toMatchObject({ id: 'successor', username: 'successor' });
        expect(homes.requestsFor(actionId === 'account.username.release' ? '/v1/account/username/release' : '/v1/account/username')).toHaveLength(0);
    });

    it.each(['account.name.set', 'account.username.set'] as const)('honors required UI approval for %s without applying or issuing the mutation', async (actionId) => {
        const path = actionId === 'account.name.set' ? '/v1/account/profile' : '/v1/account/username';
        homes.answer(serverId, `POST ${path}`, { body: actionId === 'account.name.set'
            ? { name: 'After', firstName: 'After', lastName: null, timestamp: 2 } : { username: 'after' } });
        await homes.requireUiApproval(serverId, actionId);
        const save = actionId === 'account.name.set' ? setAccountName(credentials, 'After') : setAccountUsername(credentials, 'after');
        await expect(save).rejects.toMatchObject({ code: 'approval_canceled', canTryAgain: false });
        expect(Modal.confirm).toHaveBeenCalledOnce();
        expect(homes.requestsFor('/v1/artifacts')).toHaveLength(0);
        expect(homes.requestsFor(path)).toHaveLength(0);
        expect(storage.getState().profile).toMatchObject({ name: 'Before', username: 'before' });
    });

    it('keeps an issued name acknowledgement after its view unmounts without changing the captured Account', async () => {
        let issued = false;
        let acknowledge!: () => void;
        const acknowledgement = new Promise<void>(resolve => { acknowledge = resolve; });
        const response = { name: 'Acknowledged', firstName: 'Acknowledged', lastName: null, timestamp: 2 };
        homes.answer(serverId, 'POST /v1/account/profile', { select: async () => {
            issued = true;
            await acknowledgement;
            return { body: response };
        } });
        const mounted = await renderHook(() => useMountedActionExecution(serverId));
        await waitForHomeGovernance(() => expect(mounted.getCurrent().ready).toBe(true));
        const save = setAccountName(credentials, 'Requested', { execute: mounted.getCurrent().execute });
        void save.catch(() => {});
        try {
            await waitForHomeGovernance(() => expect(issued).toBe(true));
            await mounted.unmount();
        } finally { acknowledge(); }
        await expect(save).resolves.toEqual(response);
        expect(homes.requestsFor('/v1/account/profile')).toHaveLength(1);
        expect(storage.getState().profile).toMatchObject({ id: 'self', name: 'Acknowledged', username: 'before' });
    });

    it('merges the acknowledged username into the current profile without losing a concurrently acknowledged name', async () => {
        homes.answer(serverId, 'POST /v1/account/username', { select: () => {
            storage.getState().applyProfile({ ...storage.getState().profile, name: 'Concurrent Name' });
            return { body: { username: 'normalized' } };
        } });
        await expect(setAccountUsername(credentials, 'Requested')).resolves.toEqual({ username: 'normalized' });
        expect(storage.getState().profile).toMatchObject({ name: 'Concurrent Name', username: 'normalized' });
    });

    it('rejects a late username acknowledgement after another Account takes over the Home', async () => {
        homes.answer(serverId, 'POST /v1/account/username', { select: () => {
            storage.getState().activateProfileScope({ ...storage.getState().profileScope!, accountId: 'successor' });
            storage.getState().applyProfile({ ...profileDefaults, id: 'successor', username: 'successor' });
            return { body: { username: 'self-new' } };
        } });
        await expect(setAccountUsername(credentials, 'self-new')).rejects.toMatchObject({ name: 'HappyError', canTryAgain: false });
        expect(storage.getState().profile).toMatchObject({ id: 'successor', username: 'successor' });
    });

    it('does not automatically repeat a username write whose dispatched outcome is unknown', async () => {
        homes.answer(serverId, 'POST /v1/account/username', { dispatchThenFail: true });
        await expect(setAccountUsername(credentials, 'requested')).rejects.toMatchObject({ code: 'outcome_unknown', canTryAgain: false });
        expect(homes.requestsFor('/v1/account/username')).toHaveLength(1);
        expect(storage.getState().profile.username).toBe('before');
    });

    it('reads its own safe identity through the scoped executor without a Home administration capability', async () => {
        homes.answer(serverId, 'GET /v1/account/profile', { body: { id: 'self', timestamp: 2, firstName: 'Legacy', lastName: 'Name', username: 'before', avatar: null,
            connectedServices: ['never returned'], futurePrivateField: 'never returned' } });
        expect(await scopedHomeActionExecutor({ serverId, accountId: 'self' })('account.profile.get', {}, {
            surface: 'ui', serverId, expectedAccountId: 'self',
        })).toEqual({ ok: true, result: { id: 'self', timestamp: 2, name: 'Legacy Name', firstName: 'Legacy', lastName: 'Name', username: 'before', avatar: null } });
    });
});
