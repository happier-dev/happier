import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, readlink } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createProcessOwnershipRuntime } from './ownership/processOwnershipRuntime';
import { createEndOwnerRemainder } from './endOwnerRemainder';
import { readProcessCensus, type ProcessStartIdentity } from '@/processes/census/processCensus';
import type { ProcessCensusDependencies } from '@/processes/census/processCensus';
import { equalProcessStart, type HappierProcessRoot } from './ownership/types';
import { readTestProcessPid, spawnInlineNodeParentWithChild, waitForProcessExit } from '@/testkit/process/spawn';
import { createStopSession } from '../sessions/stopSession';
import { waitForTrackedRunnerProcessesExit } from '../sessions/waitForTrackedRunnerProcessesExit';
import { listHappierProcessRoots } from './roots/listHappierProcessRoots';
import { createLeftBehindPass } from './leftBehind/leftBehindPass';
import type { TrackedSession } from '../types';
import { formatProcessOwnerTag, resolveProcessOwnerScopeKey } from '@/processes/ownerTag';
import { spawn } from 'node:child_process';
import { createHappierLinuxScopeName } from '../platform/linux/systemdUserResourceGovernor';

it.skipIf(process.platform !== 'linux')('ends a fully departed owner without re-reading the whole machine to terminate nothing', async () => {
    const scope = '123456789abc';
    const owner = { kind: 'session', sessionId: `departed-${randomUUID()}` } as const;
    let wholeHostCensuses = 0;
    const censusDependencies: ProcessCensusDependencies = { platform: 'linux', linuxBoundary: {
        readFile, readlink,
        readdir: async (path: string) => { if (path === '/proc') wholeHostCensuses++; return await readdir(path); },
    } };
    const runtime = createProcessOwnershipRuntime({ daemonScopeKey: scope, censusDependencies,
        listRoots: snapshot => listHappierProcessRoots({ snapshot, daemonScopeKey: scope, trackedSessions: [], endedRoots: [] }) });
    const leftBehind = createLeftBehindPass({ processOwnershipRuntime: runtime });
    try {
        const remainder = createEndOwnerRemainder({ processOwnershipRuntime: runtime, daemonScopeKey: scope,
            retainEndedRoots: () => {}, firstPass: leftBehind.firstPass, systemBoundary: { censusDependencies } });
        expect(await remainder.end(owner)).toEqual({ status: 'complete', outcomes: [] });
        // One ownership view plus the left-behind pass; nothing to signal, so no terminator rounds.
        expect(wholeHostCensuses).toBe(2);
    } finally { leftBehind.dispose?.(); }
});

