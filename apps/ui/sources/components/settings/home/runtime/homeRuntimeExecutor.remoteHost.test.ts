import { afterEach, expect, it, vi } from 'vitest';
import * as React from 'react';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createManualSystemTaskRunner } from '@/dev/testkit/harness/manualSystemTaskRunner';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';
import { homeGovernanceProjectionFixture } from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { SessionListQueryResponseV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { RemoteHostRecordV1Schema, RemoteHostCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { AccountSettingsV2GetResponseSchema, AccountSettingsV2HistoryListResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import type { SystemTaskBridge } from '@/components/systemTasks/types';

const desktop = vi.hoisted(() => ({ bridge: null as SystemTaskBridge | null }));
// Replace the native OS transport, not the shared runner or its lifecycle facade.
vi.mock('@/components/systemTasks/createTauriSystemTaskBridge', () => ({ createTauriSystemTaskBridge: () => {
    if (!desktop.bridge) throw new Error('SSH Home native task boundary was not installed');
    return desktop.bridge;
} }));

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

// Native presentation boundaries use the same setup as neighboring Home suites;
// admission, catalog scope, credentials and task completion keep the real store.
installSettingsViewCommonModuleMocks({
    storage: 'real',
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        // Each case can hold the person's native review at the presentation boundary.
        return createModalModuleMock({ confirmResult: true }).module;
    },
});
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
vi.stubEnv('EXPO_PUBLIC_SYSTEM_TASKS_RUNNER_MODE', 'tauri');
const nativeTasks = createManualSystemTaskRunner();
desktop.bridge = nativeTasks.bridge;
await loadSyncSingletonForTests();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;

const loadModules = async () => {
    const runtime = await import('@/components/systemTasks/systemTasksRuntime');
    const catalog = await import('@/sync/store/settings/remoteHostCatalogSnapshot');
    const executor = await import('./homeRuntimeExecutor');
    await import('@/sync/ops/actions/defaultActionExecutor');
    await import('@/components/approvals/ActionConfirmationReview');
    const sections = await import('./HomeRuntimeSections');
    return { runtime, catalog, executor, sections };
};
const modules = await loadModules();
const { Modal } = await import('@/modal');

afterEach(async () => {
    await standardCleanup();
    for (const { taskId } of modules.runtime.getSystemTasksRunner().listActiveTasks!()) {
        nativeTasks.emitResult(taskId, { protocolVersion: 1, taskId, ok: false,
            error: { code: 'test_fixture_ended', message: 'Native test fixture ended' } });
    }
    await connection?.dispose();
    connection = null;
    modules.catalog.resetRemoteHostCatalogSnapshotsForTests();
    await home.reset();
});

async function prepareHome() {
    vi.mocked(Modal.confirm).mockReset().mockResolvedValue(true);
    vi.mocked(Modal.show).mockClear();
    const { runtime, catalog: { applyRemoteHostCatalogSnapshot }, executor: { restartHomeRuntime } } = modules;
    const serverId = await home.addHome({ name: 'SSH Home', serverUrl: 'https://ssh-home.test', accountId: 'account', currentAccount: true });
    const scope = { serverId, accountId: 'account' };
    const host = RemoteHostRecordV1Schema.parse({ id: 'home-host', name: 'Home host', createdAt: 1, updatedAt: 2, lastUsedAt: null,
        linkedRelayProfileId: serverId, linkedMachineId: null,
        ssh: { target: 'dev@private.example', authMode: 'agent' } });
    const catalog = { status: 'ready' as const, revision: 4, hosts: [host], diagnostics: [] };
    home.answer(serverId, '/v1/account/entity-rows/remote-hosts', { body: RemoteHostCatalogRowReadResponseV1Schema.parse({ status: 'present', revision: 4,
        content: { t: 'plain', v: { v: 1, hosts: [host] } } }) });
    home.answer(serverId, '/v2/account/settings', { body: AccountSettingsV2GetResponseSchema.parse({ version: 4, content: { t: 'plain', v: {} } }) });
    home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 4 }) });
    home.answer(serverId, '/v2/account/settings/history', { body: AccountSettingsV2HistoryListResponseSchema.parse({ snapshots: [] }) });
    home.answer(serverId, '/v1/account/entity-rows/profiles/transfer', { body: { status: 'absent' } });
    const emptySessions = SessionListQueryResponseV1Schema.parse({
        sessions: [], nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
    });
    home.answer(serverId, '/v2/sessions', { body: emptySessions });
    home.answer(serverId, '/v2/sessions/query', { body: emptySessions });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = await TokenStorage.getCredentialsForServerUrl('https://ssh-home.test', { serverId });
    if (!credentials) throw new Error('SSH Home credentials were not stored');
    connection = await restoreServerAccountForTest({ serverUrl: 'https://ssh-home.test', accountId: 'account', credentials, request: home.request });
    // The Account's Action policy is the applied store plus its Home answer; the harness owns seeding both.
    await home.requireUiApproval(serverId, 'remote_hosts.relay.restart');
    applyRemoteHostCatalogSnapshot(scope, catalog, true);
    nativeTasks.bridge.start.mockClear();
    const manual = { ...nativeTasks, runner: runtime.getSystemTasksRunner() };
    return { serverId, scope, host, manual, restartHomeRuntime };
}

