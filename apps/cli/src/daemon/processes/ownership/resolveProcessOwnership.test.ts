import { describe, expect, it } from 'vitest';
import type { ProcessCensusRow } from '@/processes/census/processCensus';
import { resolveProcessOwnership } from './resolveProcessOwnership';
import type { HappierProcessRoot } from './types';
import { createHappierLinuxScopeName } from '@/daemon/platform/linux/systemdUserResourceGovernor';
import { createWindowsJobCustodyName } from '@/subprocess/supervision/processCustody';
import { resolveProcessOwnershipLevel } from './levelRules';

const principal = { kind: 'uid', value: '1000' } as const;
const scope = '123456789abc';
const row = (pid: number, extra: Partial<ProcessCensusRow> = {}): ProcessCensusRow => ({
    pid, ppid: 1, start: { startTimeMs: pid * 100 }, principal, name: 'node', memory: null, cpuTimeUs: null, ...extra,
});
const root = (extra: Partial<HappierProcessRoot> = {}): HappierProcessRoot => ({
    owner: { kind: 'session', sessionId: 's1' }, pid: 10, start: { startTimeMs: 1000 }, live: true,
    ownerCreatedAtMs: 500, workspacePath: '/repo', ...extra,
});
function resolve(rows: readonly ProcessCensusRow[], roots: readonly HappierProcessRoot[] = [root()], extra: Partial<Parameters<typeof resolveProcessOwnership>[0]> = {}) {
    return resolveProcessOwnership({ snapshot: { status: 'ok', capturedAtMs: 10000, logicalCpus: 4, rows },
        roots, daemonPrincipal: principal, daemonScopeKey: scope, platform: 'darwin', ...extra });
}
describe('resolveProcessOwnership', () => {
    it('keeps native containment proof distinct from operating-system principal equality', () => {
        const native = { kind: 'fence' as const, state: 'met' as const, reason: 'linux_container' as const };
        expect(resolveProcessOwnershipLevel({ samePrincipal: false, ownerEnded: false, observationsIncomplete: false, evidence: [native] })).toBe('proven');
        expect(resolveProcessOwnershipLevel({ samePrincipal: false, ownerEnded: false, observationsIncomplete: false,
            evidence: [{ ...native, reason: 'linux_scope' }] })).toBe('not_happier');
        expect(resolveProcessOwnershipLevel({ samePrincipal: undefined, ownerEnded: false, observationsIncomplete: true, evidence: [native] })).toBe('unknown');
        const containerId = 'a'.repeat(64);
        const prefix = `/system.slice/docker-${containerId}.scope`;
        expect(resolve([row(10, { principal: null, cgroup: prefix })], [root({
            owner: { kind: 'container', serverId: 'home', machineId: 'machine', serviceId: 'production/web',
                containerId, composeProject: 'production', composeService: 'web', environmentId: 'environment' },
            containment: { kind: 'linux_container', prefix },
        })], { platform: 'linux' })[0]?.level).toBe('unknown');
    });
    it('keeps native proof and detail ancestry within its exact fence with one root-fact pass', () => {
        let containmentReads = 0;
        const roots = Array.from({ length: 16 }, (_, index) => {
            const id = index.toString(16).padStart(64, '0');
            const containment = { kind: 'linux_container' as const, prefix: `/system.slice/docker-${id}.scope` };
            const native = root({ owner: { kind: 'container', serverId: 'home', machineId: 'machine', serviceId: `service-${index}`,
                containerId: id, composeProject: 'project', composeService: `service-${index}`, environmentId: 'environment' },
                pid: 100 + index, start: { startTimeMs: (100 + index) * 100 },
                containment });
            Object.defineProperty(native, 'containment', { get() { containmentReads++; return containment; } });
            return native;
        });
        const rows = [row(50, { name: 'private-host-ancestor' }), ...Array.from({ length: 1000 }, (_, index) => row(100 + index, {
            ppid: index < 16 ? 50 : 100 + index % 16,
            cgroup: `/system.slice/docker-${(index % 16).toString(16).padStart(64, '0')}.scope`,
            principal: { kind: 'uid', value: '0' }, name: 'native-worker',
        }))];
        containmentReads = 0;
        const result = resolve(rows, roots, { platform: 'linux' });
        expect(result.slice(1).every(item => item.level === 'proven' && item.owner?.kind === 'container')).toBe(true);
        expect(result.slice(1).flatMap(item => item.chain).some(item => item.name === 'private-host-ancestor')).toBe(false);
        // Root facts are immutable within this census. Row count must not multiply their traversal.
        expect(containmentReads).toBeLessThanOrEqual(roots.length * 2);
        const escaped = row(3000, { ppid: 100, cwd: '/repo/child', pgid: 100, cgroup: '/user.slice' });
        expect(resolve([...rows, escaped], roots, { platform: 'linux', listeners: [{ pid: escaped.pid, port: 4000 }] }).at(-1)?.owner).toBeNull();
    });
    it('proves unattached daemon-only rows belong to Happier without claiming their spawner ended', () => {
        const daemon = root({ owner: { kind: 'happier' } });
        const daemonTag = `v1.${scope}.happier.daemon`;
        const roots = [daemon, root({ owner: { kind: 'happier', component: 'voice_worker' }, pid: 40, start: { startTimeMs: 4000 } }),
            root({ owner: { kind: 'run', runId: 'r1' }, pid: 50, start: { startTimeMs: 5000 } }),
            root({ owner: { kind: 'service', serviceId: 'svc1' }, pid: 60, start: { startTimeMs: 6000 } })];
        const rows = [row(10), row(20, { ppid: 10, ownerTag: daemonTag }), row(30, { ownerTag: daemonTag }),
            row(40, { ownerTag: `v1.${scope}.happier.voice_worker` }), row(50), row(60),
            row(70, { ownerTag: `v1.${scope}.run.r1` }), row(80, { ownerTag: `v1.${scope}.service.svc1` })];
        const results = resolve(rows, roots);
        expect(results.find(row => row.pid === 30)).toMatchObject({ level: 'proven', ownerEnded: false, owner: { kind: 'happier' } });
        for (const pid of [10, 20, 40, 50, 60, 70, 80]) expect(results.find(row => row.pid === pid)?.level).toBe('proven');
    });
    it('marks only exact captured ended daemon subprocess generations left behind, never live peers sharing its owner tag', () => {
        const daemon = root({ owner: { kind: 'happier' } });
        const ended = root({ owner: { kind: 'happier' }, pid: 20, start: { startTimeMs: 2000 }, live: false, endedAtMs: 9000 });
        const tag = `v1.${scope}.happier.daemon`;
        const results = resolve([row(10), row(20, { ppid: 10, ownerTag: tag }), row(30, { ppid: 10, ownerTag: tag })], [daemon, ended]);
        expect(results[1]).toMatchObject({ level: 'left_behind', ownerEnded: true, owner: { kind: 'happier' } });
        expect(results[2]).toMatchObject({ level: 'proven', ownerEnded: false, owner: { kind: 'happier' } });
        expect(resolve([row(10), row(20, { ppid: 10, ownerTag: tag, start: { startTimeMs: 9999 } })], [daemon, ended])[1]?.level).toBe('proven');
    });
    it('does not let an old launch fence steal a same-generation swapped live runner', () => {
        const ownerTag = `v1.${scope}.session.s1`;
        const old = root({ live: false, ownerCreatedStartTimeMs: 500 });
        const current = root({ owner: { kind: 'session', sessionId: 's2' }, ownerCreatedStartTimeMs: 500 });
        const cgroup = `/user.slice/${createHappierLinuxScopeName(ownerTag)!}`;
        const jobs = [createWindowsJobCustodyName(ownerTag)];
        for (const platform of ['linux', 'win32'] as const) {
            expect(resolve([row(10, { cgroup, jobs, ownerTag: `v1.${scope}.session.s2` }), row(20, { ppid: 10, cgroup, jobs })],
                [old, current], { platform })[1]).toMatchObject({ level: 'proven', owner: { sessionId: 's2' }, ownerEnded: false });
        }
    });
    it('keeps ended-owner native fences authoritative after the root and marker disappear, without trusting unknown homes or owners', () => {
        const ownerTag = `v1.${scope}.session.s1`;
        const unit = createHappierLinuxScopeName(ownerTag)!;
        const ended = root({ live: false, ownerCreatedStartTimeMs: 500 });
        expect(resolve([row(20, { cgroup: `/user.slice/${unit}` })], [ended], { platform: 'linux' })[0])
            .toMatchObject({ level: 'left_behind', owner: { sessionId: 's1' } });
        const job = createWindowsJobCustodyName(ownerTag);
        expect(resolve([row(20, { jobs: [job] })], [ended], { platform: 'win32' })[0])
            .toMatchObject({ level: 'left_behind', owner: { sessionId: 's1' } });
        expect(resolve([row(20, { cgroup: `/user.slice/${unit}` })], [], { platform: 'linux' })[0]?.level).toBe('unknown');
        const foreign = createHappierLinuxScopeName('v1.aaaaaaaaaaaa.session.s1')!;
        expect(resolve([row(20, { cgroup: `/user.slice/${foreign}` })], [ended], { platform: 'linux' })[0]?.level).toBe('not_happier');
    });
    it('proves every descendant through the live generation and refuses a recycled root', () => {
        const rows = [row(10), ...Array.from({ length: 7 }, (_, i) => row(11 + i, { ppid: 10 + i }))];
        expect(resolve(rows).find(item => item.pid === 17)).toMatchObject({ level: 'proven', owner: { sessionId: 's1' } });
        expect(resolve([row(10, { start: { startTimeMs: 9999 } }), row(11, { ppid: 10 })]).find(item => item.pid === 11)?.level).toBe('not_happier');
    });
    it('proves reparented same-home markers, reowns resumed owners and rejects stale or foreign markers', () => {
        expect(resolve([row(20, { ownerTag: `v1.${scope}.session.s1` })], [root({ start: { startTimeMs: 3000 } })])[0]?.level).toBe('proven');
        expect(resolve([row(20, { ownerTag: 'v1.aaaaaaaaaaaa.session.s1' })])[0]?.level).toBe('not_happier');
        expect(resolve([row(20, { start: { startTimeMs: 400 }, ownerTag: `v1.${scope}.session.s1` })])[0]?.level).toBe('not_happier');
        expect(resolve([row(20, { ownerTag: `v1.${scope}.session.unknown` })])[0]?.level).toBe('unknown');
    });
    it('keeps principal and required-observation uncertainty out of not-Happier and victims', () => {
        expect(resolve([row(20, { principal: null })])[0]?.level).toBe('unknown');
        expect(resolve([row(20, { principal: { kind: 'uid', value: '0' }, ownerTag: `v1.${scope}.session.s1` })])[0]?.level).toBe('not_happier');
        for (const missing of [['ownerTag', 'argv'], ['cgroup']]) {
            expect(resolve([row(20)], [], { snapshot: { status: 'ok', capturedAtMs: 10000, logicalCpus: 4,
                rows: [row(20)], partial: [{ pid: 20, missing }] } })[0]?.level).toBe('unknown');
            expect(resolve([row(10), row(20, { ppid: 10 })], [root()], { snapshot: { status: 'ok', capturedAtMs: 10000,
                logicalCpus: 4, rows: [row(10), row(20, { ppid: 10 })], partial: [{ pid: 20, missing }] } })[1]?.level).toBe('proven');
        }
    });
    it('does not promote an unreadable or unknown marker to weak listener/group action authority', () => {
        const unreadable = row(20, { cwd: '/repo/app', pgid: 10 });
        expect(resolve([row(10, { pgid: 10 }), unreadable], [root()], {
            listeners: [{ pid: 20, port: 5173 }], snapshot: { status: 'ok', capturedAtMs: 10000, logicalCpus: 4,
                rows: [row(10, { pgid: 10 }), unreadable], partial: [{ pid: 20, missing: ['ownerTag'] }] },
        })[1]?.level).toBe('unknown');
        expect(resolve([row(20, { cwd: '/repo/app', ownerTag: `v1.${scope}.session.unknown` })], [root()],
            { listeners: [{ pid: 20, port: 5173 }] })[0]?.level).toBe('unknown');
    });
    it('reports ended-owner proof and preserves a captured chain only for the same generation', () => {
        const before = resolve([row(10), row(20, { ppid: 10 })]);
        const after = resolve([row(20)], [root({ live: false, endedAtMs: 9000 })], { capturedOwnership: before });
        expect(after[0]).toMatchObject({ level: 'left_behind', ownerEnded: true, owner: { sessionId: 's1' } });
        expect(after[0]?.evidence.find(item => item.kind === 'parent_chain')).toMatchObject({ state: 'met', reason: 'chain_broken_at_exit', at: { pid: 10, exitedAtMs: 9000 } });
        expect(resolve([row(20, { start: { startTimeMs: 9999 } })], [root({ live: false })], { capturedOwnership: before })[0]?.level).toBe('not_happier');
    });
    it('derives likely from group or a listener in the owner workspace, with sibling paths excluded', () => {
        expect(resolve([row(10, { pgid: 10 }), row(20, { pgid: 10 })])[1]?.level).toBe('likely');
        expect(resolve([row(20, { cwd: '/repo/app' })], undefined, { listeners: [{ pid: 20, port: 5173 }] })[0]?.level).toBe('likely');
        expect(resolve([row(20, { cwd: '/repo-other' })], undefined, { listeners: [{ pid: 20, port: 5173 }] })[0]?.level).toBe('not_happier');
    });
    it('gives a run marker precedence over its hosting session chain, with all four evidence lines', () => {
        const runRoot = root({ owner: { kind: 'run', runId: 'r1', sessionId: 's1' } });
        const result = resolve([row(10), row(20, { ppid: 10, ownerTag: `v1.${scope}.run.r1` })], [root(), runRoot])[1];
        expect(result?.owner).toMatchObject({ kind: 'run', runId: 'r1' });
        expect(result?.evidence.map(item => item.kind)).toEqual(['fence', 'parent_chain', 'marker', 'group_and_port']);
    });
    it.each([
        ['darwin', '/work/', '/work/nested///', '/work/nested/app'],
        ['win32', 'C:\\Work\\', 'c:/work\\nested/', 'C:\\WORK/nested\\app'],
    ] as const)('associates detached listeners with the deepest eligible normalized workspace on %s', (platform, outerPath, innerPath, cwd) => {
        const outer = root({ workspacePath: outerPath });
        const inner = root({ owner: { kind: 'session', sessionId: 'nested' }, pid: 11, workspacePath: innerPath });
        const listener = row(20, { cwd });
        for (const roots of [[outer, inner], [inner, outer]]) {
            expect(resolve([listener], roots, { platform, listeners: [{ pid: 20, port: 5173 }] })[0])
                .toMatchObject({ owner: inner.owner, level: 'likely', ownerEnded: false });
        }
        expect(resolve([listener], [outer, { ...inner, ownerCreatedAtMs: 3000 }],
            { platform, listeners: [{ pid: 20, port: 5173 }] })[0]).toMatchObject({ owner: outer.owner, level: 'likely' });
        expect(resolve([row(20, { cwd: `${cwd}-other`, principal: null })], [outer, inner],
            { platform, listeners: [{ pid: 20, port: 5173 }] })[0]).toMatchObject({ owner: null, level: 'unknown' });
    });
    it('keeps equally deep distinct-owner cwd and shared-group hints unknown regardless of root order', () => {
        const first = root({ workspacePath: '/work/nested/' });
        const second = root({ owner: { kind: 'session', sessionId: 'second' }, pid: 11, start: { startTimeMs: 1100 }, workspacePath: '/work\\nested//' });
        for (const roots of [[first, second], [second, first]]) {
            expect(resolve([row(20, { cwd: '/work/nested/app' })], roots, { listeners: [{ pid: 20, port: 5173 }] })[0])
                .toMatchObject({ owner: null, level: 'unknown' });
            expect(resolve([row(10, { pgid: 50 }), row(11, { pgid: 50 }), row(20, { pgid: 50 })], roots)[2])
                .toMatchObject({ owner: null, level: 'unknown' });
        }
    });
    it('uses the live resumed owner for weak cwd association instead of an ended same-owner incarnation', () => {
        const ended = root({ live: false, endedAtMs: 5000 });
        const current = root({ pid: 11, start: { startTimeMs: 1100 } });
        for (const roots of [[ended, current], [current, ended]]) {
            expect(resolve([row(20, { cwd: '/repo/app' })], roots, { listeners: [{ pid: 20, port: 5173 }] })[0])
                .toMatchObject({ owner: current.owner, ownerEnded: false, level: 'likely' });
        }
    });
});