it.skipIf(process.platform !== 'linux').each([
    { evidence: 'fence', signalDenied: false }, { evidence: 'fence', signalDenied: true },
    { evidence: 'marker', signalDenied: false },
])('stops a detached native member with $evidence evidence (signal denied=$signalDenied)', async ({ evidence, signalDenied }) => {
    const scope = '123456789abc';
    const owner = { kind: 'session', sessionId: `detached-fence-stop-${randomUUID()}` } as const;
    const unit = createHappierLinuxScopeName(`v1.${scope}.session.${owner.sessionId}`)!;
    const prefix = `/user.slice/happier-jobs.slice/${unit}`;
    const ownerTag = `v1.${scope}.session.${owner.sessionId}`;
    const fixtureLifetimeMs = 20_000;
    const fixtureStartedAt = Date.now();
    // The intermediate exits before Stop. Fence-only children have an empty
    // environment; marker-only children have no constructed cgroup evidence.
    const parent = spawn(process.execPath, ['-e', `
        const result = require('node:child_process').spawnSync(process.execPath, ['-e', \`
            const child = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, ${fixtureLifetimeMs})'], {
                detached: true, stdio: 'ignore', env: ${JSON.stringify(evidence === 'marker' ? { HAPPIER_PROCESS_OWNER: ownerTag } : {})}
            });
            process.stdout.write(String(child.pid)); child.unref();
        \`], { encoding: 'utf8' });
        process.stdout.write(result.stdout + '\\n'); setTimeout(() => {}, ${fixtureLifetimeMs});
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    const nativeKill = process.kill.bind(process);
    let childIdentity: { pid: number; start: ProcessStartIdentity } | undefined;
    let leftBehind: ReturnType<typeof createLeftBehindPass> | undefined;
    try {
        const childPid = await readTestProcessPid(parent);
        const retained: HappierProcessRoot[] = [];
        const censusDependencies: ProcessCensusDependencies = { platform: 'linux', linuxBoundary: {
            readdir, readlink,
            async readFile(path, encoding) {
                const pid = Number(path.split('/')[2]);
                if (evidence === 'fence' && path.endsWith('/cgroup') && [parent.pid, childPid].includes(pid)) return `0::${prefix}\n`;
                return readFile(path, encoding);
            },
        } };
        const initial = await readProcessCensus({ freshness: 'fresh', scope: 'all' });
        if (initial.status !== 'ok') throw new Error('Native census unavailable');
        const root = initial.rows.find(row => row.pid === parent.pid)!;
        const child = initial.rows.find(row => row.pid === childPid)!;
        childIdentity = { pid: child.pid, start: child.start };
        expect(child.ppid).not.toBe(parent.pid);
        expect(child.ownerTag).toBe(evidence === 'marker' ? ownerTag : undefined);
        const tracked: TrackedSession = { pid: root.pid, processStartTimeMs: root.start.startTimeMs,
            happySessionId: owner.sessionId, startedBy: 'daemon', childProcess: parent, linuxLaunchUnit: unit };
        const sessions = new Map([[root.pid, tracked]]);
        const runtime = createProcessOwnershipRuntime({ daemonScopeKey: scope, censusDependencies,
            listRoots: snapshot => listHappierProcessRoots({ snapshot, daemonScopeKey: scope,
                trackedSessions: sessions.values(), endedRoots: retained }) });
        leftBehind = createLeftBehindPass({ processOwnershipRuntime: runtime });
        const remainder = createEndOwnerRemainder({ processOwnershipRuntime: runtime, daemonScopeKey: scope,
            retainEndedRoots: roots => { retained.push(...roots); }, firstPass: leftBehind.firstPass,
            systemBoundary: { censusDependencies,
                kill: (pid, signal) => signalDenied && pid === childPid ? true : nativeKill(pid, signal) } });
        const stop = createStopSession({ pidToTrackedSession: sessions, ownerRemainder: remainder,
            readHostAttachmentState: async () => ({ status: 'absent' }),
            areTrackedRunnersExited: async () => parent.exitCode !== null || parent.signalCode !== null,
            waitForTrackedRunnersExit: async () => waitForProcessExit(root.pid, { timeoutMs: 2000 }) });
        expect(await stop(owner.sessionId)).toEqual(signalDenied
            ? { status: 'incomplete', reason: 'runner_signal_incomplete' } : { status: 'stopped' });
        if (signalDenied) {
            sessions.clear();
            const view = await runtime.readOwners({ freshness: 'fresh', requesterAttribution: 'retained' });
            expect(view.status).toBe('ok');
            if (view.status !== 'ok') throw new Error('Native census unavailable');
            expect(view.rows.find(row => row.pid === childPid)).toMatchObject({ owner, ownerEnded: true, level: 'left_behind' });
        } else {
            // This assertion must be won by Stop, not the fixture's expiry.
            expect(Date.now() + 2000).toBeLessThan(fixtureStartedAt + fixtureLifetimeMs);
            expect(await waitForProcessExit(childPid, { timeoutMs: 2000 })).toBe(true);
        }
        expect(() => nativeKill(process.pid, 0)).not.toThrow();
    } finally {
        leftBehind?.dispose();
        parent.kill('SIGKILL');
        const identity = childIdentity;
        if (identity) {
            const snapshot = await readProcessCensus({ freshness: 'fresh', pids: [identity.pid] });
            const current = snapshot.status === 'ok' ? snapshot.rows.find(row => row.pid === identity.pid) : undefined;
            if (current && equalProcessStart(current.start, identity.start)) {
                try { nativeKill(identity.pid, 'SIGKILL'); } catch { /* Exact native fixture generation only. */ }
            }
            await waitForProcessExit(identity.pid);
        }
    }
}, 20_000);

it.each(['absent', 'zombie', 'unreadable', 'outside_survivor'] as const)('settles a departed captured tree using its native evidence (%s)', async state => {
    const owner = { kind: 'session', sessionId: 'departed-tree' } as const;
    let censusReads = 0;
    const censusDependencies: ProcessCensusDependencies = { platform: 'linux', selfPid: process.pid, linuxBoundary: {
        async readdir() { censusReads++; return [String(process.pid), ...(state === 'outside_survivor' ? ['6000'] : state === 'absent' ? [] : ['5100'])]; },
        async readlink() { return '/fixture'; },
        async readFile(path) {
            const pid = Number(path.split('/')[2]);
            if (pid === 5100 && state === 'unreadable') throw Object.assign(new Error('unreadable'), { code: 'EACCES' });
            if (path.endsWith('/status')) return 'Uid:\t1000\n';
            if (path.endsWith('/stat')) return pid + ' (fixture) ' + [pid === 5100 ? 'Z' : 'S', '1', '5000', '1', '0', '0',
                ...Array(13).fill('0'), pid === 6000 ? '210' : pid === 5100 ? '110' : '10', '0', '0'].join(' ');
            if (pid === 6000 && path.endsWith('/environ')) return 'HAPPIER_PROCESS_OWNER=v1.123456789abc.session.departed-tree\0';
            return '';
        },
    } };
    const runtime = createProcessOwnershipRuntime({ platform: 'linux', daemonScopeKey: '123456789abc',
        censusDependencies, listRoots: () => state === 'outside_survivor' ? [{ owner, pid: 5000,
            start: { startTimeMs: 1000 }, ownerCreatedAtMs: 0, ownerCreatedStartTimeMs: 1000, live: false }] : [] });
    const leftBehind = createLeftBehindPass({ processOwnershipRuntime: runtime });
    const signals: number[] = [];
    const remainder = createEndOwnerRemainder({ platform: 'linux', processOwnershipRuntime: runtime,
        daemonScopeKey: '123456789abc', firstPass: leftBehind.firstPass, systemBoundary: { platform: 'linux', censusDependencies,
            kill(pid) { signals.push(pid); return true; } } });
    const roots = Array.from({ length: 70 }, (_, index): HappierProcessRoot => ({ owner, pid: 5100 + index,
        start: { startTimeMs: 1100 + index }, live: true, ownerCreatedAtMs: 0 }));
    const result = await remainder.end(owner, { scope: 'subtree', ownership: [], roots });
    leftBehind.dispose();
    expect(result.outcomes).toHaveLength(roots.length);
    expect(signals).toEqual([]);
    if (state === 'unreadable') {
        expect(result.status).toBe('incomplete');
        expect(result.outcomes).toContainEqual({ pid: 5100, outcome: 'refused', reason: 'identity_unavailable' });
        return;
    }
    expect(result.status).toBe('complete');
    expect(result.outcomes.every(outcome => outcome.outcome === 'gone_before')).toBe(true);
    if (state === 'outside_survivor') {
        // A complete captured tree does not erase another observed member of
        // this owner: its Left-behind observation still needs a fresh pass.
        expect(censusReads).toBe(2);
        return;
    }
    // A fresh complete census already proves all captured generations absent.
    // Repeating whole-machine reads per departed PID delays the owning respawn.
    expect(censusReads).toBe(1);
});

it('protects a captured generation reowned during the final native identity read while retiring other targets', async () => {
    const owner = { kind: 'session', sessionId: 'departed' } as const;
    const root: HappierProcessRoot = { owner: { kind: 'session', sessionId: 'resumed' },
        pid: 5101, start: { startTimeMs: 1100 }, live: true, ownerCreatedAtMs: 0 };
    const rows = new Map([[process.pid, { parent: 1, ticks: 10 }],
        [5101, { parent: 1, ticks: 110 }], [5102, { parent: 1, ticks: 120 }]]);
    let rootReads = 0;
    let reowned = false;
    const censusDependencies: ProcessCensusDependencies = { platform: 'linux', selfPid: process.pid, linuxBoundary: {
        async readdir() { return [...rows.keys()].map(String); }, async readlink() { return '/fixture'; },
        async readFile(path) {
            const pid = Number(path.split('/')[2]);
            const row = rows.get(pid);
            if (!row) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
            if (path.endsWith('/status')) return 'Uid:\t1000\n';
            if (path.endsWith('/stat')) {
                if (pid === root.pid && rootReads === 3) reowned = true;
                return pid + ' (fixture) ' + ['S', String(row.parent), '5000', '1', '0', '0',
                    ...Array(13).fill('0'), String(row.ticks), '0', '0'].join(' ');
            }
            return '';
        },
    } };
    const runtime = createProcessOwnershipRuntime({ platform: 'linux', daemonScopeKey: '123456789abc', censusDependencies,
        listRoots: () => { rootReads++; return reowned ? [root] : []; } });
    const signals: number[] = [];
    const remainder = createEndOwnerRemainder({ platform: 'linux', processOwnershipRuntime: runtime,
        daemonScopeKey: '123456789abc', firstPass: () => {}, systemBoundary: { platform: 'linux', censusDependencies,
            kill(pid) { signals.push(pid); rows.delete(pid); return true; } } });
    const result = await remainder.end(owner, { scope: 'subtree', ownership: [], roots: [
        { ...root, owner, pid: 5102, start: { startTimeMs: 1200 } }, { ...root, owner },
    ] });
    expect(reowned).toBe(true);
    expect(signals).toEqual([5102]);
    expect(result).toMatchObject({ status: 'incomplete', outcomes: expect.arrayContaining([
        { pid: 5101, outcome: 'refused', reason: 'containment_authority_changed' }, { pid: 5102, outcome: 'ended' },
    ]) });
});

it('retires other captured targets while preserving a live reowned root and its subtree', async () => {
    const owner = { kind: 'session', sessionId: 'departed' } as const;
    const root: HappierProcessRoot = { owner: { kind: 'session', sessionId: 'resumed' },
        pid: 5101, start: { startTimeMs: 1100 }, live: true, ownerCreatedAtMs: 0 };
    const rows = new Map([[process.pid, { parent: 1, ticks: 10 }],
        [5101, { parent: 1, ticks: 110 }], [5102, { parent: 1, ticks: 120 }],
        [5103, { parent: 5101, ticks: 130 }]]);
    const censusDependencies: ProcessCensusDependencies = { platform: 'linux', selfPid: process.pid, linuxBoundary: {
        async readdir() { return [...rows.keys()].map(String); }, async readlink() { return '/fixture'; },
        async readFile(path) {
            const pid = Number(path.split('/')[2]);
            const row = rows.get(pid);
            if (!row) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
            if (path.endsWith('/status')) return 'Uid:\t1000\n';
            if (path.endsWith('/stat')) return pid + ' (fixture) ' + ['S', String(row.parent), '5000', '1', '0', '0',
                ...Array(13).fill('0'), String(row.ticks), '0', '0'].join(' ');
            return '';
        },
    } };
    const runtime = createProcessOwnershipRuntime({ platform: 'linux', daemonScopeKey: '123456789abc', censusDependencies,
        listRoots: () => [root] });
    const signals: number[] = [];
    const retained: HappierProcessRoot[] = [];
    const remainder = createEndOwnerRemainder({ platform: 'linux', processOwnershipRuntime: runtime,
        daemonScopeKey: '123456789abc', firstPass: () => {}, retainEndedRoots: roots => { retained.push(...roots); },
        systemBoundary: { platform: 'linux', censusDependencies,
            kill(pid) { signals.push(pid); rows.delete(pid); return true; } } });
    const result = await remainder.end(owner, { scope: 'subtree', ownership: [], roots: [5101, 5102, 5103].map(pid => ({
        ...root, owner, pid, start: { startTimeMs: rows.get(pid)!.ticks * 10 },
    })) });
    expect(result).toMatchObject({ status: 'complete', outcomes: [{ pid: 5102, outcome: 'ended' }] });
    expect(signals).toEqual([5102]);
    expect([...rows.keys()].sort()).toEqual([process.pid, 5101, 5103].sort());
    expect(retained.map(root => root.pid)).toEqual([5102]);
});

it.each(['exit', 'stop'] as const)('retires a Run-tagged native child with its captured Session generation after refresh (%s)', async retirement => {
    const happierHomeDir = '/fixture/refresh-run-remainder';
    const scope = resolveProcessOwnerScopeKey(happierHomeDir);
    const owner = { kind: 'session', sessionId: 'refresh-run-remainder' } as const;
    const run = { kind: 'run', runId: 'review-native' } as const;
    const parent = spawn(process.execPath, ['-e', `
        const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
            detached: true, stdio: 'ignore', env: { ...process.env, HAPPIER_PROCESS_OWNER: ${JSON.stringify(formatProcessOwnerTag({ happierHomeDir, owner: run }))} }
        });
        process.stdout.write(String(child.pid) + '\\n');
        setInterval(() => {}, 1000);
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    const childPid = await new Promise<number>(resolve => parent.stdout.once('data', data => resolve(Number(String(data).trim()))));
    try {
        const initial = await readProcessCensus({ freshness: 'fresh', scope: 'all' });
        if (initial.status !== 'ok') throw new Error('Native census unavailable');
        const native = initial.rows.find(row => row.pid === parent.pid)!;
        const root: HappierProcessRoot = { owner, pid: native.pid, start: native.start, live: true, ownerCreatedAtMs: 0 };
        let roots: readonly HappierProcessRoot[] = [root, { ...root, owner: run }];
        const runtime = createProcessOwnershipRuntime({ daemonScopeKey: scope, listRoots: () => roots });
        const remainder = createEndOwnerRemainder({ processOwnershipRuntime: runtime, daemonScopeKey: scope, firstPass: () => {} });
        const captured = await remainder.captureTree(owner, { pid: native.pid, start: native.start });
        const departed = once(parent, 'exit'); parent.kill('SIGKILL'); await departed;
        // A new live Session incarnation must neither hide the retired tree nor
        // become a target of its generation-specific physical cleanup.
        const self = initial.rows.find(row => row.pid === process.pid)!;
        roots = [{ ...root, live: false }, { ...root, owner: run, live: false },
            { ...root, pid: self.pid, start: self.start }];
        if (retirement === 'exit') {
            const result = await remainder.end(owner, captured);
            expect(result.outcomes).toContainEqual(expect.objectContaining({ pid: childPid, outcome: 'ended' }));
        } else {
            const tracked: TrackedSession = { pid: native.pid, processStartTimeMs: native.start.startTimeMs,
                happySessionId: owner.sessionId, startedBy: 'daemon', ownerRemainderCapture: captured };
            const stop = createStopSession({ pidToTrackedSession: new Map([[native.pid, tracked]]), ownerRemainder: remainder,
                areTrackedRunnersExited: async () => true, waitForTrackedRunnersExit: async () => true });
            expect(await stop(owner.sessionId)).toEqual({ status: 'stopped' });
        }
        expect(await waitForProcessExit(childPid, { timeoutMs: 2000 })).toBe(true);
        expect(() => process.kill(process.pid, 0)).not.toThrow();
    } finally {
        parent.kill('SIGKILL');
        try { process.kill(childPid, 'SIGKILL'); } catch { /* Exact owned native fixture. */ }
        await waitForProcessExit(childPid);
    }
}, 15_000);

