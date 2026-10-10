import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { homeGovernanceProjectionFixture } from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import { collectRenderedTestIds } from '@/dev/testkit/render/collectRenderedTestIds';
import { renderScreen } from '@/dev/testkit/render/renderScreen';

import type { HomeAdministrationContext } from '@/components/settings/home/governance/homeAdministrationContext';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { SystemTaskResult } from '@happier-dev/protocol';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import type { HomeRuntimeExecutor } from './resolveHomeRuntimeExecutor';
import type { SystemTaskBridgeListenerSet } from '@/components/systemTasks/types';
import { act } from 'react-test-renderer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const machineRpc = vi.hoisted(() => vi.fn<(input: { method: string; payload: unknown }) => Promise<unknown>>());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpc }));
const desktop = vi.hoisted(() => ({ nextId: 0, listeners: new Map<string, SystemTaskBridgeListenerSet>() }));
// Native transport is the boundary; Action admission and the real task runner remain live.
vi.mock('@/components/systemTasks/createTauriSystemTaskBridge', () => ({ createTauriSystemTaskBridge: () => ({
    async start() { return `restart-${++desktop.nextId}`; },
    async subscribe(taskId: string, listeners: SystemTaskBridgeListenerSet) {
        desktop.listeners.set(taskId, listeners);
        return () => { desktop.listeners.delete(taskId); };
    },
    async cancel() {},
    async respond() {},
}) }));

installSettingsViewCommonModuleMocks({
    storage: 'real',
    router: async () => ({
        useRouter: () => ({ push: vi.fn(), back: vi.fn(), setParams: vi.fn() }),
        useNavigation: () => ({ setOptions: vi.fn() }),
        useLocalSearchParams: () => ({}),
    }),
});
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
vi.stubEnv('EXPO_PUBLIC_SYSTEM_TASKS_RUNNER_MODE', 'tauri');
vi.stubGlobal('isTauri', true);
const { HomePendingRestartAttentionRow, HomeRestartNowBanner, HomeRuntimeSection } = await import('./HomeRuntimeSections');
const { Modal } = await import('@/modal');
const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
const { getDefaultSystemTaskRunner } = await import('@/components/systemTasks');
let scope = { serverId: '', accountId: 'account-1' };
beforeEach(async () => {
    await home.reset();
    machineRpc.mockReset();
    vi.mocked(Modal.alertAsync).mockClear();
    desktop.listeners.clear();
    expect(getDefaultSystemTaskRunner().mode).toBe('tauri');
    const serverId = await home.addHome({ name: 'Home A', serverUrl: 'https://restart-banner.test', accountId: scope.accountId });
    scope = { serverId, accountId: scope.accountId };
    // These cases isolate lifecycle, not confirmation; use the user's real stored Action policy.
    home.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
        actionsSettingsV1: { v: 1, approvalWaivedSurfaces: {
            'relay.runtime.restart': ['ui'], 'home.runtime.restart': ['ui'],
        } },
    } }, version: 1 } });
});

async function admittedDesktopTask() {
    await waitForHomeGovernance(() => expect(desktop.listeners.size).toBeGreaterThan(0));
    const taskId = [...desktop.listeners.keys()][0];
    if (!taskId) throw new Error('Restart task was not admitted');
    return taskId;
}

function context(overrides?: Partial<HomeAdministrationContext>): HomeAdministrationContext {
    return {
        scope,
        homeName: 'Home A',
        projection: homeGovernanceProjectionFixture(),
        mutationsAvailable: true,
        approvalPending: false,
        refresh: () => {},
        requestApproval: vi.fn(),
        ...overrides,
    };
}

async function renderBanner(executor: HomeRuntimeExecutor, pendingCount: number) {
    const screen = await renderScreen(
        <HomeRestartNowBanner
            context={context()}
            executor={executor}
            pendingCount={pendingCount}
            discard={{ onPress: () => {}, loading: false }}
        />,
    );
    return collectRenderedTestIds(screen.tree.toJSON());
}

afterEach(async () => {
    standardCleanup();
    await home.reset();
});

