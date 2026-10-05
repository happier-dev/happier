import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { act } from 'react-test-renderer';
import { createManualSystemTaskRunner } from '@/dev/testkit/harness/manualSystemTaskRunner';
import { useThisComputerSetupTask } from './useThisComputerSetupTask';
import { useLocalDaemonControl } from '@/components/settings/machines/localControl/useLocalDaemonControl';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { readLocalDaemonSharedState } from '@/components/settings/machines/localControl/localDaemonSharedState';
import type { IModal } from '@/modal';

const modalSpies = vi.hoisted(() => ({ confirm: vi.fn(async () => true), alertAsync: vi.fn(async (
    ...args: Parameters<IModal['alertAsync']>
) => { args[2]?.at(-1)?.onPress?.(); }) }));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: modalSpies }).module;
});
afterEach(() => { standardCleanup(); vi.clearAllMocks(); });

import { resolveThisComputerSetupFollowUp } from './useThisComputerSetupTask';

it('clears rejected admission without retaining a phantom task and permits an explicit retry', async () => {
    const manual = createManualSystemTaskRunner();
    const approval = { expectedRelayUrl: 'https://rejected-admission.example', serverId: 'rejected-home', expectedAccountId: 'owner-a' };
    const mounted = await renderHook(() => useThisComputerSetupTask({ runner: manual.runner, authRequestApproval: approval }));
    const spec = { protocolVersion: 1 as const, kind: 'setup.thisComputer.v1' as const, params: {
        activeRelayUrl: approval.expectedRelayUrl, activeServerIdentityId: approval.serverId, activeAccountId: approval.expectedAccountId,
    } };
    manual.bridge.start.mockRejectedValueOnce(new Error('Native admission failed'));
    await act(async () => { await expect(mounted.getCurrent().start(spec)).rejects.toThrow('Native admission failed'); });
    expect(mounted.getCurrent()).toMatchObject({ activeTaskId: null, isStarting: false, startError: 'Native admission failed' });
    expect(manual.runner.getActiveSetupTask()).toBeNull();
    expect(readLocalDaemonSharedState(manual.runner).setup.taskId).toBeNull();
    let taskId = '';
    await act(async () => { taskId = await mounted.getCurrent().start(spec); });
    expect(mounted.getCurrent().startError).toBeNull();
    expect(mounted.getCurrent().activeTaskId).toBe(taskId);
    await act(async () => { manual.emitResult(taskId, { protocolVersion: 1, taskId, ok: false,
        error: { code: 'cancelled', message: 'Stopped' } }); });
});

it('refuses a pending borrowed setup for a controlled consumer that cancels its own run on leave', async () => {
    const manual = createManualSystemTaskRunner();
    let finishStart!: (taskId: string) => void;
    manual.bridge.start.mockImplementationOnce(() => new Promise<string>((resolve) => { finishStart = resolve; }));
    const spec = { protocolVersion: 1 as const, kind: 'setup.thisComputer.v1' as const, params: {
        activeRelayUrl: 'https://exclusive-setup.example', activeServerIdentityId: 'exclusive-home', activeAccountId: 'exclusive-account',
    } };
    const original = manual.runner.start(spec);
    const onTaskIdChange = vi.fn();
    const controlled = await renderHook(() => useThisComputerSetupTask({ runner: manual.runner,
        taskId: null, onTaskIdChange, adoptExisting: false,
    }));
    let attempted!: Promise<string>;
    await act(async () => {
        attempted = controlled.getCurrent().start(spec);
        // Attach before the expected refusal can settle, then release the original native launch.
        void attempted.catch(() => {});
        finishStart('original-home-setup');
        await original;
    });
    await expect(attempted).rejects.toMatchObject({ code: 'system_task_setup_in_progress' });
    expect(onTaskIdChange).not.toHaveBeenCalled();
    expect(controlled.getCurrent().activeTaskId).toBeNull();
    await controlled.unmount();
    expect(manual.runner.getActiveSetupTask()?.taskId).toBe('original-home-setup');
    expect(manual.bridge.start).toHaveBeenCalledTimes(1);
    expect(manual.bridge.cancel).not.toHaveBeenCalled();
});