it('keeps the Stop receipt incomplete when a captured child actually survives both signals', async () => {
    const { parent, childPid } = await spawnInlineNodeParentWithChild();
    const sessionId = 'surviving-remainder-stop';
    const initial = await readProcessCensus({ freshness: 'fresh', scope: 'all' });
    if (initial.status !== 'ok') throw new Error('Native census unavailable');
    const root = initial.rows.find(row => row.pid === parent.pid)!;
    const tracked: TrackedSession = { pid: root.pid, processStartTimeMs: root.start.startTimeMs,
        happySessionId: sessionId, startedBy: 'daemon', childProcess: parent };
    const sessions = new Map([[root.pid, tracked]]);
    const runtime = createProcessOwnershipRuntime({ daemonScopeKey: '123456789abc',
        listRoots: snapshot => listHappierProcessRoots({ snapshot, trackedSessions: sessions.values() }) });
    const leftBehind = createLeftBehindPass({ processOwnershipRuntime: runtime });
    const nativeKill = process.kill.bind(process);
    // Genuine signal boundary: acknowledge signals to this exact child without
    // delivering them. Native observations must still find the live generation.
    const remainder = createEndOwnerRemainder({ processOwnershipRuntime: runtime, daemonScopeKey: '123456789abc',
        firstPass: leftBehind.firstPass, systemBoundary: { kill: (pid, signal) => pid === childPid ? true : nativeKill(pid, signal) } });
    try {
        const captured = await remainder.capture({ kind: 'session', sessionId });
        expect(captured?.ownership.some(row => row.pid === childPid && row.level === 'proven')).toBe(true);
        const exited = once(parent, 'exit'); parent.kill('SIGKILL'); await exited;
        // The exit observer uses this pre-exit capture to retain unmarked lineage.
        tracked.ownerRemainderResult = await remainder.end({ kind: 'session', sessionId }, captured);
        expect(tracked.ownerRemainderResult).toMatchObject({ status: 'incomplete',
            outcomes: [{ pid: childPid, outcome: 'survived' }] });
        expect(nativeKill(childPid, 0)).toBe(true);
        const physicallyExited = async ({ trackedPids }: Readonly<{ trackedPids: readonly number[] }>) =>
            await waitForTrackedRunnerProcessesExit({ runners: trackedPids.map(pid => ({ pid })), timeoutMs: 0, pollIntervalMs: 0 });
        const stop = createStopSession({ pidToTrackedSession: sessions, ownerRemainder: remainder,
            areTrackedRunnersExited: physicallyExited, waitForTrackedRunnersExit: physicallyExited });
        await expect(stop(sessionId)).resolves.toMatchObject({ status: 'incomplete', reason: 'runner_signal_incomplete' });
    } finally {
        leftBehind.dispose();
        parent.kill('SIGKILL');
        try { nativeKill(childPid, 'SIGKILL'); } catch { /* Exact test-owned child only. */ }
        await waitForProcessExit(childPid);
    }
});

