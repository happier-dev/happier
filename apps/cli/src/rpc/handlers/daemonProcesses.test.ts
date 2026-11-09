import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RpcHandlerMap, RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import { createProcessOwnershipRuntime } from '@/daemon/processes/ownership/processOwnershipRuntime';
import { createLeftBehindPass } from '@/daemon/processes/leftBehind/leftBehindPass';
import { createMachineProcessesView } from '@/daemon/processes/view/createMachineProcessesView';
import { createMachineVitalsSampler } from '@/daemon/vitals/createMachineVitalsSampler';
import { createMinuteHistoryStore } from '@/daemon/vitals/history/minuteHistoryStore';
import { createLinuxMachineVitalsReader } from '@/daemon/vitals/readers/linux';
import { parseLinuxProcStartTimeMs } from '@happier-dev/cli-common/processInstance';
import { MachineProcessesAnswerV1Schema, MachineProcessesCheckResultV1Schema } from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { registerDaemonProcessesRpcHandlers } from './daemonProcesses';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { SocketRpcMachineAdmissionContextV1Schema } from '@happier-dev/protocol/socketRpc';
import { localServiceProcfsFixture } from '@/daemon/local/services/inventory/platform/censusFixture.testkit';
import { listHappierProcessRoots } from '@/daemon/processes/roots/listHappierProcessRoots';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
it('discloses native Environment processes only through current Machine and captured Account read authority', async () => {
    const id = 'f'.repeat(64);
    const procfs = localServiceProcfsFixture([{ pid: 20, uid: '0' }, { pid: 21, ppid: 20, uid: '0' }]);
    const runtime = createProcessOwnershipRuntime({ platform: 'linux', daemonScopeKey: '123456789abc',
        censusDependencies: { platform: 'linux', linuxBoundary: { ...procfs, readFile: async path =>
            /^\/proc\/(20|21)\/cgroup$/u.test(path) ? `0::/system.slice/docker-${id}.scope` : procfs.readFile(path) } },
        listRoots: snapshot => listHappierProcessRoots({ snapshot, platform: 'linux', nativeContainers: [{ pid: 20,
            owner: { kind: 'container', serverId: 'home', machineId: 'm', serviceId: 'production/web', containerId: id,
                composeProject: 'production', composeService: 'web', environmentId: 'environment' } }] }) });
    const pass = createLeftBehindPass({ processOwnershipRuntime: runtime });
    const sampler = createMachineVitalsSampler({ readers: { read: async () => { throw new Error('No metrics demand'); } },
        historyStore: { read: async () => [], append: async () => true, prune: async () => undefined,
            appendAlert: async () => undefined, minutes: () => [], alerts: () => [] } });
    const view = createMachineProcessesView({ processOwnershipRuntime: runtime, leftBehind: pass, machineVitals: sampler,
        platform: 'linux', bootTimeMs: 1000, allProcessesVisible: () => false, requesterForOwner: () => null });
    const handlers: RpcHandlerMap = new Map();
    const registrar: RpcHandlerRegistrar = { registerHandler: (method, handler) => { handlers.set(method, handler); } };
    const target = () => ({ serverId: 'home', machineId: 'm', installationId: 'i', custodianAccountId: 'owner' });
    const controller = new AbortController();
    let abortDuringAccountRead = false;
    let accountReads = 0;
    const context: RpcHandlerContext = { signal: controller.signal, machineAdmission: {
        machineId: 'm', installationId: 'i', custodianAccountId: 'owner', actorAccountId: 'guest', role: 'use', encryptionMode: 'plain',
    }, verifyMachineAdmissionCurrent: async () => true };
    const list = (ingress = context) => handlers.get(RPC_METHODS.MACHINES_PROCESSES_LIST)!({ machineId: 'm', serverId: 'browser-home' }, ingress);
    try {
        registerDaemonProcessesRpcHandlers(registrar, { view, target });
        expect(MachineProcessesAnswerV1Schema.parse(await list()).owners).toEqual([]);
        registerDaemonProcessesRpcHandlers(registrar, { view, target, readEnvironment: async (environment, ingress) => {
            // The Account read adapter is the external Home boundary; all projection/admission logic stays real.
            expect(environment).toEqual({ serverId: 'home', environmentId: 'environment' });
            expect(ingress.machineAdmission?.actorAccountId).toBe('guest');
            accountReads++;
            if (abortDuringAccountRead) controller.abort();
            return true;
        } });
        const answer = MachineProcessesAnswerV1Schema.parse(await list());
        expect(answer.owners).toHaveLength(1);
        expect(answer.owners[0].members).toHaveLength(2);
        expect(accountReads).toBe(1);
        expect(MachineProcessesAnswerV1Schema.parse(await list({ ...context,
            localActionContext: { processEnvironmentRead: async () => false } })).owners).toEqual([]);
        expect(accountReads).toBe(1); // A captured denial never falls back to installed Account custody.
        abortDuringAccountRead = true;
        await expect(list()).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
        const before = accountReads;
        await expect(list()).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
        expect(accountReads).toBe(before);
    } finally { view.dispose(); pass.dispose(); await sampler.stop(); }
});
it('projects a real Linux census with one admission per read request and re-admits the next request', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'machine-process-rpc-')); directories.push(directory);
    const stat = (pid: number) => `${pid} (worker) ${['S', '1', '42', '42', '0', '42', ...Array(5).fill('0'), '12', '8', ...Array(6).fill('0'), String(pid * 10), '4096', '3'].join(' ')}`;
    const auxv = Buffer.alloc(32); auxv.writeBigUInt64LE(6n); auxv.writeBigUInt64LE(4096n, 8);
    let unavailable = false;
    let current = true;
    let revokeDuringRead = false;
    let nativeReads = 0;
    // Only /proc filesystem reads are substituted; census decoding and all domain/RPC logic remain real.
    const runtime = createProcessOwnershipRuntime({ selfPid: 42, platform: 'linux', daemonScopeKey: '123456789abc',
        listRoots: snapshot => [{ owner: { kind: 'session', sessionId: 's' }, pid: 42,
            start: snapshot.rows.find(row => row.pid === 42)!.start, live: true, ownerCreatedAtMs: 0 }],
        censusDependencies: { platform: 'linux', selfPid: 42, linuxBoundary: {
            async readdir() {
                nativeReads++;
                if (revokeDuringRead) current = false;
                if (unavailable) throw new Error('OS denied');
                return ['42', '43'];
            },
            async readFile(path) {
                if (path === '/proc/self/auxv') return auxv;
                const pid = Number(path.split('/')[2]);
                if (path.endsWith('/stat')) return stat(pid);
                if (path.endsWith('/status')) return 'Uid:\t1000\t1000\t1000\t1000\n';
                if (path.endsWith('/cmdline')) return 'agent\0--token\0must-not-disclose\0';
                if (path.endsWith('/cgroup')) return '0::/user.slice\n';
                if (path.endsWith('/environ')) return '';
                throw new Error('not readable');
            }, async readlink(path) { return path.endsWith('/exe') ? '/usr/bin/worker' : '/work'; },
        } } });
    const pass = createLeftBehindPass({ processOwnershipRuntime: runtime });
    const sampler = createMachineVitalsSampler({ readers: createLinuxMachineVitalsReader({ root: directory }), historyStore: await createMinuteHistoryStore({ directory }) });
    const view = createMachineProcessesView({ processOwnershipRuntime: runtime, leftBehind: pass, machineVitals: sampler,
        platform: 'linux', selfPid: 42, bootTimeMs: 1000, allProcessesVisible: () => true,
        requesterForOwner: () => ({ accountId: 'guest', displayName: 'Guest' }) });
    const handlers: RpcHandlerMap = new Map();
    const registrar: RpcHandlerRegistrar = { registerHandler: (method, handler) => { handlers.set(method, handler); } };
    registerDaemonProcessesRpcHandlers(registrar, { view, target: () => ({ serverId: 'home', machineId: 'm', installationId: 'i', custodianAccountId: 'owner' }) });
    const context: RpcHandlerContext = { signal: new AbortController().signal, machineAdmission: {
        machineId: 'm', installationId: 'i', custodianAccountId: 'owner', actorAccountId: 'guest', role: 'use', encryptionMode: 'plain',
    }, verifyMachineAdmissionCurrent: async () => true };
    const list = handlers.get(RPC_METHODS.MACHINES_PROCESSES_LIST)!;
    const answer = MachineProcessesAnswerV1Schema.parse(await list({ serverId: 'browser-home', machineId: 'm' }, context));
    expect(answer.state).toBe('live');
    const nativeStartTimeMs = parseLinuxProcStartTimeMs(stat(42));
    if (nativeStartTimeMs === null) throw new Error('Expected a valid native start time in the procfs fixture');
    expect(answer.owners[0].members[0]).toMatchObject({ pid: 42, command: 'agent --token [REDACTED]', startedAtMs: 1000 + nativeStartTimeMs });
    const check = MachineProcessesCheckResultV1Schema.parse(await handlers.get(RPC_METHODS.MACHINES_PROCESSES_CHECK)!({ machineId: 'm', refs: [answer.owners[0].members[0].ref] }, context));
    expect(check.checks[0]).toMatchObject({ present: true, identityEqual: true, owner: { kind: 'session', sessionId: 's' } });
    let verifications = 0;
    const manager = new RpcHandlerManager({ scopePrefix: 'm', localMachineId: 'm', encryptionMode: 'plain', logger: () => {},
        authorizeRequest: request => authorizeMachineRpcRequest(request, {
            machineId: 'm', resolveCustodianAccountId: async () => 'owner', resolveInstallationId: () => 'i',
            // Home verification is the network boundary; ownership, view and dispatch remain real.
            verifyMachineAdmission: async () => { verifications++; return current; },
        }) });
    registerDaemonProcessesRpcHandlers(manager, { view, target: () => ({ serverId: 'home', machineId: 'm', installationId: 'i', custodianAccountId: 'owner' }) });
    const request = (method: string, params: object) => ({ method: `m:${method}`, params: { machineId: 'm', ...params },
        callerAuthority: 'present_user' as const, machineAdmission: SocketRpcMachineAdmissionContextV1Schema.parse(context.machineAdmission) });
    const ref = answer.owners[0].members[0].ref;
    for (const [method, params, expected] of [
        [RPC_METHODS.MACHINES_PROCESSES_LIST, {}, { state: 'live' }],
        [RPC_METHODS.MACHINES_PROCESSES_GET, { ref }, { row: { pid: 42 } }],
        [RPC_METHODS.MACHINES_PROCESSES_CHECK, { refs: [ref] }, { checks: [{ present: true }] }],
        [RPC_METHODS.DAEMON_PROCESSES_WATCH, { scope: 'happier', view: 'tree' }, { changed: true, answer: { state: 'live' } }],
    ] as const) {
        const before = verifications;
        const response = await manager.handleRequest(request(method, params));
        expect(response).toMatchObject(expected);
        expect(verifications - before).toBe(1);
    }
    const beforeRevocation = verifications;
    revokeDuringRead = true;
    expect(await manager.handleRequest(request(RPC_METHODS.MACHINES_PROCESSES_GET, { ref }))).toMatchObject({ row: { pid: 42 } });
    expect(verifications - beforeRevocation).toBe(1);
    const beforeDenied = verifications;
    const readsBeforeDenied = nativeReads;
    expect(await manager.handleRequest(request(RPC_METHODS.MACHINES_PROCESSES_LIST, {}))).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
    expect(verifications - beforeDenied).toBe(1);
    expect(nativeReads).toBe(readsBeforeDenied);
    current = true;
    unavailable = true;
    const beforeUnavailable = verifications;
    expect(await manager.handleRequest(request(RPC_METHODS.MACHINES_PROCESSES_GET, { ref })))
        .toMatchObject({ error: expect.any(String) });
    expect(verifications - beforeUnavailable).toBe(1);
    unavailable = false;
    revokeDuringRead = false;
    current = true;
    await expect(list({ machineId: 'm' }, { ...context, machineAdmission: { ...context.machineAdmission!, installationId: 'replaced' } })).rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
    expect(await list({ machineId: 'm' }, { ...context, verifyMachineAdmissionCurrent: async () => false })).toMatchObject({ state: 'live' });
    unavailable = true;
    expect(MachineProcessesAnswerV1Schema.parse(await list({ machineId: 'm' }, context))).toMatchObject({ state: 'unavailable', reason: 'read_failed' });
    view.dispose(); pass.dispose(); await sampler.stop();
});