it.each([false, true])('Settings adopts a Home/checklist setup, including pending native start (%s)', async (delayed) => {
    const home = await upsertAndActivateServer({ serverUrl: `https://cross-entry-${delayed}.example`, name: 'Home' });
    const manual = createManualSystemTaskRunner();
    const approval = { expectedRelayUrl: home.serverUrl, serverId: home.id };
    const generic = await renderHook(() => useThisComputerSetupTask({ runner: manual.runner, authRequestApproval: approval }));
    let finishStart!: (taskId: string) => void;
    if (delayed) manual.bridge.start.mockImplementationOnce(() => new Promise<string>((resolve) => { finishStart = resolve; }));
    let starting!: Promise<string>;
    await act(async () => {
        starting = generic.getCurrent().start({ protocolVersion: 1, kind: 'setup.thisComputer.v1', params: {
            activeRelayUrl: home.serverUrl, activeAccountId: null,
        } });
        if (!delayed) await starting;
    });
    await generic.unmount();
    const settings = await renderHook(() => useLocalDaemonControl({ runner: manual.runner }));
    expect(settings.getCurrent().isBusy).toBe(true);
    expect(settings.getCurrent().canRepair).toBe(false);
    let repair!: Promise<string | null>;
    await act(async () => { repair = settings.getCurrent().repairBackgroundService(); });
    expect(manual.bridge.start.mock.calls.filter(([spec]) => spec.kind.startsWith('setup.'))).toHaveLength(1);
    let taskId = '';
    await act(async () => {
        if (delayed) finishStart('delayed-generic-setup');
        taskId = await starting;
        expect(await repair).toBe(taskId);
    });
    expect(settings.getCurrent().activeTaskSnapshot?.taskId).toBe(taskId);
    await settings.unmount();
    manual.emitEvent(taskId, { type: 'prompt', message: 'Choose command line', data: {
        kind: 'setup.cliChoice', command: '/usr/local/bin/happier', version: '0.3.1', origin: 'npm',
        removalCommand: null, updateCommand: null, belowSetupFloor: false, missing: false, keepBlockedBy: null,
    } });
    await flushHookEffects();
    expect(manual.bridge.respond).toHaveBeenCalledWith(taskId, { choice: 'managed' });
    const returned = await renderHook(() => useLocalDaemonControl({ runner: manual.runner }));
    expect(returned.getCurrent().activeTaskSnapshot?.taskId).toBe(taskId);
    await act(async () => {
        returned.getCurrent().cancel();
        manual.emitResult(taskId, { protocolVersion: 1, taskId, ok: false, error: { code: 'cancelled', message: 'Stopped' } });
        await flushHookEffects();
    });
    expect(manual.bridge.cancel).toHaveBeenCalledWith(taskId);
    expect(returned.getCurrent().isBusy).toBe(false);
    await returned.unmount();
    const settled = await renderHook(() => useLocalDaemonControl({ runner: manual.runner }));
    expect(settled.getCurrent().lastErrorMessage).toBe('Stopped');
    expect(settled.getCurrent().isBusy).toBe(false);
});

it('answers a later service prompt after delayed launch and navigation, and adopts the same scoped run on return', async () => {
    let finishStart!: (taskId: string) => void;
    const manual = createManualSystemTaskRunner();
    const { runner } = manual;
    manual.bridge.start.mockImplementation(() => new Promise<string>((resolve) => { finishStart = resolve; }));
    const approval = { expectedRelayUrl: 'https://retained-setup.example', serverId: 'home-a', expectedAccountId: 'owner-a' };
    const mounted = await renderHook(() => useThisComputerSetupTask({ runner, authRequestApproval: approval }));
    let starting!: Promise<string>;
    await act(async () => { starting = mounted.getCurrent().start({ protocolVersion: 1, kind: 'setup.thisComputer.v1', params: {
        activeRelayUrl: approval.expectedRelayUrl, activeServerIdentityId: approval.serverId, activeAccountId: approval.expectedAccountId,
    } }); });
    await mounted.unmount();
    finishStart('retained-task');
    await starting;
    manual.emitEvent('retained-task', { type: 'progress', message: 'Downloading command line' });
    manual.emitEvent('retained-task', { type: 'prompt', message: 'Switch channel?', data: {
        kind: 'releaseChannel.switchDefaultForSetup', targetServerUrl: approval.expectedRelayUrl,
        currentDefaultReleaseChannel: 'stable', targetReleaseChannel: 'preview', managedReleaseChannels: [],
    } });
    await flushHookEffects();
    expect(manual.bridge.respond).toHaveBeenCalledWith('retained-task', { switchDefaultReleaseChannel: true });
    const returned = await renderHook((currentApproval) => useThisComputerSetupTask({ runner, authRequestApproval: currentApproval }), {
        initialProps: approval,
    });
    expect(returned.getCurrent().activeTaskId).toBe('retained-task');
    expect(returned.getCurrent().activeTaskSnapshot?.latestMessage).toBe('Switch channel?');
    await returned.rerender({ ...approval, expectedAccountId: 'owner-b' });
    expect(returned.getCurrent().activeTaskId).toBeNull();
    await returned.rerender(approval);
    expect(returned.getCurrent().activeTaskId).toBe('retained-task');
    const otherHome = await renderHook(() => useThisComputerSetupTask({ runner, authRequestApproval: {
        expectedRelayUrl: 'https://different.example', serverId: 'home-b',
    } }));
    expect(otherHome.getCurrent().activeTaskId).toBeNull();
    const otherAccount = await renderHook(() => useThisComputerSetupTask({ runner, authRequestApproval: {
        ...approval, expectedAccountId: 'owner-b',
    } }));
    expect(otherAccount.getCurrent().activeTaskId).toBeNull();
    await act(async () => {
        returned.getCurrent().cancel();
        manual.emitResult('retained-task', { protocolVersion: 1, taskId: 'retained-task', ok: false, error: { code: 'cancelled', message: 'Stopped' } });
    });
    await flushHookEffects();
    expect(returned.getCurrent().activeTaskSnapshot?.status).toBe('canceled');
    expect(runner.listPromptContinuations?.()).toEqual([]);
});