it('retains only a captured ended subtree while its shared daemon owner remains live', async () => {
    const { parent, childPid } = await spawnInlineNodeParentWithChild();
    const owner = { kind: 'happier' } as const;
    const initial = await readProcessCensus({ freshness: 'fresh', scope: 'all' });
    if (initial.status !== 'ok') throw new Error('Native census unavailable');
    const self = initial.rows.find(row => row.pid === process.pid)!;
    const daemonRoot: HappierProcessRoot = { owner, pid: self.pid, start: self.start, live: true, ownerCreatedAtMs: 0 };
    const runtime = createProcessOwnershipRuntime({ daemonScopeKey: '123456789abc', listRoots: () => [daemonRoot] });
    const retained: HappierProcessRoot[] = [];
    const remainder = createEndOwnerRemainder({ processOwnershipRuntime: runtime, daemonScopeKey: '123456789abc',
        retainEndedRoots: roots => { retained.push(...roots); }, firstPass: () => {} });
    try {
        const capture = await remainder.captureTree(owner, { pid: parent.pid! });
        expect(capture?.roots.map(root => root.pid).sort()).toEqual([parent.pid!, childPid].sort());
        const exited = once(parent, 'exit'); parent.kill('SIGKILL'); await exited;
        await remainder.observeEnd(owner, capture);
        expect(retained.map(root => root.pid).sort()).toEqual([parent.pid!, childPid].sort());
        expect(retained.every(root => !root.live)).toBe(true);
        expect(() => process.kill(childPid, 0)).not.toThrow();
    } finally {
        parent.kill('SIGKILL');
        try { process.kill(childPid, 'SIGKILL'); } catch { /* owned probe only */ }
    }
}, 15_000);

