import { describe, expect, it } from 'vitest';
import type { ProcessCensusRow } from '@/processes/census/processCensus';
import { listHappierProcessRoots } from './listHappierProcessRoots';
import { buildCgroupProcessLaunchSpec } from '@/daemon/platform/linux/buildCgroupSelfMigratingHappyCliLaunchSpec';
import { createHappierLinuxScopeName } from '@/daemon/platform/linux/systemdUserResourceGovernor';
import { resolveProcessOwnership } from '../ownership/resolveProcessOwnership';
import { createTerminalProcessRegistry } from '@/daemon/local/services/inventory/terminalRegistry';
import { createTerminalPtySessionManager } from '@/terminal/pty/sessions';
import type { ProcessActionExecution } from '../actions/processActionExecutor';
import type { MachineProcessesStartAgainResultV1 } from '@happier-dev/protocol/machines/processes/machineProcessesV1';

const principal = { kind: 'uid', value: '1000' } as const;
const scope = '123456789abc';
const row = (pid: number, ppid: number, tag?: string): ProcessCensusRow => ({
    pid, ppid, start: { startTimeMs: pid * 10 }, principal, name: 'node', ownerTag: tag,
    memory: null, cpuTimeUs: null,
});
const snapshot = (rows: readonly ProcessCensusRow[]) => ({ status: 'ok' as const, rows, logicalCpus: 4, capturedAtMs: 11000 });