it('retains a URL-only enrollment for its unique saved Home and account, but refuses an ambiguous URL or another account', async () => {
    const profiles = await import('@/sync/domains/server/serverProfiles');
    const { resolveSavedServerProfileByUrl, upsertServerProfile } = profiles;
    const relayUrl = 'https://url-only-setup.example';
    const profile = await upsertServerProfile({ serverUrl: relayUrl });
    const manual = createManualSystemTaskRunner();
    const approval = { expectedRelayUrl: relayUrl, serverId: profile.id, expectedAccountId: 'owner-a' };
    const mounted = await renderHook(() => useThisComputerSetupTask({ runner: manual.runner, authRequestApproval: approval }));
    let taskId = '';
    await act(async () => { taskId = await mounted.getCurrent().start({ protocolVersion: 1, kind: 'setup.thisComputer.v1', params: {
        activeRelayUrl: relayUrl, activeAccountId: 'owner-a',
    } }); });
    expect(mounted.getCurrent().activeTaskId).toBe(taskId);
    await mounted.unmount();
    const reopened = await renderHook(() => useThisComputerSetupTask({ runner: manual.runner, authRequestApproval: approval }));
    expect(reopened.getCurrent().activeTaskId).toBe(taskId);
    const otherAccount = await renderHook(() => useThisComputerSetupTask({ runner: manual.runner, authRequestApproval: {
        ...approval, expectedAccountId: 'owner-b',
    } }));
    expect(otherAccount.getCurrent().activeTaskId).toBeNull();
    const { MMKV } = await import('react-native-mmkv');
    const { readStorageScopeFromEnv, scopedStorageId } = await import('@/utils/system/storageScope');
    const boundary = new MMKV({ id: scopedStorageId('server-profiles', readStorageScopeFromEnv()) });
    const previous = boundary.getString('server-state-v1');
    try {
        // Distinct primary endpoints can share a canonical alias; this is the
        // same ambiguity vector exercised by the canonical profile owner.
        boundary.set('server-state-v1', JSON.stringify({ servers: {
            [profile.id]: { ...profile, serverUrl: 'https://first-url-only-home.example', canonicalServerUrl: relayUrl,
                serverIdentityId: 'srv_url_only_home_a' },
            other: { ...profile, id: 'other', serverUrl: 'https://second-url-only-home.example', canonicalServerUrl: relayUrl,
                serverIdentityId: 'srv_url_only_home_b' },
        } }));
        profiles.resetServerProfilesRuntimeForTests();
        expect(resolveSavedServerProfileByUrl(relayUrl, { includeCanonicalServerUrl: true }).kind).toBe('ambiguous');
        const ambiguous = await renderHook(() => useThisComputerSetupTask({ runner: manual.runner, authRequestApproval: approval }));
        expect(ambiguous.getCurrent().activeTaskId).toBeNull();
        expect(manual.runner.getSnapshot(taskId)?.status).toBe('running');
    } finally {
        if (previous === undefined) boundary.delete('server-state-v1');
        else boundary.set('server-state-v1', previous);
        profiles.resetServerProfilesRuntimeForTests();
    }
});

describe('resolveThisComputerSetupFollowUp', () => {
    it('still routes unauthenticated failures to auth follow-up', () => {
        expect(resolveThisComputerSetupFollowUp({
            protocolVersion: 1,
            taskId: 'task-1',
            ok: false,
            error: {
                code: 'not_authenticated',
                message: 'sign in required',
            },
        })).toBe('auth');
    });

    it('does not route missing machine ids to a manual approval follow-up for local setup', () => {
        expect(resolveThisComputerSetupFollowUp({
            protocolVersion: 1,
            taskId: 'task-1',
            ok: false,
            error: {
                code: 'machine_id_unavailable',
                message: 'machine id missing',
            },
        })).toBeNull();
    });
});