describe('HomeRestartNowBanner', () => {
    it('keeps Restart now busy and reloads only after the task reports a healthy runtime', async () => {
        const onRestarted = vi.fn();
        const refresh = vi.fn();
        const screen = await renderScreen(<HomeRestartNowBanner context={context({ refresh })} executor={{ kind: 'hosting_desktop' }} pendingCount={1} onRestarted={onRestarted} />);
        await screen.tree.pressByTestIdAsync('home-runtime-pending-restart.action');
        expect(Modal.alertAsync).not.toHaveBeenCalled();
        const taskId = await admittedDesktopTask();
        expect(onRestarted).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
        expect(screen.tree.findByType(RoundButton).props.loading).toBe(true);
        await act(async () => desktop.listeners.get(taskId)!.onResult({ protocolVersion: 1, taskId, ok: true, data: { healthy: true } }));
        expect(onRestarted).toHaveBeenCalledOnce();
        expect(refresh).toHaveBeenCalledOnce();
        expect(screen.tree.findByType(RoundButton).props.loading).toBe(false);
    });

    it.each(['failed', 'unhealthy'] as const)('shows a terminal %s restart without reloading settings', async (failure) => {
        const onRestarted = vi.fn();
        const refresh = vi.fn();
        const screen = await renderScreen(<HomeRestartNowBanner context={context({ refresh })} executor={{ kind: 'hosting_desktop' }} pendingCount={1} onRestarted={onRestarted} />);
        await screen.tree.pressByTestIdAsync('home-runtime-pending-restart.action');
        expect(Modal.alertAsync).not.toHaveBeenCalled();
        const taskId = await admittedDesktopTask();
        await act(async () => desktop.listeners.get(taskId)!.onResult(failure === 'failed'
            ? { protocolVersion: 1, taskId, ok: false, error: { code: 'restart_failed', message: 'Runtime could not start' } }
            : { protocolVersion: 1, taskId, ok: true, data: { healthy: false } }));
        expect(onRestarted).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
        expect(Modal.alertAsync).toHaveBeenCalledWith('homeGovernance.runtime.restartFailed', failure === 'failed' ? 'Runtime could not start' : 'errors.operationFailed');
        expect(screen.tree.findByType(RoundButton).props.loading).toBe(false);
    });

    it.each([true, false])('standalone Runtime restart refreshes both projections only after a healthy result (%s)', async (healthy) => {
        let complete!: (result: SystemTaskResult) => void;
        const terminal = new Promise<SystemTaskResult>(resolve => { complete = resolve; });
        machineRpc.mockImplementation(async ({ method, payload }) => {
            if (method === RPC_METHODS.CAPABILITIES_DETECT) return { protocolVersion: 1, results: {
                'tool.systemTasks': { ok: true, checkedAt: 1, data: { available: true, kinds: ['relay.runtime.restart.v1'], methods: ['start', 'wait'] } },
            } };
            const request = payload as { method: string };
            return { ok: true, result: request.method === 'start' ? { taskId: 'restart' } : await terminal };
        });
        const onRestarted = vi.fn();
        const refresh = vi.fn();
        const screen = await renderScreen(<HomeRuntimeSection context={context({ refresh })}
            executor={{ kind: 'connected_machine', machineId: 'host', hostName: 'Home host' }} release={{ version: '0.3', flavor: 'light' }} onRestarted={onRestarted} />);
        await screen.tree.pressByTestIdAsync('home-runtime-restart');
        await waitForHomeGovernance(() => expect(machineRpc.mock.calls.some(([call]) => (call.payload as { method?: string }).method === 'wait')).toBe(true));
        expect(refresh).not.toHaveBeenCalled();
        expect(onRestarted).not.toHaveBeenCalled();
        await act(async () => complete({ protocolVersion: 1, taskId: 'restart', ok: true, data: { healthy } }));
        expect(refresh).toHaveBeenCalledTimes(healthy ? 1 : 0);
        expect(onRestarted).toHaveBeenCalledTimes(healthy ? 1 : 0);
    });

    it('offers Restart now, with Discard beside it, only when changes are pending and this device can restart the runtime', async () => {
        const ids = await renderBanner({ kind: 'hosting_desktop' }, 2);
        expect(ids).toContain('home-runtime-pending-restart.action');
        expect(ids).toContain('home-runtime-pending-restart.discard');
    });

    it('names where to restart and keeps Discard as the only action without an executor', async () => {
        const elsewhere = await renderBanner({ kind: 'elsewhere', hostName: 'MacBook Pro' }, 2);
        expect(elsewhere).not.toContain('home-runtime-pending-restart.action');
        expect(elsewhere).toContain('home-runtime-pending-restart.discard');

        const deployment = await renderBanner({ kind: 'deployment' }, 1);
        expect(deployment).not.toContain('home-runtime-pending-restart.action');
    });

    it('restarts from Overview\'s attention row through the same restart task, and only leads to Runtime where this device cannot restart', async () => {
        const onRestarted = vi.fn();
        const onReview = vi.fn();
        const here = await renderScreen(
            <HomePendingRestartAttentionRow testID="attention" context={context()} executor={{ kind: 'hosting_desktop' }}
                pendingCount={2} pendingSummary="Metrics port, Upload size limit." onRestarted={onRestarted} onReview={onReview} />,
        );
        expect(here.getTextContent()).toContain('homeGovernance.runtime.restartNow');
        await here.tree.pressByTestIdAsync('attention.action');
        expect(Modal.alertAsync).not.toHaveBeenCalled();
        expect(onReview).not.toHaveBeenCalled();
        const taskId = await admittedDesktopTask();
        expect(here.tree.findByType(RoundButton).props.loading).toBe(true);
        await act(async () => desktop.listeners.get(taskId)!.onResult({ protocolVersion: 1, taskId, ok: true, data: { healthy: true } }));
        expect(onRestarted).toHaveBeenCalledOnce();
        standardCleanup();

        const elsewhere = await renderScreen(
            <HomePendingRestartAttentionRow testID="attention" context={context()} executor={{ kind: 'elsewhere', hostName: 'MacBook Pro' }}
                pendingCount={2} pendingSummary="Metrics port, Upload size limit." onRestarted={onRestarted} onReview={onReview} />,
        );
        expect(elsewhere.getTextContent()).not.toContain('homeGovernance.runtime.restartNow');
        await elsewhere.tree.pressByTestIdAsync('attention.action');
        expect(onReview).toHaveBeenCalledOnce();
        expect(desktop.listeners.size).toBe(0);
    });

    it('renders nothing when nothing is pending, whatever the executor', async () => {
        const ids = await renderBanner({ kind: 'hosting_desktop' }, 0);
        expect(ids.filter((id) => id.startsWith('home-runtime-pending-restart'))).toEqual([]);
    });
});
