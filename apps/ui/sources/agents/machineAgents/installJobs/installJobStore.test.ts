import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { MACHINE_RPC_POLL_INTERVAL_MS } from '@/sync/ops/machineRpcPollInterval';
import { machineAgentInventoryStore } from '../machineAgentInventoryStore';
import { serverAccountScopedResourceKey } from '@/sync/domains/scope/serverAccountScope';
import type { MachineAgentInventoryItem } from '@happier-dev/protocol/capabilities';
import { buildMachineAgentInventoryKey, MachineAgentInventoryItemSchema } from '@happier-dev/protocol/capabilities';
import { AgentInstallJobSchema, DaemonAgentInstallCancelRequestSchema, DaemonAgentInstallReadRequestSchema, DaemonAgentInstallStartRequestSchema } from '@happier-dev/protocol/daemon/agent-install-jobs';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import type { PluginProjectionV2 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const boundary = vi.hoisted(() => ({ rpc: vi.fn(), credentialListeners: new Set<(event: { serverId: string; kind: 'credentials_removed'; serverUrl: string }) => void>() }));
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({ importOriginal, tokenStorage: {
        getCredentialsForServerUrl: async () => ({ token: `header.${Buffer.from(JSON.stringify({ sub: 'store-account' })).toString('base64')}.signature` }),
    }, subscribeHomeCredentialMutations: (listener) => {
        boundary.credentialListeners.add(listener);
        return () => { boundary.credentialListeners.delete(listener); };
    } });
});
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(boundary.rpc);
});

import { useAgentInstallJob } from './useAgentInstallJob';
// Load the real inventory graph during collection, outside the job's settlement test.
import '../useMachineAgents';
import { cancelAgentInstallJob, ensureMachineAgentInstallJobs, readAgentInstallJob, readMachineAgentInstallJobs, startAgentInstallJob, subscribeAgentInstallJob, waitForAgentInstallJob } from './installJobStore';

function wireJob(agentId: string, jobId: string) {
    return {
        agentId, jobId, intent: 'install', startedAt: 100,
        steps: [{ stepId: 'cli', label: 'Agent CLI', state: 'running' }],
        progress: [{ stepId: 'cli', bytesDone: 3, bytesTotal: 10 }], done: false, outcome: null,
    };
}

afterEach(() => {
    vi.useRealTimers();
    standardCleanup();
    boundary.rpc.mockReset();
    storage.setState(storage.getInitialState(), true);
});