describe('listHappierProcessRoots', () => {
    it.each(['systemd', 'cgroup'] as const)('joins a fresh %s launch unit to the canonical Session without inventing a Session launch identity', (kind) => {
        const unit = createHappierLinuxScopeName(`v1.${scope}.happier.daemon`)!;
        const spec = buildCgroupProcessLaunchSpec({ unit,
            scope: kind === 'systemd' ? { kind, systemdRunPath: '/usr/bin/systemd-run', transportEnvironment: {}, supportsEnvironmentExpansionOption: true }
                : { kind, baseDir: '/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service' },
            launchSpec: { filePath: '/runtime/happier', args: ['opencode'] } });
        const actualUnit = kind === 'systemd' ? spec.args.find(arg => arg.startsWith('--unit='))?.slice('--unit='.length)
            : spec.env?.HAPPIER_DAEMON_PROCESS_CGROUP_UNIT;
        expect(actualUnit).toBe(unit);
        const prefix = `/user.slice/user-1000.slice/user@1000.service/${kind === 'systemd' ? 'happier-jobs.slice/' : ''}${actualUnit}`;
        // The first qualified webhook binds the incumbent launch record, not its physical unit's encoded owner.
        const tracked = { pid: 20, happySessionId: 'canonical-fresh-session', processStartTimeMs: 200, linuxLaunchUnit: actualUnit };
        const observed = snapshot([row(10, 1), { ...row(20, 10), cgroup: `${prefix}/delegated-child` },
            { ...row(21, 1), cgroup: `${prefix}/detached-tool` }, { ...row(22, 1), cgroup: `${prefix}-unrelated` }]);
        const roots = listHappierProcessRoots({ snapshot: observed, selfPid: 10, daemonScopeKey: scope, platform: 'linux', trackedSessions: [tracked] });
        expect(roots.find(root => root.owner.kind === 'session')).toMatchObject({ owner: { sessionId: 'canonical-fresh-session' },
            live: true, start: { startTimeMs: 200 }, containment: { kind: 'linux_unit', prefix } });
        const ownership = resolveProcessOwnership({ snapshot: observed, roots, daemonPrincipal: principal, daemonScopeKey: scope, platform: 'linux' });
        expect(ownership.find(process => process.pid === 21)).toMatchObject({ owner: { kind: 'session', sessionId: 'canonical-fresh-session' }, level: 'proven' });
        expect(ownership.find(process => process.pid === 22)?.owner).not.toEqual({ kind: 'session', sessionId: 'canonical-fresh-session' });
    });
    it('requires launch custody, the exact runner birth, same principal and actual unit membership before lending a fresh-launch fence', () => {
        const unit = createHappierLinuxScopeName(`v1.${scope}.happier.daemon`)!;
        const prefix = `/user.slice/user-1000.slice/user@1000.service/${unit}`;
        const tracked = { pid: 20, happySessionId: 'fresh', processStartTimeMs: 200, linuxLaunchUnit: unit };
        const rootFor = (session = tracked, native = { ...row(20, 10), cgroup: prefix }) => listHappierProcessRoots({
            snapshot: snapshot([row(10, 1), native]), selfPid: 10, daemonScopeKey: scope, platform: 'linux', trackedSessions: [session],
        }).find(root => root.owner.kind === 'session');
        expect(rootFor()).toHaveProperty('containment', { kind: 'linux_unit', prefix });
        expect(rootFor(tracked, { ...row(20, 10), cgroup: '/user.slice/shared.service' })).not.toHaveProperty('containment');
        expect(rootFor(tracked, { ...row(20, 10), cgroup: `${prefix}-unrelated` })).not.toHaveProperty('containment');
        expect(rootFor(tracked, { ...row(20, 10), cgroup: prefix, start: { startTimeMs: 300 } })).not.toHaveProperty('containment');
        expect(rootFor(tracked, { ...row(20, 10), cgroup: prefix, principal: { kind: 'uid', value: '2000' } })).not.toHaveProperty('containment');
        const foreignUnit = createHappierLinuxScopeName('v1.aaaaaaaaaaaa.happier.daemon')!;
        expect(rootFor({ ...tracked, linuxLaunchUnit: foreignUnit }, { ...row(20, 10), cgroup: `/user.slice/${foreignUnit}` })).not.toHaveProperty('containment');
        const { processStartTimeMs: _start, ...unwitnessed } = tracked;
        expect(listHappierProcessRoots({ snapshot: snapshot([row(10, 1), { ...row(20, 10), cgroup: prefix }]), selfPid: 10,
            daemonScopeKey: scope, platform: 'linux', trackedSessions: [unwitnessed] }).find(root => root.owner.kind === 'session')).not.toHaveProperty('containment');
        expect(rootFor({ ...tracked, linuxLaunchUnit: '' })).not.toHaveProperty('containment');
    });
    it.each(['linux', 'darwin', 'win32'] as const)('joins promoted runner custody rather than borrowing the wrapper birth on %s', platform => {
        const unit = createHappierLinuxScopeName(`v1.${scope}.happier.daemon`)!;
        const prefix = `/user.slice/${unit}`;
        const tracked = { pid: 20, sessionRunnerPid: 21, happySessionId: 'fresh', processStartTimeMs: 200, linuxLaunchUnit: unit,
            runnerProcessIdentity: { pid: 21, processStartTimeMs: 210, processCommandHash: 'runner' } };
        const input = { snapshot: snapshot([row(10, 1), row(20, 10), { ...row(21, 20), cgroup: prefix }]), selfPid: 10,
            daemonScopeKey: scope, platform };
        const promoted = listHappierProcessRoots({ ...input, trackedSessions: [tracked] }).find(root => root.owner.kind === 'session');
        expect(promoted).toMatchObject({ pid: 21, start: { startTimeMs: 210 }, live: true });
        if (platform === 'linux') expect(promoted).toHaveProperty('containment', { kind: 'linux_unit', prefix });
        else expect(promoted).not.toHaveProperty('containment');
        expect(listHappierProcessRoots({ ...input, trackedSessions: [{ ...tracked, runnerProcessIdentity: { ...tracked.runnerProcessIdentity, pid: 22 } }] })
            .find(root => root.owner.kind === 'session')).not.toHaveProperty('containment');
    });
    it('projects the current tracked runner stopping fact only while its exact native generation is live', () => {
        const tracked = { pid: 20, happySessionId: 's1', processStartTimeMs: 200, stopRequestedAtMs: 10500 };
        const input = { selfPid: 10, daemonScopeKey: scope, platform: 'darwin' as const, trackedSessions: [tracked] };
        const live = listHappierProcessRoots({ ...input, snapshot: snapshot([row(10, 1), row(20, 10)]) });
        const stopping = live.find(root => root.owner.kind === 'session');
        expect(stopping).toMatchObject({ live: true, state: 'stopping' });
        const recycled = listHappierProcessRoots({ ...input, snapshot: snapshot([row(10, 1), { ...row(20, 10), start: { startTimeMs: 300 } }]) })
            .find(root => root.owner.kind === 'session');
        expect(recycled).toMatchObject({ live: false });
        expect(recycled).not.toHaveProperty('state');
        expect(listHappierProcessRoots({ ...input, trackedSessions: [{ ...tracked, stopRequestedAtMs: undefined }],
            snapshot: snapshot([row(10, 1), row(20, 10)]) }).find(root => root.owner.kind === 'session')).not.toHaveProperty('state');
        if (!stopping) throw new Error('Missing stopping root');
        expect(listHappierProcessRoots({ ...input, trackedSessions: [], snapshot: snapshot([row(10, 1)]),
            endedRoots: [{ ...stopping, live: false }] }).find(root => root.owner.kind === 'session')).not.toHaveProperty('state');
    });
    it('projects guest terminal attribution from the real PTY custody owner without an associated session', async () => {
        const terminalRegistry = createTerminalProcessRegistry();
        // Only the genuine OS PTY and process-group probe are replaced.
        const manager = createTerminalPtySessionManager({ terminalRegistry, platform: 'darwin', env: { ...process.env, SHELL: '/bin/bash' },
            probeProcessGroup: () => 'absent', ptyProvider: { spawn: () => ({ pid: 20, write() {}, resize() {}, kill() {},
                onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }) }) },
            config: { bufferMaxBytes: 1000000, bufferMaxEvents: 1000,
                bufferRetentionMs: 600000, urlParseBufferLimit: 32768, maxWriteChunkBytes: 16384, defaultCols: 80, defaultRows: 24 } });
        try {
            const opened = await manager.ensure({ terminalKey: 'guest-shell', cwd: '/project', custody: {
                serverId: 'server', machineId: 'machine', installationId: 'install', requesterAccountId: 'guest',
                workspaceRefId: 'accepted', projectKey: 'project', rootPath: '/project' } });
            if (!opened.ok) throw new Error('Guest terminal did not open');
            const roots = listHappierProcessRoots({ snapshot: snapshot([row(10, 1),
                row(20, 10, `v1.${scope}.terminal.${opened.terminalId}`)]), selfPid: 10, platform: 'darwin', daemonScopeKey: scope,
                terminalRegistry, terminalRequesterAttribution: terminalId => {
                    const custody = manager.getCustody(terminalId);
                    return custody ? { serverId: custody.serverId, machineId: custody.machineId,
                        installationId: custody.installationId, accountId: custody.requesterAccountId } : undefined;
                } });
            expect(roots.find(root => root.owner.kind === 'terminal')).toMatchObject({
                requesterWorkAttributionV1: { serverId: 'server', machineId: 'machine', installationId: 'install', accountId: 'guest' } });
        } finally { manager.dispose(); }
    });
    it('keeps original Start on the exact inferred helper generation and retained ended root, never a recycled PID', async () => {
        let running = false;
        const startAgain = async (execution: ProcessActionExecution): Promise<MachineProcessesStartAgainResultV1> => {
            if (!await execution.verifyCurrent?.()) return { status: 'refused' };
            running = true;
            return { status: 'started' };
        };
        const input = { snapshot: snapshot([row(10, 1), row(20, 10, `v1.${scope}.browser_sidecar.browser_sidecar`)]),
            selfPid: 10, daemonScopeKey: scope, platform: 'darwin' as const,
            helperProcesses: [{ owner: { kind: 'browser_sidecar' as const }, pid: 20, start: { startTimeMs: 200 }, startAgain }] };
        const projected = listHappierProcessRoots(input).find(root => root.pid === 20);
        if (!projected) throw new Error('Missing helper root');
        const ended = listHappierProcessRoots({ ...input, snapshot: snapshot([row(10, 1)]), helperProcesses: [],
            endedRoots: [{ ...projected, live: false }] }).find(root => root.pid === 20);
        expect(await ended?.startAgain?.({ verifyCurrent: async () => true })).toEqual({ status: 'started' });
        expect(running).toBe(true);
        running = false;
        expect(await projected.startAgain?.({ verifyCurrent: async () => false })).toEqual({ status: 'refused' });
        expect(running).toBe(false);
        const recycled = listHappierProcessRoots({ ...input, helperProcesses: [{ ...input.helperProcesses[0]!, start: { startTimeMs: 100 } }] })
            .find(root => root.pid === 20);
        expect(recycled?.startAgain).toBeUndefined();
    });
    it('retains admitted guest requester attribution across live and ended lifecycle root projection', () => {
        const requesterWorkAttributionV1 = { serverId: 'server', accountId: 'guest', machineId: 'machine', installationId: 'install' };
        const roots = listHappierProcessRoots({ snapshot: snapshot([row(10, 1), row(20, 10)]), selfPid: 10,
            daemonScopeKey: scope, platform: 'darwin', trackedSessions: [{ pid: 20, happySessionId: 'guest-session',
                processStartTimeMs: 200, requesterWorkAttributionV1 }] });
        const guest = roots.find(root => root.owner.kind === 'session');
        expect(guest).toMatchObject({ requesterWorkAttributionV1, live: true });
        if (!guest) throw new Error('Missing projected session root');
        const ended = listHappierProcessRoots({ snapshot: snapshot([row(10, 1)]), selfPid: 10,
            daemonScopeKey: scope, platform: 'darwin', endedRoots: [{ ...guest, live: false, endedAtMs: 12000 }] });
        expect(ended.find(root => root.owner.kind === 'session')).toMatchObject({ requesterWorkAttributionV1, live: false });
        expect(ended.find(root => root.owner.kind === 'happier')).not.toHaveProperty('requesterWorkAttributionV1');
    });
    it('keeps a launch owner stop handle across inferred helper projection only for that exact native generation', async () => {
        let stopped = false;
        const observed = snapshot([row(10, 1), row(20, 10, `v1.${scope}.browser_sidecar.browser_sidecar`)]);
        const input = { snapshot: observed, selfPid: 10, daemonScopeKey: scope, platform: 'linux' as const,
            helperProcesses: [{ owner: { kind: 'browser_sidecar' as const }, pid: 20, start: { startTimeMs: 200 },
                stop: () => { stopped = true; } }] };
        await listHappierProcessRoots(input).find(root => root.pid === 20)?.stop?.();
        expect(stopped).toBe(true);
        stopped = false;
        await listHappierProcessRoots({ ...input, helperProcesses: [{ ...input.helperProcesses[0]!, start: { startTimeMs: 100 } }] })
            .find(root => root.pid === 20)?.stop?.();
        expect(stopped).toBe(false);
    });
    it('requires current native instance markers before borrowing a service or run birth from a bare incumbent PID', () => {
        for (const kind of ['service', 'run'] as const) {
            const owner = kind === 'service' ? { kind, serviceId: 'i1' } : { kind, runId: 'i1' };
            const input = { selfPid: 10, daemonScopeKey: scope, platform: 'linux' as const, bootTimeMs: 10000,
                managedServices: [{ owner, pid: 20 }] };
            expect(listHappierProcessRoots({ ...input, snapshot: snapshot([row(10, 1), row(20, 1, `v1.${scope}.${kind}.i2`)]) })
                .some(root => root.owner.kind === kind)).toBe(false);
            expect(listHappierProcessRoots({ ...input, snapshot: snapshot([row(10, 1), row(20, 1, `v1.${scope}.${kind}.i1`)]) })
                .some(root => root.owner.kind === kind && root.live)).toBe(true);
        }
    });
    it('refuses recycled terminal registrations while accepting the incumbent native terminal tag', () => {
        const terminalRegistry = createTerminalProcessRegistry();
        terminalRegistry.registerTerminalProcesses({ terminalKey: 'one', terminalId: 't1', workspacePath: '/repo', pids: [20] });
        const input = { selfPid: 10, daemonScopeKey: scope, platform: 'linux' as const, bootTimeMs: 10000, terminalRegistry };
        expect(listHappierProcessRoots({ ...input, snapshot: snapshot([row(10, 1), row(20, 1, `v1.${scope}.terminal.t2`)]) })
            .some(root => root.owner.kind === 'terminal')).toBe(false);
        expect(listHappierProcessRoots({ ...input, snapshot: snapshot([row(10, 1), row(20, 1, `v1.${scope}.terminal.t1`)]) })
            .find(root => root.owner.kind === 'terminal')).toMatchObject({ owner: { terminalId: 't1' }, live: true });
    });
    it('accepts detached children born after the runner but before its first marker was persisted', () => {
        const observed = snapshot([row(10, 1), row(20, 10), row(21, 1, `v1.${scope}.session.s1`)]);
        const roots = listHappierProcessRoots({ snapshot: observed, selfPid: 10, daemonScopeKey: scope,
            platform: 'linux', bootTimeMs: 10000,
            trackedSessions: [{ pid: 20, happySessionId: 's1', processStartTimeMs: 200, ownerCreatedAtMs: 10500 }] });
        expect(resolveProcessOwnership({ snapshot: observed, roots, daemonPrincipal: principal,
            daemonScopeKey: scope, platform: 'linux' }).find(row => row.pid === 21)?.level).toBe('proven');
    });
    it('derives only fixed-domain previous-daemon helpers born before this daemon, while adopted incumbent roots stay live', () => {
        const old = row(5, 1, `v1.${scope}.browser_sidecar.browser_sidecar`);
        const foreign = row(6, 1, 'v1.aaaaaaaaaaaa.happier.voice_worker');
        const currentUnknown = row(20, 1, `v1.${scope}.happier.voice_worker`);
        const input = { snapshot: snapshot([row(10, 1), old, foreign, currentUnknown]), selfPid: 10,
            daemonScopeKey: scope, platform: 'linux' as const, bootTimeMs: 10000 };
        const roots = listHappierProcessRoots(input);
        expect(roots.find(root => root.pid === 5)).toMatchObject({ live: false, endedAtMs: 10100 });
        expect(roots.some(root => root.pid === 6 || root.pid === 20)).toBe(false);
        const adopted = listHappierProcessRoots({ ...input, helperProcesses: [{ owner: { kind: 'browser_sidecar' },
            pid: 5, start: old.start, live: true }] });
        expect(adopted.find(root => root.pid === 5)?.live).toBe(true);
    });
    it('keeps an old named helper ended when another generation of the same component is running', () => {
        const tag = `v1.${scope}.happier.voice_worker`;
        const observed = snapshot([row(10, 1), row(5, 1, tag), row(20, 10, tag)]);
        const roots = listHappierProcessRoots({ snapshot: observed, selfPid: 10,
            daemonScopeKey: scope, platform: 'linux', bootTimeMs: 10000 });
        const ownership = resolveProcessOwnership({ snapshot: observed, roots, daemonPrincipal: principal,
            daemonScopeKey: scope, platform: 'linux' });
        expect(ownership.find(row => row.pid === 5)).toMatchObject({ level: 'left_behind', ownerEnded: true });
        expect(ownership.find(row => row.pid === 20)).toMatchObject({ level: 'proven', ownerEnded: false });
    });
    it('projects named helper roots only under the live daemon generation, not inherited members or foreign tags', () => {
        const tag = `v1.${scope}.happier.voice_worker`;
        const roots = listHappierProcessRoots({ snapshot: snapshot([row(10, 1), row(20, 10, tag), row(30, 20, tag),
            row(40, 1, `v1.${scope}.happier.recording_encoder`), row(50, 10, 'v1.aaaaaaaaaaaa.happier.device_helper')]),
            selfPid: 10, daemonScopeKey: scope, platform: 'linux', bootTimeMs: 10000 });
        expect(roots.map(root => root.pid)).toEqual([10, 20]);
        expect(roots[1]).toMatchObject({ owner: { kind: 'happier', component: 'voice_worker' },
            ownerCreatedAtMs: 10200, ownerCreatedStartTimeMs: 200, live: true });
    });
    it('retains original owner creation across a resumed runner without letting ended evidence replace its live generation', () => {
        const roots = listHappierProcessRoots({ snapshot: snapshot([row(10, 1), row(20, 10)]), selfPid: 10,
            daemonScopeKey: scope, platform: 'linux', bootTimeMs: 10000,
            trackedSessions: [{ pid: 20, happySessionId: 's1', processStartTimeMs: 200, ownerCreatedAtMs: 10100 }],
            endedRoots: [{ owner: { kind: 'session', sessionId: 's1' }, pid: 20, processStartTimeMs: 200,
                ownerCreatedAtMs: 10100, live: false, endedAtMs: 11000 }] });
        expect(roots.find(root => root.owner.kind === 'session')).toMatchObject({ live: true,
            ownerCreatedAtMs: 10100, ownerCreatedStartTimeMs: 100 });
    });
});