it.each([true, false, 'reject', 'cancel', 'observation_failed'] as const)('joins the native SSH review and real task lifecycle before accepting runtime health (%s)', async (healthy) => {
    const { serverId, scope, host, manual, restartHomeRuntime } = await prepareHome();
    let settled = false;
    let observed: Awaited<ReturnType<typeof restartHomeRuntime>> | undefined;
    let answer: ((confirmed: boolean) => void) | undefined;
    vi.mocked(Modal.confirm).mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    const controller = new AbortController();
    const onApprovalPending = vi.fn();
    const restarting = restartHomeRuntime({ kind: 'remote_host', host, hostName: host.name, scope, catalogRevision: 4 },
        { serverId, secretMaterialAllowed: false, onApprovalPending, signal: controller.signal })
        .then(outcome => { settled = true; observed = outcome; return outcome; });
    await waitForHomeGovernance(() => expect(answer).toBeTypeOf('function'));
    expect(observed).toBeUndefined();
    expect(Modal.confirm).toHaveBeenCalledOnce();
    expect(manual.runner.listActiveTasks!()).toHaveLength(0);
    expect(home.artifacts(serverId).list()).toEqual([]);
    expect(onApprovalPending).not.toHaveBeenCalled();
    const denied = healthy === 'reject' || healthy === 'cancel';
    if (healthy === 'cancel') controller.abort();
    else answer!(!denied);
    if (denied) {
        await expect(restarting).resolves.toMatchObject({ kind: 'cancelled' });
        expect(manual.runner.listActiveTasks!()).toHaveLength(0);
        expect(manual.bridge.start).not.toHaveBeenCalled();
        return;
    }
    await waitForHomeGovernance(() => expect(manual.runner.listActiveTasks!()).toHaveLength(1));
    const taskId = manual.runner.listActiveTasks!()[0].taskId;
    expect(manual.bridge.start.mock.calls[0][0].params).toMatchObject({ action: 'relayRuntime.restart', ssh: { target: host.ssh.target, auth: 'agent' } });
    expect(settled).toBe(false);
    const result = { protocolVersion: 1 as const, taskId, ok: true as const, data: { action: 'relayRuntime.restart' } };
    manual.emitResult(taskId, result);
    await waitForHomeGovernance(() => expect(manual.bridge.start).toHaveBeenCalledTimes(2));
    const statusTaskId = manual.runner.listActiveTasks!().find(task => task.taskId !== taskId)!.taskId;
    expect(manual.bridge.start.mock.calls[1][0].params).toMatchObject({ action: 'relayRuntime.status' });
    expect(settled).toBe(false);
    const runtimeStatusResult = healthy === 'observation_failed'
        ? { protocolVersion: 1 as const, taskId: statusTaskId, ok: false as const, error: { code: 'status_failed', message: 'Cannot observe runtime' } }
        : { protocolVersion: 1 as const, taskId: statusTaskId, ok: true as const,
        data: { action: 'relayRuntime.status', relayRuntime: { installed: true, version: '0.3', relayUrl: 'https://ssh-home.test', healthy,
            service: { active: true, enabled: true } } } };
    manual.emitResult(statusTaskId, runtimeStatusResult);
    await expect(restarting).resolves.toMatchObject({ kind: healthy === 'observation_failed' ? 'outcome_unknown' : healthy ? 'restarted' : 'failed', taskId, result, runtimeStatusResult });
});

