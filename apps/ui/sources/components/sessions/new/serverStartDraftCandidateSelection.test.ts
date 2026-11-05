import { describe, expect, it } from 'vitest';

import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';

import {
    findSessionServerStartCandidateForDirectory,
    presentSessionPlacementCandidates,
    resolveSessionServerStartCandidateSelection,
} from './serverStartDraftCandidateSelection';

describe('Session server-start candidate selection', () => {
    it('uses settled exact-machine absence for both candidate readiness and its machine caption', () => {
        const stale = createMachineFixture({ id: 'machine-gone', active: true, activeAt: Date.now() });
        const other = createMachineFixture({ id: 'machine-other' });
        const candidate = { projectKey: { id: 'project-gone' }, serverId: 'server-a', machineId: stale.id,
            rootPath: '/repo', reachable: true, worktrees: [] };
        const context = { activeServerId: 'server-a', activeMachines: [stale],
            machineListByServerId: { 'server-a': [other] }, machineListStatusByServerId: { 'server-a': 'idle' as const } };
        expect(resolveSessionServerStartCandidateSelection({ mountedTarget: candidate, ...context })).toMatchObject({
            machine: null, machineReady: false,
        });
        expect(presentSessionPlacementCandidates({ candidates: [candidate], ...context })[0]).toMatchObject({
            title: 'repo', subtitle: 'Unlisted machine · /repo', availability: 'unavailable',
        });
    });

    it('keeps the selected server, machine, path, and readiness on one candidate', () => {
        const mountedMachine = createMachineFixture({
            id: 'shared-machine-id',
            active: false,
            activeAt: 0,
        });
        const selectedMachine = createMachineFixture({
            id: 'shared-machine-id',
            active: true,
            activeAt: Date.now(),
            metadata: {
                host: 'selected.example',
                platform: 'darwin',
                happyCliVersion: '1.0.0',
                happyHomeDir: '/selected/.happier',
                homeDir: '/selected',
            },
        });
        const candidate = {
            projectKey: { id: 'project-selected' },
            serverId: 'server-selected',
            machineId: 'shared-machine-id',
            rootPath: '/selected/project',
            reachable: true,
            worktrees: [],
        };

        const selection = resolveSessionServerStartCandidateSelection({
            accountScope: { serverId: 'server-selected', accountId: 'selected-account' },
            mountedTarget: { serverId: 'server-mounted', machineId: 'shared-machine-id' },
            selectedCandidate: candidate,
            activeServerId: 'server-mounted',
            activeMachines: [mountedMachine],
            machineListByServerId: { 'server-selected': [selectedMachine] },
        });

        expect(selection).toEqual({
            candidate,
            target: { serverId: 'server-selected', machineId: 'shared-machine-id' },
            machine: selectedMachine,
            directory: '/selected/project',
            machineReady: true,
        });
    });

    it('presents a placement candidate by its home-relative folder and machine name, never raw ids', () => {
        const machine = createMachineFixture({
            id: 'machine-id-1',
            activeAt: Date.now(),
            metadata: {
                host: 'studio.local',
                platform: 'darwin',
                happyCliVersion: '1.0.0',
                happyHomeDir: '/Users/ada/.happier',
                homeDir: '/Users/ada',
                displayName: 'Studio',
            },
        });
        const candidate = {
            projectKey: { id: 'project-1' },
            serverId: 'server-1',
            machineId: 'machine-id-1',
            rootPath: '/Users/ada/code/app',
            reachable: true,
            worktrees: [],
        };
        const context = { activeServerId: 'server-1', activeMachines: [machine], machineListByServerId: {} };

        const accountScope = { serverId: 'server-1', accountId: 'account-1' };
        const present = (input: typeof candidate & { label?: string }) => presentSessionPlacementCandidates({ candidates: [input], accountScope, ...context })[0]!;
        expect(present(candidate)).toMatchObject({ title: 'app', subtitle: 'Studio · ~/code/app', availability: 'available' });
        expect(present({ ...candidate, label: 'App' }).title).toBe('App');
        // A machine this device cannot see is said so, never named by its id.
        const unseen = present({ ...candidate, machineId: 'unknown-machine' });
        expect(unseen.subtitle).toBe('Unlisted machine · /Users/ada/code/app');
        expect(unseen.subtitle).not.toContain('unknown-machine');
    });

    it('lists the people-readable rows of live projects first, offline and historic ones below with their reason', () => {
        const live = createMachineFixture({ id: 'machine-live', active: true, activeAt: Date.now(),
            metadata: { host: 'box', platform: 'linux', happyCliVersion: '1', happyHomeDir: '/home/a/.happier', homeDir: '/home/a', displayName: 'Build box' } });
        const twin = createMachineFixture({ id: 'machine-twin', active: true, activeAt: Date.now(),
            metadata: { host: 'box', platform: 'linux', happyCliVersion: '1', happyHomeDir: '/home/a/.happier', homeDir: '/home/a', displayName: 'Build box' } });
        const asleep = createMachineFixture({ id: 'machine-asleep', active: false, activeAt: 0,
            metadata: { host: 'lap', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '/Users/a/.happier', homeDir: '/Users/a', displayName: 'Laptop' } });
        const at = (machineId: string, rootPath: string) => ({ projectKey: { id: rootPath }, serverId: 'srv_raw_home_id', machineId, rootPath, reachable: true, worktrees: [] });
        const removed = createMachineFixture({ id: 'machine-removed', active: true, activeAt: Date.now(), revokedAt: 1,
            metadata: { host: 'old', platform: 'linux', happyCliVersion: '1', happyHomeDir: '/home/o/.happier', homeDir: '/home/o', displayName: 'Old box' } });
        const candidates = [at('machine-gone-1234', '/old/retired'), at(asleep.id, '/Users/a/notes'), at(live.id, '/home/a/app'), at(twin.id, '/home/a/site'), at(removed.id, '/home/o/past')];
        const rows = presentSessionPlacementCandidates({ candidates, accountScope: { serverId: 'srv_raw_home_id', accountId: 'account-1' }, activeServerId: 'srv_raw_home_id',
            activeMachines: [live, twin, asleep, removed], machineListByServerId: { srv_raw_home_id: [live, twin, asleep, removed] },
            machineListStatusByServerId: { srv_raw_home_id: 'idle' } });
        expect(rows.map(row => row.title)).toEqual(['app', 'site', 'notes', 'retired', 'past']);
        // Each row still answers for the candidate it stands for, whatever the order.
        expect(rows.map(row => row.index)).toEqual([2, 3, 1, 0, 4]);
        expect(rows[2]).toMatchObject({ availability: 'unavailable', subtitle: 'Offline · Laptop · ~/notes' });
        expect(rows[3]).toMatchObject({ availability: 'unavailable', subtitle: 'Unlisted machine · /old/retired' });
        expect(rows[4]).toMatchObject({ availability: 'unavailable', subtitle: 'Removed machine · Old box · ~/past' });
        // Two machines with one name are told apart the way Sessions and Search do it.
        expect(rows[0]!.subtitle).not.toBe(rows[1]!.subtitle?.replace('~/site', '~/app'));
        for (const row of rows) {
            expect(row.subtitle).not.toContain('srv_raw_home_id');
            expect(row.subtitle).not.toContain(row.candidate.machineId);
        }
    });

    it('claims nothing about a Machine whose Home has not answered yet', () => {
        const candidate = { projectKey: { id: 'project-1' }, serverId: 'server-b', machineId: 'machine-1', rootPath: '/work/app', reachable: true, worktrees: [] };
        expect(presentSessionPlacementCandidates({ candidates: [candidate], activeServerId: 'server-a', activeMachines: [],
            machineListByServerId: {}, machineListStatusByServerId: { 'server-b': 'loading' } })[0]).toMatchObject({
            title: 'app', subtitle: '/work/app', availability: 'unknown',
        });
    });

    it('marks as selected only the candidate on the chosen machine whose folder is the edited directory', () => {
        const primary = { projectKey: { id: 'project-primary' }, serverId: 'server-a', machineId: 'machine-1',
            rootPath: '/work/app', reachable: true, worktrees: [] };
        const worktree = { projectKey: { id: 'project-worktree' }, serverId: 'server-a', machineId: 'machine-1',
            rootPath: '/work/app-review', reachable: true, worktrees: [] };
        const elsewhere = { projectKey: { id: 'project-elsewhere' }, serverId: 'server-b', machineId: 'machine-1',
            rootPath: '/work/app', reachable: true, worktrees: [] };
        const candidates = [primary, worktree, elsewhere];
        const target = { serverId: 'server-a', machineId: 'machine-1' };

        expect(findSessionServerStartCandidateForDirectory({ candidates, target, directory: '/work/app' })).toBe(0);
        expect(findSessionServerStartCandidateForDirectory({ candidates, target, directory: ' /work/app-review/ ' })).toBe(1);
        // A typed folder no candidate stands for selects none, and the sibling-prefix path is not the candidate.
        expect(findSessionServerStartCandidateForDirectory({ candidates, target, directory: '/work/app-other' })).toBe(-1);
        expect(findSessionServerStartCandidateForDirectory({ candidates, target, directory: '/work/app/sub' })).toBe(-1);
        expect(findSessionServerStartCandidateForDirectory({ candidates, target, directory: '' })).toBe(-1);
        // The same folder on another Home is another candidate, not this one.
        expect(findSessionServerStartCandidateForDirectory({
            candidates, target: { serverId: 'server-b', machineId: 'machine-1' }, directory: '/work/app',
        })).toBe(2);
        expect(findSessionServerStartCandidateForDirectory({ candidates: undefined, target, directory: '/work/app' })).toBe(-1);
    });
});
