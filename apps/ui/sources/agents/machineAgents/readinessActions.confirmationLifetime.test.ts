import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonAgentInstallStartRequestSchema } from '@happier-dev/protocol/daemon/agent-install-jobs';
import { MachineAgentInventoryItemSchema } from '@happier-dev/protocol/capabilities';
import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import type { ModalShowConfig } from '@/modal/types';
import { readActionFailureEnvelope } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';

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
const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');

function receiptStatus(result: unknown) {
    const failure = readActionFailureEnvelope(result);
    return {
        ok: result !== null && typeof result === 'object' && 'ok' in result ? result.ok : undefined,
        ...(failure ? { errorCode: failure.errorCode, effectAttempted: failure.effectAttempted,
            failureCause: failure.failureCause && { phase: failure.failureCause.phase,
                errorCode: failure.failureCause.errorCode, errorClass: failure.failureCause.errorClass } } : {}),
    };
}

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

    async function mount(agentId: string, surface: 'row' | 'form', invoke = true) {
        const serverIdentityId = 'srv_install_lifetime';
        const homeId = await home.addHome({ name: 'Install Home', serverUrl: 'https://install-lifetime.test', accountId: 'alice',
            serverIdentityId, currentAccount: true });
        await network.addHome('https://install-lifetime.test', 'alice', { serverIdentityId });
        const serverId = resolveServerProfileScopeIdForIdentifier(homeId);
        const target = { serverId, machineId: `${agentId}-${surface}`, agentId };
        const key = serverAccountScopedResourceKey({ serverId, accountId: 'alice' }, 'machine-agents', target.machineId);
        machineAgentInventoryStore.publish(key, { status: 'ready', lastCheckedAt: 1, items: [MachineAgentInventoryItemSchema.parse({
            agentId, title: agentId, installed: false, version: null, latestVersion: null,
            update: { supported: true, command: null }, signIn: { status: 'signedOut', loginSupport: 'login_terminal' },
            platform: { supported: true }, install: { available: true, mode: 'managed', sizeBytes: null, guideUrl: null }, dependencies: [],
        })] });
        const hook = await renderHook(() => ({
            row: useMachineAgentRowActions({ ...target, machineName: 'Dev box', onOpenForm: () => {}, canManage: true }),
            form: useAgentInstallJob(target),
        }));
        let pending: Promise<unknown> | undefined;
        if (invoke) await act(async () => {
            if (surface === 'row') hook.getCurrent().row(machineAgentInventoryStore.read(key).agents[0], { kind: 'install' });
            else pending = hook.getCurrent().form.start('install');
        });
        if (surface === 'form') return { hook, review: null, pending };
        const reviews = () => [...dialogs].filter(([, dialog]) => dialog.type === 'custom'
            && dialog.chrome?.testID === 'actions.confirmation-review.modal');
        await waitForHomeGovernance(() => expect(reviews(),
            JSON.stringify({ paths: home.requests.map(({ method, path }) => `${method} ${path.split('?')[0]}`),
                rpcMethods: network.requests.map(({ method }) => method) })).toHaveLength(1));
        const [id, dialog] = reviews()[0]!;
        if (dialog.type !== 'custom' || typeof dialog.props?.onAnswer !== 'function') throw new Error('Expected Action review decision port');
        expect(dialog.props).toMatchObject({ actionId: 'machines.agents.install',
            actionArgs: { machineId: target.machineId, agentId }, serverId });
        const onAnswer = dialog.props.onAnswer;
        return { hook, review: { id, answer: (confirmed: boolean) => { onAnswer(confirmed); Modal.hide(id); } }, pending };
    }

    for (const surface of ['row', 'form'] as const) {
        it.each(['codex', 'auggie'])(`keeps the ${surface} %s Install intent current after rerender`, async agentId => {
            const { hook, review, pending } = await mount(agentId, surface);
            await hook.rerender();
            if (review) await act(async () => { review.answer(true); });
            else expect(dialogs.size).toBe(0);
            if (pending) {
                const result = await pending;
                expect(result, JSON.stringify(receiptStatus(result))).toMatchObject({ ok: true, result: { ok: true, jobId: 'confirmed-install' } });
            }
            await waitForHomeGovernance(() => expect(starts).toEqual([{ agentId, intent: 'install', consent: { vendorRecipe: true } }]));
            expect(network.requests.filter(({ method }) => method === 'daemon.agents.install.start')).toMatchObject([
                { targetId: `${agentId}-${surface}`, serverUrl: 'https://install-lifetime.test' },
            ]);
            expect(hook.getCurrent().form.job?.jobId).toBe('confirmed-install');
        });

        it.each(['codex', 'auggie'])(`retires the ${surface} %s Install intent when its presenter unmounts`, async agentId => {
            const { hook, review, pending } = await mount(agentId, surface, surface === 'row');
            const capturedInstall = hook.getCurrent().form.start;
            await hook.unmount();
            await flushHookEffects();
            // A global dialog must not offer Confirm for an invocation that can no longer run.
            if (review) {
                expect(dialogs.has(review.id)).toBe(false);
                review.answer(true); // A late platform callback cannot start the retired install.
            } else {
                await expect(capturedInstall('install')).rejects.toMatchObject({ code: 'scope_retired' });
            }
            if (pending) await expect(pending).resolves.toMatchObject({ ok: false, errorCode: 'cancelled' });
            expect(starts).toEqual([]);
        });
    }
});