it('observes an ended terminal without terminating its surviving child', async () => {
    const { parent, childPid } = await spawnInlineNodeParentWithChild();
    const owner = { kind: 'terminal', terminalId: 'terminal-remainder-probe' } as const;
    const initial = await readProcessCensus({ freshness: 'fresh', scope: 'all' });
    if (initial.status !== 'ok') throw new Error('Native census unavailable');
    const root = initial.rows.find(row => row.pid === parent.pid)!;
    const runtime = createProcessOwnershipRuntime({ daemonScopeKey: '123456789abc', listRoots: () => [] });
    const retained: HappierProcessRoot[] = [];
    let observed = false;
    const remainder = createEndOwnerRemainder({ processOwnershipRuntime: runtime, daemonScopeKey: '123456789abc',
        retainEndedRoots: roots => { retained.push(...roots); }, firstPass: () => { observed = true; } });
    try {
        const exited = once(parent, 'exit'); parent.kill('SIGKILL'); await exited;
        await remainder.observeEnd(owner, { roots: [{ owner, pid: root.pid, start: root.start, live: true, ownerCreatedAtMs: 0 }], ownership: [] });
        expect(retained).toMatchObject([{ owner, live: false }]);
        expect(observed).toBe(true);
        expect(() => process.kill(childPid, 0)).not.toThrow();
    } finally {
        parent.kill('SIGKILL');
        try { process.kill(childPid, 'SIGKILL'); } catch { /* owned probe only */ }
    }
}, 15_000);

