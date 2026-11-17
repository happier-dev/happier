import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonAgentInstallStartRequestSchema } from '@happier-dev/protocol/daemon/agent-install-jobs';
import { MachineAgentInventoryItemSchema } from '@happier-dev/protocol/capabilities';
import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import type { ModalShowConfig } from '@/modal/types';

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
vi.doUnmock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch');
const network = await installSessionOpsNetworkBoundary();
const { Modal } = await import('@/modal');
const { useAgentInstallJob } = await import('./installJobs/useAgentInstallJob');
const { useMachineAgentRowActions } = await import('@/components/machines/agents/useMachineAgentRowActions');
const { machineAgentInventoryStore } = await import('./machineAgentInventoryStore');
const { serverAccountScopedResourceKey } = await import('@/sync/domains/scope/serverAccountScope');

describe('install confirmation lifetime through real mounted Actions and Modal controller', () => {
    const dialogs = new Map<string, ModalShowConfig>();
    const starts: unknown[] = [];
    let unregister: () => void;
    let nextId = 0;

    beforeEach(async () => {
        await home.reset();
        network.resetRequests();
        dialogs.clear(); starts.length = 0;
        // Only the platform presentation port is replaced; Modal promises and Action admission stay real.
        unregister = Modal.registerProvider({
            showModal: config => { const id = `install-confirm-${++nextId}`; dialogs.set(id, config); return id; },
            hideModal: id => { dialogs.delete(id); },
            hideAllModals: () => { dialogs.clear(); },
            updateCustomModalProps: () => {},
        });
        network.setHttpResponder(async (input, init) => new URL(String(input)).pathname.startsWith('/v1/machines/') ? null : home.request(input, init));
        network.setRpcResponder(async ({ method, payload }) => {
            if (method === 'daemon.agents.install.start') {
                starts.push(DaemonAgentInstallStartRequestSchema.parse(payload));
                return { ok: true, jobId: 'confirmed-install' };
            }
            if (method === 'daemon.agents.install.list') return { ok: true, jobs: [] };
            if (method === 'daemon.agents.install.read') return { ok: true, steps: [], progress: [], events: [], nextCursor: 0, done: false, outcome: null };
            throw new Error(method);
        });
    });
    afterEach(async () => {
        standardCleanup();
        for (const [id, config] of dialogs) if (config.type === 'confirm') Modal.resolveConfirm(id, false);
        dialogs.clear(); unregister();
        const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
        await serverScopedRpcSocketPool.stopAll();
    });
    afterAll(async () => { await network.dispose(); });

    async function mount(agentId: string, surface: 'row' | 'form') {
        const serverId = await home.addHome({ name: 'Install Home', serverUrl: 'https://install-lifetime.test', accountId: 'alice' });
        await network.addHome('https://install-lifetime.test', 'alice');
        const target = { serverId, machineId: `${agentId}-${surface}`, agentId };
        const key = serverAccountScopedResourceKey({ serverId, accountId: 'alice' }, 'machine-agents', target.machineId);
        machineAgentInventoryStore.publish(key, { status: 'ready', lastCheckedAt: 1, items: [MachineAgentInventoryItemSchema.parse({
            agentId, title: agentId, installed: false, version: null, latestVersion: null,
            update: { supported: true, command: null }, signIn: { status: 'signedOut', loginSupport: 'login_terminal' },
            platform: { supported: true }, install: { available: true, mode: 'managed', sizeBytes: null, guideUrl: null }, dependencies: [],
        })] });
        const hook = await renderHook(() => ({
            row: useMachineAgentRowActions({ ...target, machineName: 'Dev box', onOpenForm: () => {} }),
            form: useAgentInstallJob(target),
        }));
        let pending: Promise<unknown> | undefined;
        await act(async () => {
            if (surface === 'row') hook.getCurrent().row(machineAgentInventoryStore.read(key).agents[0], { kind: 'install' });
            else pending = hook.getCurrent().form.start('install', { consent: { vendorRecipe: false } });
        });
        await waitForHomeGovernance(() => expect([...dialogs.values()].filter(dialog => dialog.type === 'confirm')).toHaveLength(1));
        const id = [...dialogs].find(([, dialog]) => dialog.type === 'confirm')![0];
        return { hook, id, pending };
    }

    for (const surface of ['row', 'form'] as const) {
        it.each(['codex', 'auggie'])(`confirms ${surface} %s after rerender and starts the captured install`, async agentId => {
            const { hook, id, pending } = await mount(agentId, surface);
            await hook.rerender();
            await act(async () => { Modal.resolveConfirm(id, true); });
            if (pending) await expect(pending).resolves.toMatchObject({ ok: true, result: { ok: true, jobId: 'confirmed-install' } });
            await waitForHomeGovernance(() => expect(starts).toEqual([{ agentId, intent: 'install', consent: { vendorRecipe: false } }]));
            expect(hook.getCurrent().form.job?.jobId).toBe('confirmed-install');
        });

        it.each(['codex', 'auggie'])(`retires the ${surface} %s confirmation when its presenter unmounts`, async agentId => {
            const { hook, id, pending } = await mount(agentId, surface);
            await hook.unmount();
            await flushHookEffects();
            // A global dialog must not offer Confirm for an invocation that can no longer run.
            expect(dialogs.has(id)).toBe(false);
            Modal.resolveConfirm(id, true); // A late platform callback cannot start the retired install.
            if (pending) await expect(pending).resolves.toMatchObject({ ok: false, errorCode: 'cancelled' });
            expect(starts).toEqual([]);
        });
    }
});
