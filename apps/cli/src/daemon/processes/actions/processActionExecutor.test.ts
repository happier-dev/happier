import { describe, expect, it } from 'vitest';
import { createProcessOwnershipRuntime } from '../ownership/processOwnershipRuntime';
import { resolveProcessOwnerRequester } from '../ownership/resolveProcessOwnerRequester';
import { createLeftBehindTracker } from '../leftBehind/leftBehindTracker';
import { processRef } from '../view/processRef';
import { createProcessActionExecutor, type ProcessActionExecutorInput } from './processActionExecutor';
import { createProcessActionOwnerAdapters } from './processActionOwnerAdapters';
import type { HappierProcessRoot, ProcessOwnerRef } from '../ownership/types';
import type { ProcessCensusDependencies, ProcessCensusRow } from '@/processes/census/processCensus';
import { createDeferred } from '@/testkit/async/deferred';
import { createSessionProcessActionLifecycle } from '../../sessions/sessionProcessActionLifecycle';
import { createDisconnectedTerminalHostResumeLifecycle } from '../../startup/disconnectedTerminalHostResumeLifecycle';
import { createSessionRunnerRespawnManager } from '../../processSupervision/sessionRunnerRespawn';
import { createStopSession } from '../../sessions/stopSession';
import type { TrackedSession } from '../../types';
import { localServiceProcfsFixture } from '@/daemon/local/services/inventory/platform/censusFixture.testkit';
import { listHappierProcessRoots } from '../roots/listHappierProcessRoots';
import { createLeftBehindPass } from '../leftBehind/leftBehindPass';
import { createMachineProcessesView } from '../view/createMachineProcessesView';
import { createMachineVitalsSampler } from '@/daemon/vitals/createMachineVitalsSampler';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { registerDaemonProcessesRpcHandlers } from '@/rpc/handlers/daemonProcesses';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { SessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

const scope = '123456789abc';
const principal = { kind: 'uid', value: '501' } as const;
const guest = { accountId: 'guest', isCustodian: false };
const custodian = { accountId: 'custodian', isCustodian: true };
const machineTarget = { serverId: 'server', machineId: 'machine', installationId: 'install' };

function fixture(ports: Partial<Pick<ProcessActionExecutorInput, 'stopOwner' | 'prepareKill' | 'terminateDetected' | 'closeTerminal' | 'onRootEnded'>> = {},
    native?: Readonly<{ beforeVerification(): Promise<void>; onCensusRead?(): void }>) {
    let now = 100_000;
    let available = true;
    let visible = false;
    const partial: { pid: number; missing: string[] }[] = [];
    const censusRows: number[] = [];
    const censusArgs: string[][] = [];
    const owner = { kind: 'session', sessionId: 'guest-session' } as const;
    const row = (pid: number, ppid: number, ownerTag?: string): ProcessCensusRow => ({
        pid, ppid, pgid: pid, start: { startTimeMs: pid * 10, native: `darwin-proc:${pid}:0:${pid}` },
        principal, name: 'tool', memory: { bytes: pid * 100, kind: 'rss' }, cpuTimeUs: 0,
        argv: ['tool'], ...(ownerTag ? { ownerTag } : {}),
    });
    const rows = new Map<number, ProcessCensusRow>([
        [process.pid, row(process.pid, 1)], [30, row(30, 1, `v1.${scope}.session.guest-session`)],
        [20, row(20, 30, `v1.${scope}.session.guest-session`)],
        [21, row(21, 20, `v1.${scope}.session.guest-session`)],
        [40, row(40, 1)],
    ]);
    const roots: HappierProcessRoot[] = [
        { owner: { kind: 'happier' }, pid: process.pid, start: rows.get(process.pid)!.start, live: true, ownerCreatedAtMs: 0 },
        { owner, pid: 30, start: rows.get(30)!.start, live: true, ownerCreatedAtMs: 0,
            requesterWorkAttributionV1: { ...machineTarget, accountId: 'guest' } },
    ];
    // Native helper reads, clock and signals are the only substituted system boundaries.
    const censusDependencies: ProcessCensusDependencies = { platform: 'darwin', selfPid: process.pid,
        helperExecutablePath: '/fixture/helper', now: () => now,
        async execFile(_file, args) {
            if (!available) throw new Error('native read unavailable');
            censusArgs.push([...args]);
            censusRows.push(rows.size);
            native?.onCensusRead?.();
            return { stdout: JSON.stringify({ v: 1, capturedAtMs: now, logicalCpus: 4, rows: [...rows.values()], partial }) };
        },
    };
    const ownership = createProcessOwnershipRuntime({ platform: 'darwin', selfPid: process.pid, daemonScopeKey: scope,
        listRoots: () => roots, censusDependencies });
    const tracker = createLeftBehindTracker();
    const signals: number[] = [];
    const requesterForOwner = (value: ProcessOwnerRef, currentRoots: readonly HappierProcessRoot[]) =>
        resolveProcessOwnerRequester(value, currentRoots, { target: machineTarget, custodianAccountId: custodian.accountId });
    const executor = createProcessActionExecutor({ ownership, leftBehind: tracker, platform: 'darwin', selfPid: process.pid,
        allProcessesVisible: () => visible, requesterForOwner,
        systemBoundary: { platform: 'darwin', censusDependencies, kill(pid) { signals.push(pid); if (!native) rows.delete(pid); },
            async wait() { if (native) { await native.beforeVerification(); for (const pid of signals) rows.delete(pid); } } }, ...ports,
    });
    const target = (pid: number) => ({ ref: processRef(pid, rows.get(pid)!.start), expect: { level: 'proven' as const, owner } });
    return { executor, rows, roots, ownership, tracker, signals, target, row, owner, partial, censusRows, censusArgs,
        advance: (ms: number) => { now += ms; }, setVisible: (value: boolean) => { visible = value; },
        setAvailable: (value: boolean) => { available = value; } };
}

describe('process Actions through the canonical ownership and tree owners', () => {
    it('settles Kill tree from native absence while terminal PIDs await reaping', async () => {
        const f = fixture({ closeTerminal: async () => {
            for (const pid of [30, 20, 21]) f.rows.set(pid, { ...f.rows.get(pid)!, state: 'zombie', ownerTag: undefined });
            f.roots.splice(1, 1);
            return { ok: true };
        } });
        const owner = { kind: 'terminal', terminalId: 'terminal' } as const;
        f.roots[1] = { ...f.roots[1]!, owner };
        for (const pid of [30, 20, 21]) f.rows.set(pid, { ...f.rows.get(pid)!, ownerTag: `v1.${scope}.terminal.terminal` });
        expect(await f.executor.executeKill({ machineId: 'machine', tree: true,
            targets: [{ ref: f.target(30).ref, expect: { level: 'proven', owner } }] }, custodian))
            .toMatchObject({ status: 'ended', outcomes: [{ outcome: 'ended', freedBytes: 7100 }] });
        expect(f.signals).toEqual([]);
    });

    it('refuses an ordinary process tree containing an admitted native service before any signal', async () => {
        const containerId = 'a'.repeat(64);
        const killed = new Set<number>();
        const signals: number[] = [];
        const procfs = () => localServiceProcfsFixture([
            { pid: 30 },
            { pid: 20, ppid: 30, cgroup: `0::/system.slice/docker-${containerId}.scope` },
            { pid: 21, ppid: 20, cgroup: `0::/system.slice/docker-${containerId}.scope` },
        ].filter(row => !killed.has(row.pid)));
        const censusDependencies: ProcessCensusDependencies = { platform: 'linux', linuxBoundary: {
            readdir: path => procfs().readdir(path), readFile: path => procfs().readFile(path), readlink: path => procfs().readlink(path),
        } };
        const ownership = createProcessOwnershipRuntime({ platform: 'linux', daemonScopeKey: scope, censusDependencies,
            listRoots: snapshot => listHappierProcessRoots({ snapshot, platform: 'linux',
                trackedSessions: [{ pid: 30, happySessionId: 'ordinary',
                    processStartTimeMs: snapshot.rows.find(row => row.pid === 30)?.start.startTimeMs }],
                nativeContainers: [{ pid: 20, owner: { kind: 'container', serverId: 'home', machineId: 'machine',
                    serviceId: 'production/web', containerId, composeProject: 'production', composeService: 'web', environmentId: 'environment' } }] }) });
        const read = await ownership.readOwners({ freshness: 'fresh' });
        if (read.status !== 'ok') throw new Error('Expected readable native process identities');
        expect(read.rows.find(row => row.pid === 20)?.owner?.kind).toBe('container');
        const session = read.rows.find(row => row.pid === 30)!;
        const executor = createProcessActionExecutor({ ownership, leftBehind: createLeftBehindTracker(), platform: 'linux',
            requesterForOwner: () => null, allProcessesVisible: () => true,
            systemBoundary: { platform: 'linux', censusDependencies, kill(pid) { signals.push(pid); killed.add(pid); }, wait: async () => {} } });
        expect(await executor.executeKill({ machineId: 'machine', tree: true, targets: [{ ref: processRef(session.pid, session.start),
            expect: { level: 'proven', owner: { kind: 'session', sessionId: 'ordinary' } } }] }, custodian))
            .toMatchObject({ status: 'refused', outcomes: [{ reasonCode: 'native_service_control_required' }] });
        const native = read.rows.find(row => row.pid === 20)!;
        const nativeTarget = { ref: processRef(native.pid, native.start), expect: { level: 'proven' as const, owner: native.owner! } };
        expect(await executor.executeStop({ machineId: 'machine', targets: [nativeTarget] }, custodian))
            .toMatchObject({ status: 'refused', outcomes: [{ reasonCode: 'native_service_control_required' }] });
        expect(await executor.executeKill({ machineId: 'machine', tree: false, targets: [nativeTarget] }, custodian))
            .toMatchObject({ status: 'refused', outcomes: [{ reasonCode: 'native_service_control_required' }] });
        expect(await executor.executeStop({ machineId: 'machine', targets: [{ ref: processRef(session.pid, session.start),
            expect: { level: 'proven', owner: { kind: 'session', sessionId: 'ordinary' } } }] }, custodian))
            .toMatchObject({ status: 'refused', outcomes: [{ reasonCode: 'native_service_control_required' }] });
        expect(signals).toEqual([]);
    });

    it('answers Session Start again from identity-only custody while retaining requester and generation checks', async () => {
        const f = fixture();
        const ref = f.target(30).ref;
        expect(await f.executor.startAgain({ machineId: 'machine', ref }, guest)).toEqual({ status: 'already_wakes_on_next_message' });
        // A Session no-op needs neither commands/environment nor resource observations.
        expect(f.censusArgs).toHaveLength(1);
        expect(f.censusArgs[0]).toContain('--identity-only=true');
        expect(await f.executor.startAgain({ machineId: 'machine', ref }, { accountId: 'peer', isCustodian: false }))
            .toMatchObject({ status: 'refused', reasonCode: 'access_denied' });
        f.roots[1] = { ...f.roots[1], start: { startTimeMs: 999 } };
        expect(await f.executor.startAgain({ machineId: 'machine', ref }, guest))
            .toMatchObject({ status: 'refused', reasonCode: 'access_denied' });
        expect(f.signals).toEqual([]);
    });

    it('keeps Resume behind native kill verification and gives concurrent Stop callers their real coalesced acknowledgement', async () => {
        const signalled = createDeferred();
        const releaseNative = createDeferred();
        const sessions = new Map<SessionTrackingKey, TrackedSession>();
        const barrier = createDisconnectedTerminalHostResumeLifecycle({ unresolvedTerminalHostSessionIds: new Set(),
            clearUnresolvedTerminalHostSession() {}, findDisconnectedCandidate: () => null,
            resolveResumeGateForCandidate: async () => { throw new Error('No disconnected host in this fixture'); }, retireCandidate() {} });
        const respawn = createSessionRunnerRespawnManager({ enabled: true, maxRestarts: 2, baseDelayMs: 0, maxDelayMs: 0,
            jitterMs: 0, random: () => 0, isSessionAlreadyRunning: () => false,
            spawnSession: async () => { throw new Error('Intentional kill must not respawn'); }, logDebug() {}, logWarn() {} });
        const stopCore = createStopSession({ trackedSessionsByKey: sessions,
            readHostAttachmentState: async () => ({ status: 'absent' }), readTerminalAttachmentInfo: async () => null });
        let writes = 0;
        const lifecycle = createSessionProcessActionLifecycle({ trackedSessionsByKey: sessions,
            markStopRequested: respawn.markStopRequested,
            // Metadata transport is outside the process owner; exact binding and lifecycle stay real.
            prepareStopIntent: async () => { writes++; }, stopSession: stopCore,
            registerPhysicalStopEffect: (sessionId, completion) => barrier.registerPhysicalStopEffect(sessionId, completion),
        });
        const f = fixture({ prepareKill: input => lifecycle.prepareKill(input) }, { beforeVerification: async () => {
            signalled.resolve(); await releaseNative.promise; sessions.delete(legacyPidSessionTrackingKey(30));
        } });
        sessions.set(legacyPidSessionTrackingKey(30), { trackingKey: legacyPidSessionTrackingKey(30), pid: 30, processStartTimeMs: 300, startedBy: 'daemon', happySessionId: 'guest-session',
            vendorResumeId: 'guest-vendor', spawnOptions: { directory: '/repo' } });
        const killing = f.executor.executeKill({ machineId: 'machine', targets: [f.target(30)], tree: false }, guest,
            { actionContext: { surface: 'cli', authority: 'present_user', actionRequestId: 'intentional-kill' } });
        let replacementStarted = false;
        let stops = 0;
        try {
            await signalled.promise;
            const resume = barrier.resolveResumePreGate('guest-session').then(() => { replacementStarted = true; });
            const stop = () => barrier.runStop('guest-session', async () => { stops++; return { stopResult: await stopCore('guest-session') }; });
            const stopping = [stop(), stop()];
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(replacementStarted, 'Metadata is persisted and a signal sent, but physical verification is still pending').toBe(false);
            expect(stops).toBe(0);
            expect(writes, 'Repeated native signal checks must not reauthor the Stop attempt').toBe(1);
            releaseNative.resolve();
            expect(await killing).toMatchObject({ status: 'ended' });
            await resume;
            expect(await Promise.all(stopping)).toEqual([{ status: 'not_found' }, { status: 'not_found' }]);
            expect(stops).toBe(1);
        } finally { releaseNative.resolve(); await killing; }
    });

    it('refuses a reused PID and a changed owner without signalling either generation', async () => {
        const f = fixture();
        const target = f.target(20);
        f.rows.set(20, { ...f.rows.get(20)!, start: { startTimeMs: 201, native: 'darwin-proc:20:0:201' } });
        expect(await f.executor.executeKill({ machineId: 'machine', targets: [target], tree: false }, custodian))
            .toMatchObject({ status: 'refused', outcomes: [{ outcome: 'refused', reasonCode: 'identity_changed' }] });
        f.rows.set(20, { ...f.rows.get(20)!, start: { startTimeMs: 200, native: 'darwin-proc:20:0:20' },
            ppid: 1, ownerTag: `v1.${scope}.happier.daemon` });
        expect(await f.executor.executeKill({ machineId: 'machine', targets: [target], tree: false }, custodian))
            .toMatchObject({ status: 'refused', outcomes: [{ reasonCode: 'expectation_changed' }] });
        expect(f.signals).toEqual([]);
    });

    it('allows the custodian to end a guest-owned process but not another recipient', async () => {
        const f = fixture();
        const input = { machineId: 'machine', targets: [f.target(20)], tree: false };
        expect(await f.executor.executeKill(input, { accountId: 'different-guest', isCustodian: false }))
            .toMatchObject({ status: 'refused', outcomes: [{ reasonCode: 'access_denied' }] });
        expect(await f.executor.executeKill(input, custodian))
            .toMatchObject({ status: 'ended', outcomes: [{ outcome: 'ended', freedBytes: 2000 }] });
        expect(f.rows.has(21)).toBe(true);
        expect(f.signals).toEqual([20]);
    });

    it('refuses a tree containing another recipient and protects the daemon itself', async () => {
        const f = fixture();
        f.rows.set(21, { ...f.rows.get(21)!, ownerTag: `v1.${scope}.session.peer` });
        f.roots.push({ owner: { kind: 'session', sessionId: 'peer' }, pid: 21, start: f.rows.get(21)!.start,
            live: true, ownerCreatedAtMs: 0, requesterWorkAttributionV1: { ...machineTarget, accountId: 'peer' } });
        expect(await f.executor.executeKill({ machineId: 'machine', targets: [f.target(20)], tree: true }, guest))
            .toMatchObject({ status: 'refused', outcomes: [{ reasonCode: 'access_denied' }] });
        expect(await f.executor.executeKill({ machineId: 'machine', targets: [{ ref: processRef(process.pid, f.rows.get(process.pid)!.start),
            expect: { level: 'proven', owner: { kind: 'happier' } } }], tree: false }, custodian))
            .toMatchObject({ status: 'refused', outcomes: [{ reasonCode: 'protected_process' }] });
        expect(f.signals).toEqual([]);
    });

    it('allows only a custodian single-process Not Happier kill with the one policy enabled', async () => {
        const f = fixture();
        const target = { ref: processRef(40, f.rows.get(40)!.start), expect: { level: 'not_happier' as const } };
        const input = { machineId: 'machine', targets: [target], tree: false };
        expect((await f.executor.executeKill(input, custodian)).status).toBe('refused');
        f.setVisible(true);
        expect((await f.executor.executeKill({ ...input, tree: true }, custodian)).status).toBe('refused');
        expect((await f.executor.executeKill(input, guest)).status).toBe('refused');
        expect((await f.executor.executeKill(input, custodian)).status).toBe('ended');
        expect(f.signals).toEqual([40]);
    });

    it('cleans only echoed confirmed refs and reports a restarted member as skipped', async () => {
        const f = fixture();
        f.rows.set(22, f.row(22, 20, `v1.${scope}.session.guest-session`));
        f.roots[1] = { ...f.roots[1]!, live: false };
        f.rows.delete(30);
        const first = await f.ownership.readOwners({ freshness: 'fresh' });
        if (first.status !== 'ok') throw new Error('fixture unavailable');
        f.tracker.observe({ status: 'ok', capturedAtMs: first.snapshot.capturedAtMs, rows: first.rows });
        f.advance(60_000);
        const second = await f.ownership.readOwners({ freshness: 'fresh' });
        if (second.status !== 'ok') throw new Error('fixture unavailable');
        f.tracker.observe({ status: 'ok', capturedAtMs: second.snapshot.capturedAtMs, rows: second.rows });
        const [selected, restarted] = [20, 21].map(pid => f.tracker.confirmed().find(item => item.pid === pid)!);
        f.rows.set(21, { ...f.rows.get(21)!, start: { startTimeMs: 999, native: 'darwin-proc:21:0:999' } });
        const result = await f.executor.cleanUp({ machineId: 'machine', refs: [selected!.ref, restarted!.ref] }, custodian);
        expect(result).toEqual({ ended: [{ ref: selected!.ref, freedBytes: 2000 }],
            skipped: [{ ref: restarted!.ref, reason: 'identity_changed' }] });
        expect(f.signals).toEqual([20]);
        expect(f.rows.has(21)).toBe(true);
        expect(f.rows.has(22)).toBe(true);
    });

    it('reports unreadable facts and local cancellation as refusal rather than success or signals', async () => {
        const f = fixture();
        const input = { machineId: 'machine', targets: [f.target(20)], tree: true };
        f.setAvailable(false);
        expect((await f.executor.executeKill(input, custodian)).status).toBe('refused');
        f.setAvailable(true); f.advance(60_000);
        const controller = new AbortController(); controller.abort();
        expect((await f.executor.executeKill(input, custodian, { signal: controller.signal })).status).toBe('refused');
        expect(f.signals).toEqual([]);
    });

    it('discovers and authorizes a child born after the initial Kill census', async () => {
        const f = fixture({ prepareKill: async () => {
            f.rows.set(22, f.row(22, 20, `v1.${scope}.session.guest-session`));
            return async () => true;
        } });
        expect(await f.executor.executeKill({ machineId: 'machine', targets: [f.target(20)], tree: true }, guest))
            .toMatchObject({ status: 'ended', outcomes: [{ outcome: 'ended', freedBytes: 6300 }] });
        expect(f.signals).toEqual([22, 21, 20]);
    });

    it('refuses newly discovered tree members belonging to another recipient before any signal', async () => {
        const f = fixture({ prepareKill: async () => {
            f.rows.set(22, f.row(22, 20, `v1.${scope}.session.peer`));
            f.roots.push({ owner: { kind: 'session', sessionId: 'peer' }, pid: 22,
                start: f.rows.get(22)!.start, live: true, ownerCreatedAtMs: 0,
                requesterWorkAttributionV1: { ...machineTarget, accountId: 'peer' } });
            return async () => true;
        } });
        expect((await f.executor.executeKill({ machineId: 'machine', targets: [f.target(20)], tree: true }, guest)).status).toBe('refused');
        expect(f.signals).toEqual([]);
    });

    it('requires the lifetime intent guard for a newly discovered declared session root before signalling the tree', async () => {
        const f = fixture({ prepareKill: async ({ targets }) => {
            if (targets.some(target => target.pid === 22)) return null;
            f.rows.set(22, f.row(22, 20, `v1.${scope}.session.peer`));
            f.roots.push({ owner: { kind: 'session', sessionId: 'peer' }, pid: 22,
                start: f.rows.get(22)!.start, live: true, ownerCreatedAtMs: 0,
                requesterWorkAttributionV1: { ...machineTarget, accountId: 'peer' } });
            return async () => true;
        } });
        expect((await f.executor.executeKill({ machineId: 'machine', targets: [f.target(20)], tree: true }, custodian)).status).toBe('refused');
        expect(f.signals).toEqual([]);
    });

    it('counts a root ended through its lifecycle as ended, not gone before, including ended tree members', async () => {
        const f = fixture({ stopOwner: async () => { f.rows.delete(30); f.rows.delete(20); f.rows.delete(21); return true; } });
        expect(await f.executor.executeKill({ machineId: 'machine', targets: [f.target(30)], tree: true }, guest))
            .toMatchObject({ status: 'ended', outcomes: [{ outcome: 'ended', freedBytes: 7100 }] });
        expect(f.signals).toEqual([]);
    });

    it('keeps a single-process session Kill from invoking the tree-wide gentle lifecycle', async () => {
        let stopped = false;
        const f = fixture({ stopOwner: async () => { stopped = true; f.rows.delete(30); f.rows.delete(20); f.rows.delete(21); return true; } });
        expect(await f.executor.executeKill({ machineId: 'machine', targets: [f.target(30)], tree: false }, guest))
            .toMatchObject({ status: 'ended', outcomes: [{ outcome: 'ended', freedBytes: 3000 }] });
        expect(stopped).toBe(false);
        expect(f.rows.has(20)).toBe(true);
        expect(f.rows.has(21)).toBe(true);
    });

    it('rechecks exact Stop facts immediately before the lifecycle port and does not report failed lifecycle stops as ended', async () => {
        let called = false;
        const f = fixture({ stopOwner: async () => { called = true; f.rows.delete(30); return false; } });
        const target = f.target(30);
        expect(await f.executor.executeStop({ machineId: 'machine', targets: [target] }, guest))
            .toMatchObject({ status: 'refused', outcomes: [{ reasonCode: 'termination_failed' }] });
        expect(called).toBe(true);
        called = false;
        const g = fixture({ stopOwner: async () => { called = true; return true; } });
        const old = g.target(30);
        g.rows.set(30, { ...g.rows.get(30)!, start: { startTimeMs: 999 } });
        const response = await g.executor.executeStop({ machineId: 'machine', targets: [old] }, guest, {
        });
        expect(response.status).toBe('refused');
        expect(called).toBe(false);
    });

    it('does not native-kill an autorestarting helper while its lifetime stop is unavailable', async () => {
        const f = fixture();
        const owner = { kind: 'happier', component: 'workspace_sync' } as const;
        f.rows.set(50, f.row(50, process.pid, `v1.${scope}.happier.workspace_sync`));
        f.roots.push({ owner, pid: 50, start: f.rows.get(50)!.start, live: true, ownerCreatedAtMs: 0 });
        expect(await f.executor.executeKill({ machineId: 'machine', tree: false,
            targets: [{ ref: processRef(50, f.rows.get(50)!.start), expect: { level: 'proven', owner } }] }, custodian))
            .toMatchObject({ status: 'refused', outcomes: [{ reasonCode: 'lifecycle_unavailable' }] });
        expect(f.signals).toEqual([]);
    });

    it('requires tree scope for a helper lifetime that affects its descendants', async () => {
        const f = fixture();
        const owner = { kind: 'happier', component: 'workspace_sync' } as const;
        f.rows.set(50, f.row(50, process.pid, `v1.${scope}.happier.workspace_sync`));
        f.rows.set(51, f.row(51, 50, `v1.${scope}.happier.workspace_sync`));
        f.roots.push({ owner, pid: 50, start: f.rows.get(50)!.start, live: true, ownerCreatedAtMs: 0,
            stop() { f.rows.delete(50); f.rows.delete(51); } });
        const targets = [{ ref: processRef(50, f.rows.get(50)!.start), expect: { level: 'proven' as const, owner } }];
        expect(await f.executor.executeKill({ machineId: 'machine', tree: false, targets }, custodian))
            .toMatchObject({ status: 'refused', outcomes: [{ reasonCode: 'requires_tree' }] });
        expect(f.rows.has(50)).toBe(true);
        expect(await f.executor.executeKill({ machineId: 'machine', tree: true, targets }, custodian))
            .toMatchObject({ status: 'ended', outcomes: [{ outcome: 'ended', freedBytes: 10100 }] });
        expect(f.signals).toEqual([]);
    });

    it('uses only a fresh pre-effect and post-effect census for Stop on a 3,000-process host', async () => {
        const f = fixture({ stopOwner: async () => { f.rows.delete(30); return true; } });
        for (let offset = 0; offset < 3000; offset++) {
            const pid = process.pid + 1_000_000 + offset;
            f.rows.set(pid, f.row(pid, 1));
        }
        const processCount = f.rows.size;
        expect(await f.executor.executeStop({ machineId: 'machine', targets: [f.target(30)] }, guest))
            .toMatchObject({ status: 'ended', outcomes: [{ outcome: 'ended', freedBytes: 3000 }] });
        expect(f.signals).toEqual([]);
        const cost = { inventoryPasses: f.censusRows.length, cumulativeRows: f.censusRows.reduce((sum, count) => sum + count, 0) };
        console.info(JSON.stringify({ phase: 'owner_stop_census', processCount, ...cost }));
        expect(cost).toEqual({ inventoryPasses: 2, cumulativeRows: processCount * 2 - 1 });
    });

    it('finishes admitted Stop with one authorization after revoke during census and refuses the next request', async () => {
        let current = true;
        let stopped = false;
        let verifications = 0;
        const f = fixture(createProcessActionOwnerAdapters({}), {
            beforeVerification: async () => {}, onCensusRead: () => { current = false; },
        });
        f.roots[1] = { ...f.roots[1]!, stop: async () => { stopped = true; f.rows.delete(30); return true; } };
        const pass = createLeftBehindPass({ processOwnershipRuntime: f.ownership });
        const sampler = createMachineVitalsSampler({ readers: { read: async () => ({ state: 'unavailable', reason: 'helper_missing' }) },
            historyStore: { read: async () => [], append: async () => true, prune: async () => undefined,
                appendAlert: async () => undefined, minutes: () => [], alerts: () => [] } });
        const view = createMachineProcessesView({ processOwnershipRuntime: f.ownership, leftBehind: pass, machineVitals: sampler,
            platform: 'darwin', allProcessesVisible: () => false, requesterForOwner: () => ({ accountId: guest.accountId }) });
        const manager = new RpcHandlerManager({ scopePrefix: machineTarget.machineId, localMachineId: machineTarget.machineId,
            encryptionMode: 'plain', logger: () => {}, authorizeRequest: request => authorizeMachineRpcRequest(request, {
                machineId: machineTarget.machineId, resolveCustodianAccountId: async () => custodian.accountId,
                resolveInstallationId: () => machineTarget.installationId,
                // Home currentness and the fixture's native census/stop are system boundaries.
                verifyMachineAdmission: async () => { verifications++; return current; },
            }) });
        registerDaemonProcessesRpcHandlers(manager, { view, actions: f.executor,
            target: () => ({ ...machineTarget, custodianAccountId: custodian.accountId }) });
        const request = { method: `${machineTarget.machineId}:${RPC_METHODS.MACHINES_PROCESSES_STOP}`,
            params: { machineId: machineTarget.machineId, targets: [f.target(30)] }, callerAuthority: 'present_user' as const,
            machineAdmission: { machineId: machineTarget.machineId, installationId: machineTarget.installationId, custodianAccountId: custodian.accountId,
                actorAccountId: guest.accountId, role: 'use' as const, encryptionMode: 'plain' as const } };
        try {
            expect(await manager.handleRequest(request)).toMatchObject({ status: 'ended', outcomes: [{ outcome: 'ended', freedBytes: 3000 }] });
            expect(stopped).toBe(true);
            expect(f.rows.has(30)).toBe(false);
            expect(verifications).toBe(1);
            expect(await manager.handleRequest(request)).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
            expect(verifications).toBe(2);
        } finally { view.dispose(); pass.dispose(); await sampler.stop(); }
    });

    it('counts ended owned members in a Stop receipt while excluding a surviving child', async () => {
        const f = fixture(createProcessActionOwnerAdapters({}));
        // The root's native stop boundary updates the same OS census consumed by
        // the real lifecycle adapter, ownership runtime and receipt owner.
        f.roots[1] = { ...f.roots[1]!, stop: async () => {
            f.rows.delete(30); f.rows.delete(20); f.rows.delete(40); return true;
        } };
        expect(await f.executor.executeStop({ machineId: 'machine', targets: [f.target(30)] }, guest))
            .toMatchObject({ status: 'ended', outcomes: [{ outcome: 'ended', freedBytes: 5000 }] });
        expect(f.rows.has(21)).toBe(true);
        expect(f.signals).toEqual([]);
    });

    it.each(['restarted', 'unreadable'] as const)('uses admitted memory and exact end evidence for a %s member', async state => {
        const f = fixture(createProcessActionOwnerAdapters({}));
        f.roots[1] = { ...f.roots[1]!, stop: async () => {
            f.rows.delete(30);
            if (state === 'restarted') f.rows.set(20, { ...f.rows.get(20)!, start: { startTimeMs: 999, native: 'darwin-proc:20:0:999' }, memory: { bytes: 99_999, kind: 'rss' } });
            else { f.rows.delete(20); f.partial.push({ pid: 20, missing: ['start'] }); }
            return true;
        } };
        expect(await f.executor.executeStop({ machineId: 'machine', targets: [f.target(30)] }, guest))
            .toMatchObject({ status: 'ended', outcomes: [{ outcome: 'ended', freedBytes: state === 'restarted' ? 5000 : 3000 }] });
        expect(f.rows.has(21)).toBe(true);
        expect(f.signals).toEqual([]);
    });

    it('retains an ended root only after successful Stop and fresh exact-generation absence, preserving its Start declaration', async () => {
        const retained: HappierProcessRoot[] = [];
        let mode: 'denied' | 'running' | 'ended' = 'denied';
        const f = fixture({
            stopOwner: async () => { if (mode === 'denied') return { status: 'denied' }; if (mode === 'ended') f.rows.delete(30); return true; },
            onRootEnded(root) {
                const ended = { ...root, live: false };
                retained.push(ended);
                f.roots.splice(f.roots.indexOf(root), 1, ended);
            },
        });
        f.roots[1] = { ...f.roots[1]!, owner: { kind: 'service', serviceId: 'svc' },
            async startAgain() { f.rows.set(30, { ...f.row(30, 1), start: { startTimeMs: 999 } }); return { status: 'started' }; } };
        f.rows.set(30, f.row(30, 1, `v1.${scope}.service.svc`));
        const target = { ref: processRef(30, f.rows.get(30)!.start), expect: { level: 'proven' as const, owner: f.roots[1]!.owner } };
        expect((await f.executor.executeStop({ machineId: 'machine', targets: [target] }, guest)).status).toBe('refused');
        expect(retained).toEqual([]);
        mode = 'running';
        expect((await f.executor.executeStop({ machineId: 'machine', targets: [target] }, guest)).outcomes[0]!.outcome).toBe('survived');
        expect(retained).toEqual([]);
        mode = 'ended';
        expect((await f.executor.executeStop({ machineId: 'machine', targets: [target] }, guest)).status).toBe('ended');
        expect(retained).toHaveLength(1);
        expect(retained[0]!.live).toBe(false);
        expect(await retained[0]!.startAgain!({})).toEqual({ status: 'started' });
        expect(f.rows.get(30)!.start.startTimeMs).toBe(999);
    });

    it('publishes an exact root ended by native Kill and retains its original Start callback', async () => {
        const retained: HappierProcessRoot[] = [];
        const f = fixture({ onRootEnded(root) { retained.push({ ...root, live: false }); } });
        f.roots[1] = { ...f.roots[1]!, owner: { kind: 'browser_sidecar' }, async startAgain() { return { status: 'started' }; } };
        f.rows.set(30, f.row(30, 1, `v1.${scope}.browser_sidecar`));
        const target = { ref: processRef(30, f.rows.get(30)!.start), expect: { level: 'proven' as const, owner: f.roots[1]!.owner } };
        expect((await f.executor.executeKill({ machineId: 'machine', tree: false, targets: [target] }, custodian)).status).toBe('ended');
        expect(retained).toHaveLength(1);
        expect(await retained[0]!.startAgain!({})).toEqual({ status: 'started' });
    });

    it('does not turn an unreadable root in a partial post-Stop census into an ended fact', async () => {
        const retained: HappierProcessRoot[] = [];
        const f = fixture({ stopOwner: async () => { f.rows.delete(30); f.partial.push({ pid: 30, missing: ['start'] }); return true; },
            onRootEnded(root) { retained.push(root); } });
        expect(await f.executor.executeStop({ machineId: 'machine', targets: [f.target(30)] }, guest))
            .toMatchObject({ status: 'refused', outcomes: [{ reasonCode: 'termination_unverified' }] });
        expect(retained).toEqual([]);
    });
});