it('ends an unmarked reparented child using captured generation-bound pre-exit chain evidence', async () => {
    const { parent, childPid } = await spawnInlineNodeParentWithChild();
    const owner = { kind: 'session', sessionId: 'remainder-probe' } as const;
    const initial = await readProcessCensus({ freshness: 'fresh', scope: 'all' });
    if (initial.status !== 'ok') throw new Error('Native census unavailable');
    const root = initial.rows.find(row => row.pid === parent.pid)!;
    const runtime = createProcessOwnershipRuntime({ daemonScopeKey: '123456789abc', listRoots: () => [{
        owner, pid: root.pid, start: root.start, live: parent.exitCode === null && parent.signalCode === null,
        ownerCreatedAtMs: 0,
    }] });
    const firstPassOwners: string[] = [];
    const remainder = createEndOwnerRemainder({ processOwnershipRuntime: runtime, daemonScopeKey: '123456789abc',
        firstPass: value => { firstPassOwners.push(value.kind); } });
    try {
        const captured = await remainder.capture(owner);
        expect(captured?.ownership.find(row => row.pid === childPid)?.level).toBe('proven');
        const departed = once(parent, 'exit');
        parent.kill('SIGKILL');
        await departed;
        const result = await remainder.end(owner, captured);
        expect(result).toMatchObject({ status: 'complete', outcomes: [{ pid: childPid, outcome: 'ended' }] });
        await waitForProcessExit(childPid, { timeoutMs: 2000 });
        expect(firstPassOwners).toEqual(['session']);
    } finally {
        parent.kill('SIGKILL');
        try { process.kill(childPid, 'SIGKILL'); } catch { /* disposable probe may already have ended */ }
    }
}, 15_000);

it('does not sweep a new live owner sharing the old physical fence', async () => {
    const oldOwner = { kind: 'session', sessionId: 'old-owner' } as const;
    const newOwner = { kind: 'session', sessionId: 'new-owner' } as const;
    const scope = '123456789abc';
    const rows = new Map([
        [process.pid, { parent: 1, ticks: 10, cgroup: '', tag: '' }],
        [4100, { parent: 1, ticks: 100, cgroup: '/old-fence', tag: `v1.${scope}.session.old-owner` }],
        [4101, { parent: 4100, ticks: 110, cgroup: '/old-fence', tag: `v1.${scope}.session.old-owner` }],
    ]);
    const censusDependencies: ProcessCensusDependencies = { platform: 'linux', selfPid: process.pid, linuxBoundary: {
        async readdir() { return [...rows.keys()].map(String); },
        async readlink() { return '/fixture'; },
        async readFile(path) {
            const row = rows.get(Number(path.split('/')[2]));
            if (!row) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
            if (path.endsWith('/status')) return 'Uid:\t1000\n';
            if (path.endsWith('/stat')) return `${path.split('/')[2]} (fixture) ${['S', String(row.parent), '5000', '1', '0', '0', ...Array(13).fill('0'), String(row.ticks), '0', '0'].join(' ')}`;
            if (path.endsWith('/environ')) return row.tag ? `HAPPIER_PROCESS_OWNER=${row.tag}\0` : '';
            if (path.endsWith('/cgroup')) return row.cgroup ? `0::${row.cgroup}\n` : '';
            return '';
        },
    } };
    const oldRoot: HappierProcessRoot = { owner: oldOwner, pid: 4100, start: { startTimeMs: 1000 }, live: true,
        ownerCreatedAtMs: 0, ownerCreatedStartTimeMs: 1000, containment: { kind: 'linux_unit', prefix: '/old-fence' } };
    let roots: readonly HappierProcessRoot[] = [oldRoot];
    const runtime = createProcessOwnershipRuntime({ platform: 'linux', daemonScopeKey: scope,
        censusDependencies, listRoots: () => roots });
    const signals: number[] = [];
    const remainder = createEndOwnerRemainder({ platform: 'linux', processOwnershipRuntime: runtime, daemonScopeKey: scope,
        firstPass: () => {}, systemBoundary: { platform: 'linux', censusDependencies,
            kill(pid) { signals.push(pid); rows.delete(pid); return true; } } });
    const captured = await remainder.capture(oldOwner);
    roots = [{ ...oldRoot, live: false }, { ...oldRoot, owner: newOwner, live: true, containment: undefined }];
    rows.set(4101, { parent: 1, ticks: 110, cgroup: '', tag: `v1.${scope}.session.old-owner` });
    const result = await remainder.end(oldOwner, captured);
    expect(result).toMatchObject({ status: 'complete', outcomes: [{ pid: 4101, outcome: 'ended' }] });
    expect(signals).toEqual([4101]);
    expect(rows.has(4100)).toBe(true);
});