describe('agent install job owner', () => {
    it('sends each definition-qualified admission to the daemon so a changed pin cannot join an older pending request', async () => {
        const target = { serverId: 'store-definition-pin', accountId: 'store-account', machineId: 'machine',
            agentId: 'custom-acp', definitionId: 'registry-definition' };
        const olderAdmission = createDeferred<void>();
        const reachedOlderAdmission = createDeferred<void>();
        // The daemon is the genuine boundary owning the captured Account catalog pin.
        let daemonPin = '1.0.0';
        boundary.rpc.mockImplementation(async ({ method, payload }: { method: string; payload: unknown }) => {
            if (method.endsWith('.start')) {
                expect(DaemonAgentInstallStartRequestSchema.parse(payload).definitionId).toBe(target.definitionId);
                const capturedPin = daemonPin;
                if (capturedPin === '1.0.0') { reachedOlderAdmission.resolve(); await olderAdmission.promise; }
                return { ok: true, jobId: `job-pin-${capturedPin}` };
            }
            if (method.endsWith('.list')) return { ok: true, jobs: [] };
            return { ok: true, steps: [], progress: [], events: [], nextCursor: 1, done: true,
                outcome: { kind: 'failed', code: 'install_failed', stepId: 'cli', message: 'Fixture install stopped' } };
        });
        const first = startAgentInstallJob(target, 'install', { consent: { vendorRecipe: false } });
        await reachedOlderAdmission.promise;
        daemonPin = '2.0.0';
        const second = startAgentInstallJob(target, 'install', { consent: { vendorRecipe: false } });
        expect.soft(second).not.toBe(first);
        olderAdmission.resolve();
        expect((await Promise.all([first, second])).map(job => job.jobId)).toEqual(['job-pin-1.0.0', 'job-pin-2.0.0']);
    });
    it('keeps two configured definitions distinct through admission, hydration, hooks and cancellation', async () => {
        vi.useFakeTimers();
        const server = await upsertServerProfile({ serverUrl: 'https://definition-install-jobs.example.test' });
        const a = { serverId: server.id, accountId: 'store-account', machineId: 'definitions-machine', agentId: 'custom-acp', definitionId: 'definition-a' };
        const b = { ...a, definitionId: 'definition-b' };
        const key = serverAccountScopedResourceKey(a, 'machine-agents', a.machineId);
        const facts = [a, b].map(target => MachineAgentInventoryItemSchema.parse({
            agentId: target.agentId, definitionId: target.definitionId, title: target.definitionId,
            installed: false, version: null, latestVersion: null, update: { supported: false, command: null },
            signIn: { status: 'unknown', loginSupport: 'login_terminal' }, platform: { supported: true },
            install: { available: true, mode: 'managed', sizeBytes: null, guideUrl: null }, dependencies: [],
        }));
        machineAgentInventoryStore.publish(key, { status: 'ready', items: facts, lastCheckedAt: 1 });
        const admission = createDeferred<void>();
        const hydration = createDeferred<unknown>();
        const cancelled = new Set<string>();
        boundary.rpc.mockImplementation(async ({ method, payload }: { method: string; payload: unknown }) => {
            if (method.endsWith('.start')) {
                const request = DaemonAgentInstallStartRequestSchema.parse(payload);
                await admission.promise;
                return { ok: true, jobId: `job-${request.definitionId ?? 'missing-definition'}` };
            }
            if (method.endsWith('.list')) return hydration.promise;
            if (method.endsWith('.cancel')) {
                cancelled.add(DaemonAgentInstallCancelRequestSchema.parse(payload).jobId);
                return { ok: true };
            }
            const request = DaemonAgentInstallReadRequestSchema.parse(payload);
            return { ok: true, steps: [], progress: [], events: [{ t: 'progress', stepId: 'cli',
                bytesDone: request.jobId === 'job-definition-a' ? 4 : 8, bytesTotal: 10 }], nextCursor: 1,
                done: cancelled.has(request.jobId), outcome: cancelled.has(request.jobId)
                    ? { kind: 'failed', code: 'cancelled', stepId: 'cli', message: 'Cancelled' } : null };
        });
        const discovering = ensureMachineAgentInstallJobs(a);
        const first = startAgentInstallJob(a, 'install', { consent: { vendorRecipe: false } });
        const second = startAgentInstallJob(b, 'install', { consent: { vendorRecipe: false } });
        expect.soft(second).not.toBe(first);
        admission.resolve();
        expect.soft((await Promise.all([first, second])).map(job => job.jobId)).toEqual(['job-definition-a', 'job-definition-b']);
        hydration.resolve({ ok: true, jobs: [a, b].map(target => AgentInstallJobSchema.parse({
            ...wireJob(target.agentId, `job-${target.definitionId}`), definitionId: target.definitionId,
        })) });
        await discovering;
        await act(async () => {});
        expect.soft(readAgentInstallJob(a)).toMatchObject({ jobId: 'job-definition-a', startedAtMs: 100, steps: [{ bytesDone: 4 }] });
        expect.soft(readAgentInstallJob(b)).toMatchObject({ jobId: 'job-definition-b', startedAtMs: 100, steps: [{ bytesDone: 8 }] });
        expect.soft(new Set(readMachineAgentInstallJobs(a).keys())).toEqual(new Set([buildMachineAgentInventoryKey(a), buildMachineAgentInventoryKey(b)]));
        const aHook = await renderHook(() => useAgentInstallJob(a));
        const bHook = await renderHook(() => useAgentInstallJob(b));
        expect.soft(aHook.getCurrent().job?.jobId).toBe('job-definition-a');
        expect.soft(bHook.getCurrent().job?.jobId).toBe('job-definition-b');
        const bJob = readAgentInstallJob(b);
        const bInventory = machineAgentInventoryStore.read(key).agents[1];
        const bNotified = vi.fn();
        const unsubscribe = subscribeAgentInstallJob(b, bNotified);
        await act(async () => { await cancelAgentInstallJob(a); });
        expect.soft(cancelled).toEqual(new Set(['job-definition-a']));
        expect.soft(aHook.getCurrent().job?.outcome).toMatchObject({ kind: 'failed', code: 'cancelled' });
        expect.soft(bHook.getCurrent().job).toBe(bJob);
        expect.soft(machineAgentInventoryStore.read(key).agents[1]).toBe(bInventory);
        expect.soft(machineAgentInventoryStore.read(key).agents[0]?.job?.outcome).toMatchObject({ code: 'cancelled' });
        expect.soft(bNotified).not.toHaveBeenCalled();
        unsubscribe();
        await act(async () => {
            for (const listener of boundary.credentialListeners) listener({ serverId: server.id,
                serverUrl: 'https://definition-install-jobs.example.test', kind: 'credentials_removed' });
        });
    });
    it('retains the native acknowledgement when Account retirement interrupts initial hydration', async () => {
        const target = { serverId: 'store-ack-retirement', accountId: 'store-account', machineId: 'machine', agentId: 'codex' };
        const hydration = createDeferred<unknown>();
        const reading = createDeferred<void>();
        boundary.rpc.mockImplementation(async ({ method }: { method: string }) => {
            if (method.endsWith('.start')) return { ok: true, jobId: 'job-acknowledged' };
            if (method.endsWith('.list')) { reading.resolve(); return hydration.promise; }
            throw new Error('A retired Account must not begin a cursor read');
        });
        const starting = startAgentInstallJob(target, 'update', { consent: { vendorRecipe: true } });
        // Observe the genuine boundary phase. Native start already acknowledged this exact job;
        // retirement affects its background projection, not that existing acknowledgement.
        const acknowledgement = starting.then(job => ({ job }), error => ({ error }));
        await reading.promise;
        for (const listener of boundary.credentialListeners) listener({
            serverId: target.serverId, serverUrl: 'https://ack-retirement.test', kind: 'credentials_removed',
        });
        hydration.resolve({ ok: true, jobs: [{ ...wireJob('codex', 'job-acknowledged'), intent: 'update' }] });
        expect(await acknowledgement).toMatchObject({ job: { jobId: 'job-acknowledged', intent: 'update' } });
        await act(async () => {});
        expect(readAgentInstallJob(target)).toBeNull();
    });
    it('reads successor Account facts through the inventory after the old detect retires', async () => {
        const { refreshMachineAgents } = await import('../useMachineAgents');
        const server = await upsertServerProfile({ serverUrl: 'https://inventory-switch.example.test' });
        const machine = createMachineFixture({ id: 'inventory-switch', active: true, activeAt: Date.now(), daemonStateVersion: 1 });
        storage.setState({ machineListByServerId: { [server.id]: [machine] } });
        const projection: PluginProjectionV2 = { v: 2, generation: 1, installedPackagesById: {}, agentsById: {
            codex: { id: 'codex', title: 'Codex', providerOwnedEnvironmentKeys: [], capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } },
        }, actionsById: {}, familiesById: {},   resourcesById: {}, settingsById: {}, diagnostics: [] };
        let currentAccount = 'account-a';
        const pending = createDeferred<unknown>();
        const detect = (version: string) => ({ protocolVersion: 1, results: { 'cli.codex': { ok: true, checkedAt: 24, data: {
            available: true, installed: true, version, latestVersion: null, update: { supported: false, command: null },
            signIn: { status: 'signedIn', loginSupport: 'login_terminal' }, platform: { supported: true },
            install: { available: true, mode: 'managed', sizeBytes: null, guideUrl: null }, dependencies: [],
        } } } });
        boundary.rpc.mockImplementation(({ method, accountId }: { method: string; accountId?: string | null }) => {
            if (accountId !== currentAccount) return Promise.reject(new Error('Credential replaced'));
            if (method.endsWith('.list')) return Promise.resolve({ ok: true, jobs: [] });
            if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return Promise.resolve({ protocolVersion: 1, projection });
            return accountId === 'account-a' ? pending.promise : Promise.resolve(detect('account-b-version'));
        });
        let aCurrent = true;
        const retirements = new Set<() => void>();
        const aScope = { serverId: server.id, accountId: 'account-a' };
        const bScope = { ...aScope, accountId: 'account-b' };
        const first = refreshMachineAgents({ serverId: server.id, machineId: machine.id, accountLifetime: {
            scope: aScope, isCurrent: () => aCurrent,
            onRetire(cancel) { retirements.add(cancel); return { dispose() { retirements.delete(cancel); } }; },
        } });
        await vi.waitFor(() => expect(boundary.rpc.mock.calls.some(([args]) => args.method === RPC_METHODS.CAPABILITIES_DETECT)).toBe(true));
        aCurrent = false;
        for (const cancel of retirements) cancel();
        currentAccount = 'account-b';
        await refreshMachineAgents({ serverId: server.id, machineId: machine.id, accountLifetime: {
            scope: bScope, isCurrent: () => true, onRetire: () => ({ dispose() {} }),
        } });
        pending.resolve(detect('retired-account-a-version'));
        await first;
        expect(machineAgentInventoryStore.read(serverAccountScopedResourceKey(bScope, 'machine-agents', machine.id))).toMatchObject({ status: 'ready', agents: [{ installed: true, version: 'account-b-version' }] });
        expect(machineAgentInventoryStore.read(serverAccountScopedResourceKey(aScope, 'machine-agents', machine.id)).agents).toEqual([]);
    });

    it('settles success without a client inventory readback when no inventory presenter is mounted', async () => {
        const server = await upsertServerProfile({ serverUrl: 'https://install-completion.example.test' });
        const target = { serverId: server.id, accountId: 'store-account', machineId: 'completed-machine', agentId: 'codex' };
        const machine = createMachineFixture({ id: target.machineId, active: true, activeAt: Date.now(), daemonStateVersion: 1 });
        storage.setState({ machineListByServerId: { [server.id]: [machine] } });
        const projection: PluginProjectionV2 = { v: 2, generation: 1, installedPackagesById: {}, agentsById: {
            codex: { id: 'codex', title: 'Codex', providerOwnedEnvironmentKeys: [], capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } },
        }, actionsById: {}, familiesById: {}, resourcesById: {}, settingsById: {}, diagnostics: [] };
        boundary.rpc.mockImplementation(async ({ method }: { method: string }) => {
            if (method.endsWith('.list')) return { ok: true, jobs: [wireJob('codex', 'completed-job')] };
            if (method.endsWith('.read')) return { ok: true, steps: [], progress: [], events: [], nextCursor: 1, done: true, outcome: { kind: 'succeeded', version: '2.0' } };
            if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return { protocolVersion: 1, projection };
            return { protocolVersion: 1, results: { 'cli.codex': { ok: true, checkedAt: 24, data: {
                available: true, installed: true, version: '2.0', latestVersion: null, update: { supported: false, command: null },
                signIn: { status: 'signedIn', loginSupport: 'login_terminal' }, platform: { supported: true },
                install: { available: true, mode: 'managed', sizeBytes: null, guideUrl: null }, dependencies: [],
            } } } };
        });
        await ensureMachineAgentInstallJobs(target);
        let outcome: unknown;
        void waitForAgentInstallJob(target).then(value => { outcome = value; });
        await vi.waitFor(() => expect(outcome).toEqual({ kind: 'succeeded', version: '2.0' }));
        // Daemon completion pushes the changed Machine revision.
        // A job presenter does not own a second executable inventory acquisition.
        expect(boundary.rpc.mock.calls.filter(([request]) => request.method === 'capabilities.detect')).toHaveLength(0);
        expect(readAgentInstallJob(target)).toMatchObject({ outcome: { kind: 'succeeded' } });
    });

    it('publishes daemon cursor progress and cancellation into the shared inventory without replacing unrelated agents', async () => {
        vi.useFakeTimers();
        const target = { serverId: 'store-inventory', accountId: 'account-a', machineId: 'machine', agentId: 'codex' };
        const key = serverAccountScopedResourceKey(target, 'machine-agents', target.machineId);
        const facts = (agentId: string): MachineAgentInventoryItem => ({ agentId, title: agentId, installed: false, version: null, latestVersion: null,
            update: { supported: false, command: null }, signIn: { status: 'unknown', loginSupport: 'login_terminal' }, platform: { supported: true },
            install: { available: true, mode: 'managed', sizeBytes: null, guideUrl: null }, dependencies: [{ key: 'helper', installed: true, version: '1' }] });
        machineAgentInventoryStore.publish(key, { status: 'ready', items: [facts('codex'), facts('claude')], lastCheckedAt: 1, dependencyTitlesByKey: { helper: 'Agent helper' } });
        const unrelated = machineAgentInventoryStore.read(key).agents[1];
        const read = createDeferred<unknown>();
        boundary.rpc.mockImplementation(async ({ method, payload }: { method: string; payload: { cursor?: number } }) => {
            if (method.endsWith('.list')) return { ok: true, jobs: [wireJob('codex', 'job-inventory')] };
            if (payload.cursor === 0) return read.promise;
            return { ok: true, steps: [], progress: [], events: [], nextCursor: 2, done: true, outcome: { kind: 'failed', code: 'cancelled', stepId: 'cli', message: 'Cancelled' } };
        });
        await ensureMachineAgentInstallJobs(target);
        expect(machineAgentInventoryStore.read(key).agents[0]).toMatchObject({ state: 'installing', job: { jobId: 'job-inventory', steps: [{ bytesDone: 3 }] } });
        await act(async () => {
            read.resolve({ ok: true, steps: [], progress: [], events: [{ t: 'progress', stepId: 'cli', bytesDone: 7, bytesTotal: 10 }], nextCursor: 1, done: false, outcome: null });
        });
        expect(machineAgentInventoryStore.read(key).agents[0]?.job?.steps[0]?.bytesDone).toBe(7);
        await act(async () => { await vi.advanceTimersByTimeAsync(MACHINE_RPC_POLL_INTERVAL_MS); });
        expect(machineAgentInventoryStore.read(key).agents[0]).toMatchObject({ state: 'notInstalled', job: { outcome: { code: 'cancelled' } } });
        expect(machineAgentInventoryStore.read(key).agents[1]).toBe(unrelated);
    });

    it('retires pending reads on credential removal without publishing their late completion', async () => {
        const target = { serverId: 'store-retired', accountId: 'account-a', machineId: 'machine', agentId: 'codex' };
        const read = createDeferred<unknown>();
        boundary.rpc.mockImplementation(async ({ method }: { method: string }) => method.endsWith('.list')
            ? { ok: true, jobs: [wireJob('codex', 'job-retired')] } : read.promise);
        await ensureMachineAgentInstallJobs(target);
        expect(readAgentInstallJob(target)?.jobId).toBe('job-retired');
        for (const listener of boundary.credentialListeners) listener({ serverId: target.serverId, serverUrl: 'https://retired.test', kind: 'credentials_removed' });
        read.resolve({ ok: true, steps: [], progress: [], events: [], nextCursor: 1, done: true, outcome: { kind: 'succeeded', version: '2.0' } });
        await act(async () => {});
        expect(readAgentInstallJob(target)).toBeNull();
    });

    it('isolates jobs and admission by Account on the same Home and machine', async () => {
        const a = { serverId: 'store-accounts', accountId: 'account-a', machineId: 'machine', agentId: 'codex' };
        const b = { ...a, accountId: 'account-b' };
        const read = createDeferred<unknown>();
        boundary.rpc.mockImplementation(async ({ method, accountId }: { method: string; accountId?: string }) => {
            if (method.endsWith('.list')) return { ok: true, jobs: accountId === 'account-a' ? [wireJob('codex', 'job-account-a')] : [] };
            return read.promise;
        });
        await ensureMachineAgentInstallJobs(a);
        expect(readAgentInstallJob(a)?.jobId).toBe('job-account-a');
        expect(readAgentInstallJob(b)).toBeNull();
        await ensureMachineAgentInstallJobs(b);
        expect(readAgentInstallJob(a)?.jobId).toBe('job-account-a');
        expect(readAgentInstallJob(b)).toBeNull();
        read.resolve({ ok: true, steps: [], progress: [], events: [], nextCursor: 1, done: true, outcome: { kind: 'succeeded', version: '2.0' } });
        await act(async () => {});
    });

    it('projects the current active job without publishing historical completion when the daemon clock was corrected', async () => {
        const target = { serverId: 'store-list-clock', accountId: 'store-account', machineId: 'machine', agentId: 'codex' };
        const read = createDeferred<unknown>();
        boundary.rpc.mockImplementation(async ({ method }: { method: string }) => method.endsWith('.list')
            ? { ok: true, jobs: [
                { ...wireJob('codex', 'job-history-clock'), startedAt: Date.now() + 60_000, done: true, outcome: { kind: 'succeeded', version: '1.0' } },
                { ...wireJob('codex', 'job-active-clock'), startedAt: Date.now() },
            ] }
            : read.promise);
        const seen: string[] = [];
        const unsubscribe = subscribeAgentInstallJob(target, () => { seen.push(readAgentInstallJob(target)?.jobId ?? 'none'); });
        await ensureMachineAgentInstallJobs(target);
        await act(async () => {});
        expect(readAgentInstallJob(target)?.jobId).toBe('job-active-clock');
        expect(seen).toEqual(['job-active-clock']);
        await act(async () => {
            read.resolve({ ok: true, steps: [], progress: [], events: [], nextCursor: 1, done: true, outcome: { kind: 'succeeded', version: '2.0' } });
        });
        expect(readAgentInstallJob(target)?.outcome).toMatchObject({ kind: 'succeeded', version: '2.0' });
        unsubscribe();
    });

    it('keeps an admitted job when an older in-flight list arrives from a daemon with a clock ahead of the client', async () => {
        const target = { serverId: 'store-start-clock', accountId: 'store-account', machineId: 'machine', agentId: 'codex' };
        const staleList = createDeferred<unknown>();
        const read = createDeferred<unknown>();
        boundary.rpc.mockImplementation(async ({ method }: { method: string }) => {
            if (method.endsWith('.list')) return staleList.promise;
            if (method.endsWith('.start')) return { ok: true, jobId: 'job-admitted' };
            return read.promise;
        });
        const discovering = ensureMachineAgentInstallJobs(target);
        const starting = startAgentInstallJob(target, 'install', { consent: { vendorRecipe: true } });
        await act(async () => {});
        await act(async () => {
            staleList.resolve({ ok: true, jobs: [{ ...wireJob('codex', 'job-historical'), startedAt: Date.now() + 60_000, done: true, outcome: { kind: 'succeeded', version: '1.0' } }] });
            await discovering;
        });
        expect((await starting).jobId).toBe('job-admitted');
        await act(async () => {
            read.resolve({ ok: true, steps: [], progress: [], events: [], nextCursor: 1, done: true, outcome: { kind: 'succeeded', version: '2.0' } });
        });
        expect(readAgentInstallJob(target)).toMatchObject({ jobId: 'job-admitted', outcome: { kind: 'succeeded', version: '2.0' } });
    });

    it('rejects cancelling a pruned projection while fresh discovery is pending instead of implicitly cancelling its successor', async () => {
        const target = { serverId: 'store-cancel-pruned', accountId: 'store-account', machineId: 'machine', agentId: 'codex' };
        const discovery = createDeferred<unknown>();
        let listed = false;
        boundary.rpc.mockImplementation(async ({ method, payload }: { method: string; payload: { jobId?: string } }) => {
            if (method.endsWith('.list')) {
                if (listed) return discovery.promise;
                listed = true;
                return { ok: true, jobs: [wireJob('codex', 'job-cancel-pruned')] };
            }
            if (payload.jobId === 'job-cancel-pruned') return { ok: false, errorCode: 'job_not_found', error: 'Job no longer retained' };
            return { ok: true, steps: [], progress: [], events: [], nextCursor: 1, done: true, outcome: { kind: 'succeeded', version: '3.0' } };
        });
        await ensureMachineAgentInstallJobs(target);
        await act(async () => {});
        expect(readAgentInstallJob(target)?.jobId).toBe('job-cancel-pruned');
        await expect(cancelAgentInstallJob(target)).rejects.toMatchObject({ code: 'job_not_found' });
        await act(async () => {
            discovery.resolve({ ok: true, jobs: [wireJob('codex', 'job-cancel-successor')] });
        });
        expect(readAgentInstallJob(target)?.outcome).toMatchObject({ kind: 'succeeded', version: '3.0' });
        expect(boundary.rpc.mock.calls.filter(([call]) => call.method.endsWith('.cancel'))).toHaveLength(0);
    });

    it('retains the last projection and retries when reconnect discovery loses its connection', async () => {
        vi.useFakeTimers();
        const target = { serverId: 'store-pruned-offline', accountId: 'store-account', machineId: 'machine', agentId: 'codex' };
        let listCount = 0;
        boundary.rpc.mockImplementation(async ({ method, payload }: { method: string; payload: { jobId?: string } }) => {
            if (method.endsWith('.list')) {
                listCount += 1;
                if (listCount === 2) throw new Error('Connection lost');
                return { ok: true, jobs: [wireJob('codex', listCount === 1 ? 'job-offline-pruned' : 'job-offline-current')] };
            }
            if (payload.jobId === 'job-offline-pruned') return { ok: false, errorCode: 'job_not_found', error: 'Job no longer retained' };
            return { ok: true, steps: [], progress: [], events: [], nextCursor: 1, done: true, outcome: { kind: 'succeeded', version: '3.0' } };
        });
        await ensureMachineAgentInstallJobs(target);
        await act(async () => {});
        expect(readAgentInstallJob(target)).toMatchObject({ jobId: 'job-offline-pruned', outcome: null });
        await act(async () => { await vi.advanceTimersByTimeAsync(MACHINE_RPC_POLL_INTERVAL_MS); });
        expect(readAgentInstallJob(target)).toMatchObject({ jobId: 'job-offline-current', outcome: { kind: 'succeeded', version: '3.0' } });
    });

    it('discovers the latest admitted job when a cursor job was pruned during reconnect', async () => {
        const target = { serverId: 'store-pruned', accountId: 'store-account', machineId: 'machine', agentId: 'codex' };
        const terminal = createDeferred<unknown>();
        let listed = false;
        boundary.rpc.mockImplementation(async ({ method, payload }: { method: string; payload: { jobId?: string } }) => {
            if (method.endsWith('.list')) {
                const jobId = listed ? 'job-current' : 'job-pruned';
                listed = true;
                return { ok: true, jobs: [wireJob('codex', jobId)] };
            }
            if (payload.jobId === 'job-pruned') return { ok: false, errorCode: 'job_not_found', error: 'Job no longer retained' };
            return terminal.promise;
        });
        const unrelated = { ...target, agentId: 'claude' };
        const before = readAgentInstallJob(unrelated);
        const notified = vi.fn();
        const unsubscribe = subscribeAgentInstallJob(unrelated, notified);
        await ensureMachineAgentInstallJobs(target);
        await act(async () => {});
        expect(readAgentInstallJob(target)?.jobId).toBe('job-current');
        await act(async () => {
            terminal.resolve({ ok: true, steps: [], progress: [], events: [], nextCursor: 1, done: true, outcome: { kind: 'succeeded', version: '3.0' } });
        });
        expect(readAgentInstallJob(target)?.outcome).toMatchObject({ kind: 'succeeded', version: '3.0' });
        expect(readAgentInstallJob(unrelated)).toBe(before);
        expect(notified).not.toHaveBeenCalled();
        unsubscribe();
    });

    it('keeps polling after unmount and remounts the same job without notifying unrelated agents', async () => {
        const server = await upsertServerProfile({ serverUrl: 'https://install-lifetime.example.test' });
        const target = { serverId: server.id, accountId: 'store-account', machineId: 'machine', agentId: 'codex' };
        const read = createDeferred<unknown>();
        boundary.rpc.mockImplementation(async ({ method }: { method: string }) => {
            if (method.endsWith('.list')) return { ok: true, jobs: [
                wireJob('codex', 'job-lifetime'),
                { ...wireJob('claude', 'job-unrelated'), done: true, outcome: { kind: 'succeeded', version: '1.0' } },
            ] };
            if (method.endsWith('.start')) return { ok: true, jobId: 'job-lifetime' };
            return read.promise;
        });
        const unrelatedTarget = { ...target, agentId: 'claude' };
        const unrelatedNotified = vi.fn();
        const unsubscribe = subscribeAgentInstallJob(unrelatedTarget, unrelatedNotified);
        const first = await renderHook(() => useAgentInstallJob(target));
        const before = first.getCurrent().job;
        expect(before?.jobId).toBe('job-lifetime');
        const unrelatedBefore = readAgentInstallJob(unrelatedTarget);
        expect(unrelatedBefore?.jobId).toBe('job-unrelated');
        unrelatedNotified.mockClear();
        await first.unmount();
        const second = await renderHook(() => useAgentInstallJob(target));
        expect(second.getCurrent().job).toBe(before);
        await act(async () => {
            read.resolve({ ok: true, steps: [], progress: [], events: [{ t: 'progress', stepId: 'cli', bytesDone: 10, bytesTotal: 10 }],
                nextCursor: 1, done: true, outcome: { kind: 'succeeded', version: '2.0' } });
        });
        expect(second.getCurrent().job?.outcome).toEqual({ kind: 'succeeded', version: '2.0' });
        expect(second.getCurrent().job?.steps[0]?.bytesDone).toBe(10);
        expect(readAgentInstallJob(unrelatedTarget)).toBe(unrelatedBefore);
        expect(unrelatedNotified).not.toHaveBeenCalled();
        unsubscribe();
    });

    it('resumes an existing daemon job from list and reads from the cursor without replaying snapshots', async () => {
        const target = { serverId: 'store-reload', accountId: 'store-account', machineId: 'machine', agentId: 'plugin-agent' };
        boundary.rpc.mockImplementation(async ({ method }: { method: string }) => {
            if (method.endsWith('.list')) return { ok: true, jobs: [wireJob('plugin-agent', 'job-reload')] };
            return { ok: true, steps: [], progress: [], events: [{ t: 'log', line: 'Checking the CLI' }], nextCursor: 7,
                done: true, outcome: { kind: 'failed', code: 'verification_failed', stepId: 'cli', message: 'Invalid binary' } };
        });
        await ensureMachineAgentInstallJobs(target);
        await act(async () => {});
        expect(readAgentInstallJob(target)).toMatchObject({
            jobId: 'job-reload', startedAtMs: 100, logLine: 'Checking the CLI',
            outcome: { kind: 'failed', code: 'verification_failed' },
        });
        expect(boundary.rpc).toHaveBeenCalledWith(expect.objectContaining({
            method: 'daemon.agents.install.read', payload: { jobId: 'job-reload', cursor: 0 },
        }));
    });

    it('shares concurrent admission and waits for the daemon cancellation outcome', async () => {
        const target = { serverId: 'store-cancel', accountId: 'store-account', machineId: 'machine', agentId: 'codex' };
        let started = false;
        let cancelled = false;
        boundary.rpc.mockImplementation(async ({ method }: { method: string }) => {
            if (method.endsWith('.start')) { started = true; return { ok: true, jobId: 'job-cancel' }; }
            if (method.endsWith('.list')) return { ok: true, jobs: started ? [wireJob('codex', 'job-cancel')] : [] };
            if (method.endsWith('.cancel')) { cancelled = true; return { ok: true }; }
            return { ok: true, steps: [], progress: [], events: [], nextCursor: 4, done: cancelled,
                outcome: cancelled ? { kind: 'failed', code: 'cancelled', stepId: 'cli', message: 'Cancelled' } : null };
        });
        const first = startAgentInstallJob(target, 'install', { consent: { vendorRecipe: false } });
        const second = startAgentInstallJob(target, 'install', { consent: { vendorRecipe: false } });
        expect(second).toBe(first);
        await first;
        const terminal = waitForAgentInstallJob(target);
        await cancelAgentInstallJob(target);
        expect(await terminal).toMatchObject({ kind: 'failed', code: 'cancelled' });
        expect(readAgentInstallJob(target)?.outcome).toMatchObject({ code: 'cancelled' });
        expect(boundary.rpc).toHaveBeenCalledWith(expect.objectContaining({
            method: 'daemon.agents.install.read', payload: { jobId: 'job-cancel', cursor: 4 },
        }));
    });
});