it('explains the refused remote restart before starting an SSH task', async () => {
    const { serverId, scope, host, manual, restartHomeRuntime } = await prepareHome();
    await home.setActionPolicy(serverId, 'remote_hosts.relay.restart', 'ui', 'off');
    const { t } = await import('@/text');
    await expect(restartHomeRuntime({ kind: 'remote_host', host, hostName: host.name, scope, catalogRevision: 4 },
        { serverId, secretMaterialAllowed: false, onApprovalPending: vi.fn() }))
        .resolves.toMatchObject({ kind: 'failed', message: t('actionConfirmations.turnedOffUnnamedMessage') });
    expect(manual.bridge.start).not.toHaveBeenCalled();
    expect(Modal.confirm).not.toHaveBeenCalled();
});

it.each([
    { surface: 'banner', decision: 'reject' },
    { surface: 'runtime', decision: 'cancel' },
] as const)('the $surface releases a $decision review without reporting failed restart or reloading', async ({ surface }) => {
    const { serverId, scope, host, manual } = await prepareHome();
    const { HomeRestartNowBanner, HomeRuntimeSection } = modules.sections;
    let answer: ((confirmed: boolean) => void) | undefined;
    vi.mocked(Modal.confirm).mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    const refresh = vi.fn();
    const onRestarted = vi.fn();
    const context = { scope, homeName: 'SSH Home', projection: homeGovernanceProjectionFixture(), mutationsAvailable: true,
        approvalPending: false, refresh, requestApproval: vi.fn() };
    const executor = { kind: 'remote_host' as const, host, hostName: host.name, scope, catalogRevision: 4 };
    const screen = await renderScreen(surface === 'banner'
        ? React.createElement(HomeRestartNowBanner, { context, executor, pendingCount: 1, onRestarted })
        : React.createElement(HomeRuntimeSection, { context, executor, release: { version: '0.3', flavor: 'light' }, onRestarted }));
    const restartTestId = surface === 'banner' ? 'home-runtime-pending-restart.action' : 'home-runtime-restart';
    const { act } = await import('react-test-renderer');
    await act(async () => { await screen.tree.pressByTestIdAsync(restartTestId); });
    await waitForHomeGovernance(() => expect(answer).toBeTypeOf('function'));
    expect(screen.tree.findByTestId(restartTestId)?.props.accessibilityState.disabled).toBe(true);
    await screen.tree.pressByTestIdAsync(restartTestId);
    expect(Modal.confirm).toHaveBeenCalledOnce();
    expect(manual.runner.listActiveTasks!()).toHaveLength(0);
    expect(home.artifacts(serverId).list()).toEqual([]);
    expect(context.requestApproval).not.toHaveBeenCalled();
    await act(async () => answer!(false));
    await waitForHomeGovernance(() => expect(screen.tree.findByTestId(restartTestId)?.props.accessibilityState.disabled).toBe(false));
    expect(manual.runner.listActiveTasks!()).toHaveLength(0);
    expect(Modal.alertAsync).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(onRestarted).not.toHaveBeenCalled();
});