it.each(['Z', 'S', 'exits_during_grace'] as const)('requires ownership after enrichment disappears only for still-live members (%s)', async (stateAfterSignal) => {
    const owner = { kind: 'session', sessionId: 'exiting-remainder' } as const;
    const scope = '123456789abc';
    const rows = new Map([
        [process.pid, { parent: 1, ticks: 10, state: 'S' }],
        [4100, { parent: 1, ticks: 100, state: 'S' }],
        [4101, { parent: 4100, ticks: 110, state: 'S' }],
        [4102, { parent: 1, ticks: 120, state: 'S' }],
    ]);
    const enrichmentLost = new Set<number>();
    const censusDependencies: ProcessCensusDependencies = { platform: 'linux', selfPid: process.pid, linuxBoundary: {
        async readdir() { return [...rows.keys()].map(String); },
        async readlink() { return '/fixture'; },
        async readFile(path) {
            const pid = Number(path.split('/')[2]);
            const row = rows.get(pid);
            if (!row) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
            if (path.endsWith('/status')) return 'Uid:\t1000\n';
            if (path.endsWith('/stat')) return `${pid} (fixture) ${[row.state, String(row.parent), '5000', '1', '0', '0', ...Array(13).fill('0'), String(row.ticks), '0', '0'].join(' ')}`;
            if (path.endsWith('/environ')) {
                if (enrichmentLost.has(pid)) throw Object.assign(new Error('process enrichment unavailable'), { code: 'EACCES' });
                return pid === process.pid ? '' : `HAPPIER_PROCESS_OWNER=v1.${scope}.session.${owner.sessionId}\0`;
            }
            return '';
        },
    } };
    const root: HappierProcessRoot = { owner, pid: 4100, start: { startTimeMs: 1000 }, live: true,
        ownerCreatedAtMs: 0, ownerCreatedStartTimeMs: 1000 };
    let roots: readonly HappierProcessRoot[] = [root];
    const runtime = createProcessOwnershipRuntime({ platform: 'linux', daemonScopeKey: scope,
        censusDependencies, listRoots: () => roots });
    const signals: number[] = [];
    const remainder = createEndOwnerRemainder({ platform: 'linux', processOwnershipRuntime: runtime, daemonScopeKey: scope,
        firstPass: () => {}, systemBoundary: { platform: 'linux', censusDependencies,
            ...(stateAfterSignal === 'exits_during_grace' ? { wait: async () => { rows.delete(4102); } } : {}),
            kill(pid) {
                signals.push(pid);
                if (pid === 4102) {
                    rows.set(pid, { ...rows.get(pid)!, parent: 1, state: stateAfterSignal === 'exits_during_grace' ? 'S' : stateAfterSignal });
                    enrichmentLost.add(pid);
                } else rows.delete(pid);
                return true;
            },
        } });
    const captured = await remainder.capture(owner);
    roots = [{ ...root, live: false }];
    rows.delete(root.pid);
    const result = await remainder.end(owner, captured);
    if (stateAfterSignal !== 'S') {
        expect(result).toMatchObject({ status: 'complete', outcomes: [
            { pid: 4101, outcome: 'ended' }, { pid: 4102, outcome: 'ended' },
        ] });
    } else {
        expect(result).toMatchObject({ status: 'incomplete', outcomes: expect.arrayContaining([
            { pid: 4102, outcome: 'refused', reason: 'containment_authority_changed' },
        ]) });
    }
    expect(signals.sort()).toEqual([4101, 4102]);
});

it('does not retire a resumed live owner generation while completing an older runner exit', async () => {
    const old = await spawnInlineNodeParentWithChild();
    const resumed = await spawnInlineNodeParentWithChild();
    const owner = { kind: 'session', sessionId: 'resumed-remainder-probe' } as const;
    const snapshot = await readProcessCensus({ freshness: 'fresh', scope: 'all' });
    if (snapshot.status !== 'ok') throw new Error('Native census unavailable');
    const oldRoot = snapshot.rows.find(row => row.pid === old.parent.pid)!;
    const newRoot = snapshot.rows.find(row => row.pid === resumed.parent.pid)!;
    let current = oldRoot;
    const runtime = createProcessOwnershipRuntime({ daemonScopeKey: '123456789abc', listRoots: () => [{
        owner, pid: current.pid, start: current.start, live: true, ownerCreatedAtMs: 0,
    }] });
    const remainder = createEndOwnerRemainder({ processOwnershipRuntime: runtime, daemonScopeKey: '123456789abc', firstPass: () => {} });
    try {
        const capture = await remainder.capture(owner);
        const exited = once(old.parent, 'exit'); old.parent.kill('SIGKILL'); await exited;
        current = newRoot;
        expect(await remainder.end(owner, capture)).toMatchObject({ status: 'complete', outcomes: [] });
        const after = await readProcessCensus({ freshness: 'fresh', pids: [resumed.childPid, resumed.parent.pid!] });
        expect(after.status === 'ok' && after.rows.filter(row => [resumed.parent.pid, resumed.childPid].includes(row.pid) && row.state !== 'zombie')).toHaveLength(2);
    } finally {
        old.parent.kill('SIGKILL'); resumed.parent.kill('SIGKILL');
        for (const pid of [old.childPid, resumed.childPid]) { try { process.kill(pid, 'SIGKILL'); } catch { /* owned probes only */ } }
    }
}, 15_000);

