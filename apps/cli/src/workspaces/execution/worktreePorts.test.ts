import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as loopback from '@/cloud/loopbackPort';
import * as atomicWrite from '@/utils/fs/writeJsonAtomicSync';
import { localWorkspaceSource } from '@/workspaces/source/localWorkspaceSource';
import { runWithWorkspaceSource, type WorkspaceSource } from '@/workspaces/source/workspaceSource';

import { createWorktreePortsOwner } from './worktreePorts';

describe('execution-host retained worktree ports', () => {
    const roots: string[] = [];
    afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
    async function fixture() {
        const root = await mkdtemp(join(tmpdir(), 'happier-worktree-ports-'));
        roots.push(root);
        const first = join(root, 'first');
        const second = join(root, 'second');
        await Promise.all([mkdir(first), mkdir(second)]);
        const statePath = join(root, 'host', 'worktree-ports.json');
        return { root, first, second, statePath, owner: createWorktreePortsOwner({ statePath }) };
    }
    it('does no state or OS work without project or listener demand', async () => {
        const f = await fixture();
        await writeFile(join(f.root, 'invalid-state.json'), '{damaged');
        const select = vi.spyOn(loopback, 'reserveLoopbackPort');
        const writes = vi.spyOn(atomicWrite, 'writeJsonAtomicSync');
        expect(await createWorktreePortsOwner({ statePath: join(f.root, 'invalid-state.json') }).assign({ rootPath: 'not-an-admitted-root' }))
            .toEqual({ kind: 'ready', assignment: { ports: [], listenerPorts: {} } });
        expect(select).not.toHaveBeenCalled();
        expect(writes).not.toHaveBeenCalled();
    });
    it('resolves member roots through the admitted filesystem and retains host-owned port state', async () => {
        const f = await fixture();
        const memberRoot = join(f.root, 'only-on-member');
        // The filesystem port is the OS boundary; the allocation and retained-state owner remain real.
        const source: WorkspaceSource = {
            ...localWorkspaceSource,
            kind: 'target',
            id: 'member-port-test',
            realpath: async path => {
                if (path !== memberRoot) throw new Error('Unexpected member path');
                return realpath(f.first);
            },
        };
        const assigned = await runWithWorkspaceSource(source, () => f.owner.assign({ rootPath: memberRoot, slots: 1 }));
        expect(assigned).toMatchObject({ kind: 'ready', assignment: { ports: [expect.any(Number)] } });
        expect(await runWithWorkspaceSource(source, () => f.owner.read({ rootPath: memberRoot }))).toEqual(assigned);
        expect(await f.owner.read({ rootPath: f.first })).toEqual(assigned);
        await expect(readFile(memberRoot, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        expect(Object.keys(JSON.parse(await readFile(f.statePath, 'utf8')).assignments)).toHaveLength(1);
    });
    it('serializes simultaneous roots, appends slots without renumbering, and reuses unchanged persisted bytes after restart', async () => {
        const f = await fixture();
        const [first, second] = await Promise.all([
            f.owner.assign({ rootPath: f.first, slots: 2 }), f.owner.assign({ rootPath: f.second, slots: 2 }),
        ]);
        if (first.kind !== 'ready' || second.kind !== 'ready') throw new Error('assignment unavailable');
        expect(new Set([...first.assignment.ports, ...second.assignment.ports]).size).toBe(4);
        const extended = await f.owner.assign({ rootPath: f.first, slots: 3 });
        if (extended.kind !== 'ready') throw new Error('assignment unavailable');
        expect(extended.assignment.ports.slice(0, 2)).toEqual(first.assignment.ports);
        const bytes = await readFile(f.statePath, 'utf8');
        const writes = vi.spyOn(atomicWrite, 'writeJsonAtomicSync');
        const selections = vi.spyOn(loopback, 'reserveLoopbackPort');
        const restarted = createWorktreePortsOwner({ statePath: f.statePath });
        expect(await restarted.assign({ rootPath: f.first, slots: 3 })).toEqual(extended);
        expect(await readFile(f.statePath, 'utf8')).toBe(bytes);
        expect(writes).not.toHaveBeenCalled();
        expect(selections).not.toHaveBeenCalled();
    });
    it('rejects an OS candidate retained by a stopped worktree without imposing an attempt cutoff', async () => {
        const f = await fixture();
        await mkdir(join(f.root, 'host'));
        await writeFile(f.statePath, JSON.stringify({ v: 1, assignments: {
            [f.first]: { ports: [41001], listenerPorts: {} },
        } }));
        // Port selection is the OS boundary; retained-assignment decisions remain real.
        const select = vi.spyOn(loopback, 'reserveLoopbackPort')
            .mockResolvedValueOnce({ host: '127.0.0.1', port: 41001, release: async () => {} })
            .mockResolvedValueOnce({ host: '127.0.0.1', port: 41002, release: async () => {} });
        expect(await f.owner.assign({ rootPath: f.second, slots: 1 })).toMatchObject({ kind: 'ready', assignment: { ports: [41002] } });
        expect(select).toHaveBeenCalledTimes(2);
    });
    it('reports the TCP port-space boundary without selecting or changing retained bytes', async () => {
        const f = await fixture();
        await mkdir(join(f.root, 'host'));
        const bytes = JSON.stringify({ v: 1, assignments: {
            [f.first]: { ports: Array.from({ length: 65535 }, (_, index) => index + 1), listenerPorts: {} },
        } });
        await writeFile(f.statePath, bytes);
        const select = vi.spyOn(loopback, 'reserveLoopbackPort');
        expect(await f.owner.assign({ rootPath: f.second, slots: 1 })).toMatchObject({
            kind: 'unavailable', reason: 'port_selection_failed', causeCode: 'EADDRNOTAVAIL',
        });
        expect(select).not.toHaveBeenCalled();
        expect(await readFile(f.statePath, 'utf8')).toBe(bytes);
    });
    it('uses one physical-root identity and preserves independent named listener demands without opting into project PORT', async () => {
        const f = await fixture();
        const alias = join(f.root, 'alias');
        await symlink(f.first, alias, process.platform === 'win32' ? 'junction' : 'dir');
        const first = await f.owner.assign({ rootPath: f.first, listenerKeys: ['dbw.capture', 'dbw.otlp'] });
        const same = await f.owner.assign({ rootPath: alias, listenerKeys: ['dbw.capture', 'dbw.otlp'] });
        expect(same).toEqual(first);
        expect(first).toMatchObject({ kind: 'ready', assignment: { ports: [], listenerPorts: {
            'dbw.capture': expect.any(Number), 'dbw.otlp': expect.any(Number),
        } } });
        if (first.kind !== 'ready') throw new Error('assignment unavailable');
        expect(new Set(Object.values(first.assignment.listenerPorts)).size).toBe(2);
    });
    it('retains assignments on damaged host state and refuses active reassignment', async () => {
        const f = await fixture();
        await f.owner.assign({ rootPath: f.first, slots: 1 });
        const bytes = await readFile(f.statePath, 'utf8');
        expect(await f.owner.reassign({ rootPath: f.first, slots: 1, isActive: true })).toMatchObject({ kind: 'unavailable', code: 'project_worktree_ports_active' });
        expect(await readFile(f.statePath, 'utf8')).toBe(bytes);
        await writeFile(f.statePath, '{damaged');
        expect(await createWorktreePortsOwner({ statePath: f.statePath }).assign({ rootPath: f.second, slots: 1 }))
            .toMatchObject({ kind: 'unavailable', code: 'project_worktree_ports_unavailable' });
        expect(await readFile(f.statePath, 'utf8')).toBe('{damaged');
    });
    it('releases only a successfully removed root and honors cancellation before mutation', async () => {
        const f = await fixture();
        await f.owner.assign({ rootPath: f.first, slots: 1 });
        const second = await f.owner.assign({ rootPath: f.second, slots: 1 });
        const aborted = new AbortController();
        aborted.abort();
        expect(await f.owner.assign({ rootPath: f.first, slots: 2, signal: aborted.signal })).toMatchObject({ kind: 'unavailable', code: 'cancelled' });
        const capturedRoot = await realpath(f.first);
        await rm(f.first, { recursive: true });
        await f.owner.release({ rootPath: capturedRoot });
        expect(await f.owner.assign({ rootPath: f.second, slots: 1 })).toEqual(second);
        const state = JSON.parse(await readFile(f.statePath, 'utf8'));
        expect(Object.keys(state.assignments)).toHaveLength(1);
    });
    it('explicit stopped reassignment excludes its old vector and every retained sibling', async () => {
        const f = await fixture();
        const first = await f.owner.assign({ rootPath: f.first, slots: 2, listenerKeys: ['dbw.capture'] });
        const sibling = await f.owner.assign({ rootPath: f.second, slots: 1 });
        const reassigned = await f.owner.reassign({ rootPath: f.first, isActive: false });
        if (first.kind !== 'ready' || sibling.kind !== 'ready' || reassigned.kind !== 'ready') throw new Error('assignment unavailable');
        const prior = new Set([...first.assignment.ports, ...Object.values(first.assignment.listenerPorts), ...sibling.assignment.ports]);
        expect(reassigned.assignment.ports).toHaveLength(2);
        expect(Object.keys(reassigned.assignment.listenerPorts)).toEqual(['dbw.capture']);
        expect([...reassigned.assignment.ports, ...Object.values(reassigned.assignment.listenerPorts)].some(port => prior.has(port))).toBe(false);
    });
    it('reads without allocating and retains an assignment when an external process binds its stopped port', async () => {
        const f = await fixture();
        expect(await f.owner.read({ rootPath: f.first })).toEqual({ kind: 'ready', assignment: { ports: [], listenerPorts: {} } });
        await expect(readFile(f.statePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        const assigned = await f.owner.assign({ rootPath: f.first, slots: 1 });
        if (assigned.kind !== 'ready') throw new Error('assignment unavailable');
        const listener = createServer();
        await new Promise<void>((resolve, reject) => {
            listener.once('error', reject);
            listener.listen(assigned.assignment.ports[0], '127.0.0.1', resolve);
        });
        try {
            const bytes = await readFile(f.statePath, 'utf8');
            const selections = vi.spyOn(loopback, 'reserveLoopbackPort');
            expect(await f.owner.assign({ rootPath: f.first, slots: 1 })).toEqual(assigned);
            expect(await f.owner.read({ rootPath: f.first })).toEqual(assigned);
            expect(selections).not.toHaveBeenCalled();
            expect(await readFile(f.statePath, 'utf8')).toBe(bytes);
        } finally {
            await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
        }
    });
    it('preserves a valid JSON ledger containing conflicting retained assignments for explicit recovery', async () => {
        const f = await fixture();
        await mkdir(join(f.root, 'host'));
        const bytes = JSON.stringify({ v: 1, assignments: {
            [f.first]: { ports: [41001], listenerPorts: {} },
            [f.second]: { ports: [], listenerPorts: { 'dbw.otlp': 41001 } },
        } });
        await writeFile(f.statePath, bytes);
        const selections = vi.spyOn(loopback, 'reserveLoopbackPort');
        expect(await f.owner.assign({ rootPath: f.first, slots: 1 })).toMatchObject({ kind: 'unavailable', reason: 'state_corrupt' });
        expect(await f.owner.reassign({ rootPath: f.first, isActive: false })).toMatchObject({ kind: 'unavailable', reason: 'state_corrupt' });
        expect(selections).not.toHaveBeenCalled();
        expect(await readFile(f.statePath, 'utf8')).toBe(bytes);
    });
    it('settles a cancelled extension without publishing a partial vector or retaining a reservation', async () => {
        const f = await fixture();
        const before = await f.owner.assign({ rootPath: f.first, slots: 1 });
        const bytes = await readFile(f.statePath, 'utf8');
        const cancellation = new AbortController();
        const release = vi.fn(async () => {});
        vi.spyOn(loopback, 'reserveLoopbackPort').mockImplementationOnce(async () => {
            cancellation.abort();
            return { host: '127.0.0.1', port: 41003, release };
        });
        expect(await f.owner.assign({ rootPath: f.first, slots: 2, signal: cancellation.signal }))
            .toMatchObject({ kind: 'unavailable', code: 'cancelled' });
        expect(release).toHaveBeenCalledOnce();
        expect(await readFile(f.statePath, 'utf8')).toBe(bytes);
        expect(await f.owner.assign({ rootPath: f.first, slots: 1 })).toEqual(before);
    });
});