it.each(['alias_fences', 'retry_captured'] as const)('completes the native fence lifecycle with %s', async scenario => {
    const owner = { kind: 'session', sessionId: 'fence-lifecycle' } as const;
    const rows = new Map([[process.pid, { parent: 1, ticks: 10, cgroup: '' }],
        [4101, { parent: 1, ticks: 110, cgroup: '/session-fence' }]]);
    const root: HappierProcessRoot = { owner, pid: 4100, start: { startTimeMs: 1000 }, live: false,
        ownerCreatedAtMs: 0, containment: { kind: 'linux_unit', prefix: '/session-fence' } };
    const roots = scenario === 'alias_fences' ? [root, { ...root, pid: 4099, start: { startTimeMs: 900 } }] : [root];
    const censusDependencies: ProcessCensusDependencies = { platform: 'linux', linuxBoundary: {
        async readdir() { return [...rows.keys()].map(String); }, async readlink() { return '/fixture'; },
        async readFile(path) {
            const row = rows.get(Number(path.split('/')[2]));
            if (!row) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
            if (path.endsWith('/status')) return 'Uid:\t1000\n';
            if (path.endsWith('/stat')) return `${path.split('/')[2]} (fixture) ${['S', String(row.parent), '5000', '1', '0', '0', ...Array(13).fill('0'), String(row.ticks), '0', '0'].join(' ')}`;
            if (path.endsWith('/cgroup')) return row.cgroup ? `0::${row.cgroup}\n` : '';
            return '';
        },
    } };
    const runtime = createProcessOwnershipRuntime({ platform: 'linux', daemonScopeKey: '123456789abc', censusDependencies, listRoots: () => roots });
    const signals: number[] = [];
    const remainder = createEndOwnerRemainder({ platform: 'linux', processOwnershipRuntime: runtime, daemonScopeKey: '123456789abc',
        firstPass: () => {}, systemBoundary: { platform: 'linux', censusDependencies,
            kill(pid) {
                signals.push(pid);
                if (scenario === 'retry_captured' && signals.length < 3) return true;
                rows.delete(pid);
                if (scenario === 'alias_fences' && pid === 4101) rows.set(4102, { parent: 1, ticks: 120, cgroup: '/session-fence' });
                return true;
            } } });
    const captured = scenario === 'retry_captured' ? { scope: 'subtree' as const, ownership: [], roots: [root,
        { ...root, pid: 4101, start: { startTimeMs: 1100 }, containment: undefined }] } : undefined;
    const result = await remainder.end(owner, captured);
    expect(result.status).toBe('complete');
    expect(result.outcomes).toContainEqual(expect.objectContaining({ pid: scenario === 'alias_fences' ? 4102 : 4101, outcome: 'ended' }));
    expect([...rows.keys()]).toEqual([process.pid]);
});

it.each(['root', 'member', 'member_at_signal'] as const)('refuses a fence whose %s changes live owner after the initial exclusive proof', async reowned => {
    const oldOwner = { kind: 'session', sessionId: 'old-owner' } as const;
    const newOwner = { kind: 'session', sessionId: 'new-owner' } as const;
    const scope = '123456789abc';
    const rows = new Map([[process.pid, { parent: 1, ticks: 10, cgroup: '' }],
        [4100, { parent: 1, ticks: 100, cgroup: '/old-fence' }], [4101, { parent: 4100, ticks: 110, cgroup: '/old-fence' }]]);
    const oldRoot: HappierProcessRoot = { owner: oldOwner, pid: 4100, start: { startTimeMs: 1000 }, live: false,
        ownerCreatedAtMs: 0, containment: { kind: 'linux_unit', prefix: '/old-fence' } };
    let roots: readonly HappierProcessRoot[] = [oldRoot];
    let reads = 0;
    let rootReads = 0;
    const reown = () => { roots = [oldRoot, { ...oldRoot, owner: newOwner,
        ...(reowned !== 'root' ? { pid: 4101, start: { startTimeMs: 1100 } } : {}),
        live: true, containment: undefined }]; };
    const censusDependencies: ProcessCensusDependencies = { platform: 'linux', selfPid: process.pid, linuxBoundary: {
        async readdir() {
            if (++reads >= 2 && reowned !== 'member_at_signal') reown();
            return [...rows.keys()].map(String);
        },
        async readlink() { return '/fixture'; },
        async readFile(path) {
            const row = rows.get(Number(path.split('/')[2]));
            if (!row) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
            if (path.endsWith('/status')) return 'Uid:\t1000\n';
            if (path.endsWith('/stat')) {
                if (Number(path.split('/')[2]) === 4101 && rootReads === 3 && reowned === 'member_at_signal') reown();
                return `${path.split('/')[2]} (fixture) ${['S', String(row.parent), '5000', '1', '0', '0', ...Array(13).fill('0'), String(row.ticks), '0', '0'].join(' ')}`;
            }
            if (path.endsWith('/cgroup')) return row.cgroup ? `0::${row.cgroup}\n` : '';
            return '';
        },
    } };
    const runtime = createProcessOwnershipRuntime({ platform: 'linux', daemonScopeKey: scope, censusDependencies,
        listRoots: () => { rootReads++; return roots; } });
    const signals: number[] = [];
    const remainder = createEndOwnerRemainder({ platform: 'linux', processOwnershipRuntime: runtime, daemonScopeKey: scope,
        firstPass: () => {}, systemBoundary: { platform: 'linux', censusDependencies,
            kill(pid) { signals.push(pid); rows.delete(pid); return true; } } });
    const result = await remainder.end(oldOwner);
    expect(result.status).toBe('incomplete');
    expect(signals).toEqual([]);
    expect(rows.has(4100)).toBe(true);
});
