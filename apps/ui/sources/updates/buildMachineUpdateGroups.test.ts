import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

import type { MachineCapabilitiesSnapshot } from '@/hooks/server/useMachineCapabilitiesCache';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { projectMachineAgent } from '@/agents/machineAgents/machineAgentModel';
import { clearMachineRequestReachabilityForTest, recordMachineRequestFailed, recordMachineRequestSucceeded } from '@/sync/domains/machines/reachability/machineReachability';
import { describeUpdatesGroupRow, partitionUncheckedItems, partitionUpdatesPageGroups } from '@/components/updates/describeUpdatesGroupRow';
import { describeUpdateItem } from '@/components/updates/describeUpdateItem';

import { buildMachineUpdateGroups, readUpdatableInstallables } from './buildMachineUpdateGroups';
import { buildUpdatesSummary } from './items/buildUpdatesSummary';

function machine(id: string, metadata: Partial<NonNullable<Machine['metadata']>> = {}): Machine {
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: Date.now(),
        metadata: {
            host: id,
            platform: 'darwin',
            happyCliVersion: '0.2.12',
            happyHomeDir: '/h/.happier',
            homeDir: '/h',
            ...metadata,
        },
    } as Machine;
}

const NO_RUNS = new Map();

describe('buildMachineUpdateGroups (what the always-mounted pill counts)', () => {
    beforeEach(clearMachineRequestReachabilityForTest);

    it('keeps a managed guest CLI visible with its missing release reason instead of Nothing to update', () => {
        const guest = machine('d4bfcc61', { platform: 'linux', happyCliVersion: '0.2.10', cliUpdate: {
            currentVersion: '0.2.10', latestVersion: null, channel: 'stable', installSource: 'managed',
            updateCommand: 'happier self update', canUpdateRemotely: true, lastUpdate: null,
        } });
        const params = { accountScope: { serverId: 'home-a', accountId: 'updates-account' }, machines: [guest],
            thisMachineId: null, thisComputerItem: null, runs: NO_RUNS,
            machineAgents: new Map([[guest.id, ['claude', 'codex'].map(agentId => projectMachineAgent({
                agentId, title: agentId, facts: null, checking: false, stale: false, connectedServices: [], job: null,
            }))]]), snapshots: new Map(), installables: [] };
        const built = buildMachineUpdateGroups(params);
        const item = built.groups[0]!.items[0]!;
        expect(item).toMatchObject({ subject: { kind: 'happier-cli' }, currentVersion: '0.2.10',
            managedBy: 'happier', state: 'unknown', action: { kind: 'none' }, failure: { kind: 'latestUnknown' } });
        expect(partitionUpdatesPageGroups(built.groups)).toMatchObject({ sections: built.groups, quiet: [] });
        expect(partitionUncheckedItems(built.groups[0]!.items).rows).toContain(item);
        expect(describeUpdateItem(item)).toMatchObject({ actionLabel: null });
        expect(describeUpdateItem(item).subtitle).toContain('updates.row.latestUnknown');
        const answered = buildMachineUpdateGroups({ ...params, machines: [machine(guest.id, {
            ...guest.metadata!, cliUpdate: { ...guest.metadata!.cliUpdate!, latestVersion: '0.2.20' },
        })] });
        expect(answered.groups[0]!.items[0]).toMatchObject({ state: 'available', action: { kind: 'run', verb: 'update' } });
    });

    it('retains unknown update facts before the Account scope is available without claiming offline or admitting updates', () => {
        const scope = { serverId: 'home-a', accountId: 'updates-account' };
        const studio = machine('studio');
        const params = { accountScope: null, machines: [studio], thisMachineId: null, thisComputerItem: null,
            runs: NO_RUNS, machineAgents: new Map(), snapshots: new Map() };
        const unknown = buildMachineUpdateGroups(params);
        expect(partitionUpdatesPageGroups(unknown.groups).offline).toHaveLength(0);
        expect(describeUpdatesGroupRow(unknown.groups[0]!)).toMatchObject({
            status: 'updates.settingsSubtitle.unknown', tone: 'neutral', action: null,
        });
        expect(unknown.groups[0]?.items[0]).toMatchObject({ currentVersion: '0.2.12', action: { kind: 'none' } });
        expect(buildUpdatesSummary(unknown.groups.flatMap(group => group.items)).status).not.toBe('offline');
        const offline = buildMachineUpdateGroups({ ...params, accountScope: scope, machines: [{ ...studio, active: false, activeAt: Date.now() - 120_000 }] });
        expect(partitionUpdatesPageGroups(offline.groups).offline).toHaveLength(1);
    });

    it('keeps historical Machines visible without adding them to the current fleet offline count', () => {
        const current = { ...machine('current'), active: false, activeAt: 0 };
        const previous = { ...machine('previous'), active: false, activeAt: 0, replacedByMachineId: 'current' };
        const built = buildMachineUpdateGroups({ accountScope: { serverId: 'home-a', accountId: 'updates-account' },
            machines: [current, previous], thisMachineId: null, thisComputerItem: null,
            runs: NO_RUNS, machineAgents: new Map(), snapshots: new Map() });
        const parts = partitionUpdatesPageGroups(built.groups);
        expect(built.groups).toHaveLength(2);
        expect(parts.offline.map(group => group.machineId)).toEqual(['current']);
        expect(parts.sections.map(group => group.machineId)).toEqual(['previous']);
    });

    it('counts a current offline Machine while its display metadata is unavailable', () => {
        const locked = { ...machine('locked'), active: false, activeAt: 0, metadata: null,
            availability: { kind: 'locked' as const, reason: 'decryption_failed' as const } };
        const built = buildMachineUpdateGroups({ accountScope: { serverId: 'home-a', accountId: 'updates-account' },
            machines: [locked], thisMachineId: null, thisComputerItem: null,
            runs: NO_RUNS, machineAgents: new Map(), snapshots: new Map() });
        expect(partitionUpdatesPageGroups(built.groups).offline.map(group => group.machineId)).toEqual(['locked']);
        expect(built.groups[0]?.items.every(item => item.action.kind === 'none')).toBe(true);
    });

    it('retains update facts and pending runs while failed requests prevent actions, scoped to their Home', () => {
        const studio = machine('studio', {
            cliUpdate: {
                currentVersion: '0.2.12', latestVersion: '0.2.13', channel: 'stable', installSource: 'managed',
                updateCommand: 'happier self update', canUpdateRemotely: true, lastUpdate: null,
            },
        });
        const params = {
            accountScope: { serverId: 'home-a', accountId: 'updates-account' }, machines: [studio], thisMachineId: null, thisComputerItem: null,
            runs: NO_RUNS, machineAgents: new Map(), snapshots: new Map(),
        };
        recordMachineRequestFailed({ serverId: 'home-b', accountId: 'updates-account', machineId: studio.id, observedAtMs: 1 });
        expect(buildMachineUpdateGroups(params).groups[0]?.items[0]?.action.kind).toBe('run');
        recordMachineRequestFailed({ serverId: 'home-a', accountId: 'updates-account', machineId: studio.id, observedAtMs: 2 });
        const unavailable = buildMachineUpdateGroups(params);
        expect(unavailable.groups[0]).toMatchObject({ machineId: 'studio', online: false, items: [{
            id: 'studio:happier-cli', currentVersion: '0.2.12', latestVersion: '0.2.13', action: { kind: 'none' },
        }] });
        expect(unavailable.uncheckedMachineCount).toBe(0);
        const pendingRuns = new Map([['studio:happier-cli', { status: 'accepted' as const, baseline: '' }]]);
        expect(buildMachineUpdateGroups({ ...params, runs: pendingRuns }).groups[0]?.items).toHaveLength(1);
        expect(pendingRuns.get('studio:happier-cli')).toEqual({ status: 'accepted', baseline: '' });
        recordMachineRequestSucceeded({ serverId: 'home-a', accountId: 'updates-account', machineId: studio.id, observedAtMs: 3 });
        expect(buildMachineUpdateGroups(params).groups[0]?.items[0]?.action.kind).toBe('run');
    });

    it.each([
        { replacedByMachineId: 'replacement' },
        { availability: { kind: 'locked' as const, reason: 'decryption_failed' as const } },
    ])('retains a non-selectable machine inventory without offering execution: %j', (unavailable) => {
        const studio = { ...machine('studio', {
            cliUpdate: {
                currentVersion: '0.2.12', latestVersion: '0.2.13', channel: 'stable', installSource: 'managed',
                updateCommand: 'happier self update', canUpdateRemotely: true, lastUpdate: null,
            },
        }), ...unavailable };
        const params = {
            accountScope: { serverId: 'home-a', accountId: 'updates-account' }, machines: [studio], thisMachineId: null, thisComputerItem: null,
            runs: NO_RUNS, machineAgents: new Map(), snapshots: new Map(),
        };
        const { groups, uncheckedMachineCount } = buildMachineUpdateGroups(params);
        expect(groups).toHaveLength(1);
        expect(groups[0]).toMatchObject({ online: true, items: [{
            currentVersion: '0.2.12', latestVersion: '0.2.13', action: { kind: 'none' },
        }] });
        expect(uncheckedMachineCount).toBe(0);
    });

    it('tells two machines with the same name apart, as every other machine list does', () => {
        const first = machine('f98b1234', { host: 'lima-happier-fresh' });
        const second = { ...machine('b8fe5678', { host: 'lima-happier-fresh' }), active: false } as Machine;
        const { groups } = buildMachineUpdateGroups({ accountScope: { serverId: "home-a", accountId: "updates-account" },
            machines: [first, second],
            thisMachineId: null,
            thisComputerItem: null,
            runs: NO_RUNS,
            machineAgents: new Map(), snapshots: new Map(),
        });
        const names = groups.filter((group) => group.kind === 'machine').map((group) => group.machineName);
        expect(new Set(names).size).toBe(2);
    });

    it('carries when an offline machine was last seen, from the machine itself', () => {
        const studio = { ...machine('studio'), active: false, activeAt: 1_700_000_000_000 } as Machine;
        const { groups } = buildMachineUpdateGroups({ accountScope: { serverId: "home-a", accountId: "updates-account" },
            machines: [studio],
            thisMachineId: null,
            thisComputerItem: null,
            runs: NO_RUNS,
            machineAgents: new Map(), snapshots: new Map(),
        });
        expect(groups.find((group) => group.machineId === 'studio')).toMatchObject({ lastSeenAt: 1_700_000_000_000 });
    });

    it('counts a remote CLI update from machine metadata alone, before Updates was ever opened (K5)', () => {
        const studio = machine('studio', {
            cliUpdate: {
                currentVersion: '0.2.12',
                latestVersion: '0.2.13',
                channel: 'stable',
                installSource: 'managed',
                updateCommand: 'happier self update',
                canUpdateRemotely: true,
                lastUpdate: null,
            },
        });
        // No capability detect cached for that machine yet: its `tool.systemTasks` kinds are unknown.
        const { groups } = buildMachineUpdateGroups({ accountScope: { serverId: "home-a", accountId: "updates-account" },
            machines: [studio],
            thisMachineId: null,
            thisComputerItem: null,
            runs: NO_RUNS,
            machineAgents: new Map(), snapshots: new Map(),
        });
        expect(buildUpdatesSummary(groups.flatMap((group) => group.items))).toMatchObject({ actionableCount: 1, phase: 'available' });
    });

    it('does not offer the remote update once the daemon is known not to list cli.update.v1', () => {
        const studio = machine('studio', {
            cliUpdate: {
                currentVersion: '0.2.12', latestVersion: '0.2.13', channel: 'stable', installSource: 'managed',
                updateCommand: 'happier self update', canUpdateRemotely: true, lastUpdate: null,
            },
        });
        const snapshot: MachineCapabilitiesSnapshot = {
            response: { protocolVersion: 1, results: { 'tool.systemTasks': { ok: true, checkedAt: 1, data: { kinds: ['relay.runtime.status.v1'] } } } },
        };
        const { groups } = buildMachineUpdateGroups({ accountScope: { serverId: "home-a", accountId: "updates-account" },
            machines: [studio], thisMachineId: null, thisComputerItem: null, runs: NO_RUNS, machineAgents: new Map(), snapshots: new Map([['studio', snapshot]]),
        });
        expect(buildUpdatesSummary(groups.flatMap((group) => group.items)).actionableCount).toBe(0);
    });

    it('counts an agent CLI update from the canonical inventory rather than raw capability data, on this computer too', () => {
        const snapshot: MachineCapabilitiesSnapshot = {
            response: {
                protocolVersion: 1,
                results: {
                    'cli.claude': {
                        ok: true,
                        checkedAt: 1,
                        data: { available: true, version: '2.1.3', latestVersion: '2.1.4', installSource: 'managed', updateSupported: true, updateCommand: null },
                    },
                },
            },
        };
        const { groups } = buildMachineUpdateGroups({ accountScope: { serverId: "home-a", accountId: "updates-account" },
            machines: [machine('laptop')],
            thisMachineId: 'laptop',
            thisComputerItem: null,
            runs: NO_RUNS,
            machineAgents: new Map([['laptop', [projectMachineAgent({
                agentId: 'claude', title: 'Claude Code', checking: false, stale: false, connectedServices: [], job: null,
                facts: {
                    agentId: 'claude', title: 'Claude Code',
                    installed: true, version: '2.1.4', latestVersion: '2.1.4', update: { supported: true, command: null },
                    signIn: { status: 'signedIn', loginSupport: 'login_terminal' },
                    platform: { supported: true },
                    install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null },
                    dependencies: [],
                },
            })]]]),
            snapshots: new Map([['laptop', snapshot]]),
        });
        expect(groups.map((group) => group.kind)).toEqual(['thisComputer']);
        expect(buildUpdatesSummary(groups.flatMap((group) => group.items))).toMatchObject({ actionableCount: 0 });
        expect(groups[0]?.items.find((item) => item.subject.kind === 'agent-cli')).toMatchObject({ state: 'upToDate', currentVersion: '2.1.4' });
    });

    it('an online machine whose tools were never checked is "not checked", never "up to date"', () => {
        const { groups, uncheckedMachineCount } = buildMachineUpdateGroups({ accountScope: { serverId: "home-a", accountId: "updates-account" },
            machines: [machine('laptop'), machine('studio')],
            thisMachineId: 'laptop',
            thisComputerItem: null,
            runs: NO_RUNS,
            machineAgents: new Map(), snapshots: new Map(),
        });
        expect(uncheckedMachineCount).toBe(2);
        const summary = buildUpdatesSummary(groups.flatMap((group) => group.items), new Map(), { uncheckedMachineCount });
        expect(summary).toMatchObject({ phase: 'none', status: 'unchecked', visible: false });
    });

    it('an agent whose probe errored reads "Couldn\'t check", never up to date', () => {
        const snapshot: MachineCapabilitiesSnapshot = {
            response: { protocolVersion: 1, results: { 'cli.claude': { ok: false, checkedAt: 1, error: { message: 'probe failed' } } } },
        };
        const { groups } = buildMachineUpdateGroups({ accountScope: { serverId: "home-a", accountId: "updates-account" },
            machines: [machine('laptop')], thisMachineId: 'laptop', thisComputerItem: null, runs: NO_RUNS,
            machineAgents: new Map([['laptop', [projectMachineAgent({ agentId: 'claude', title: 'Claude Code', facts: null, checking: false, stale: true, connectedServices: [], job: null })]]]),
            snapshots: new Map([['laptop', snapshot]]),
        });
        const claude = groups.flatMap((group) => group.items).find((item) => item.id === 'laptop:agent:claude');
        expect(claude).toMatchObject({ state: 'unknown', failure: { kind: 'latestUnknown' }, action: { kind: 'none' } });
        expect(buildUpdatesSummary(groups.flatMap((group) => group.items)).status).toBe('unknown');
    });

    it('a machine that answered only part of the update-facts request stays "not checked"', () => {
        const snapshot: MachineCapabilitiesSnapshot = {
            response: {
                protocolVersion: 1,
                results: {
                    'cli.claude': {
                        ok: true,
                        checkedAt: 1,
                        data: { available: true, version: '2.1.4', latestVersion: '2.1.4', installSource: 'managed', updateSupported: true, updateCommand: null },
                    },
                },
            },
        };
        const { uncheckedMachineCount } = buildMachineUpdateGroups({ accountScope: { serverId: "home-a", accountId: "updates-account" },
            machines: [machine('laptop')], thisMachineId: 'laptop', thisComputerItem: null, runs: NO_RUNS, machineAgents: new Map(), snapshots: new Map([['laptop', snapshot]]),
        });
        expect(uncheckedMachineCount).toBe(1);
    });

    it('a helper whose probe errored reads "Couldn\'t check" instead of vanishing', () => {
        const helper = readUpdatableInstallables()[0];
        expect(helper).toBeDefined();
        const snapshot: MachineCapabilitiesSnapshot = {
            response: { protocolVersion: 1, results: { [helper.capabilityId]: { ok: false, checkedAt: 1, error: { message: 'probe failed' } } } },
        };
        const { groups } = buildMachineUpdateGroups({ accountScope: { serverId: "home-a", accountId: "updates-account" },
            machines: [machine('laptop')], thisMachineId: 'laptop', thisComputerItem: null, runs: NO_RUNS, machineAgents: new Map(), snapshots: new Map([['laptop', snapshot]]),
        });
        const row = groups.flatMap((group) => group.items).find((item) => item.id === `laptop:installable:${helper.key}`);
        expect(row).toMatchObject({ state: 'unknown', failure: { kind: 'latestUnknown' }, action: { kind: 'none' } });
    });

    it('reports when the machines\' update facts were last checked (the header\'s "Checked …" line)', () => {
        const at = (checkedAt: number): MachineCapabilitiesSnapshot => ({
            response: { protocolVersion: 1, results: { 'tool.systemTasks': { ok: true, checkedAt, data: { kinds: [] } } } },
        });
        const { checkedAt } = buildMachineUpdateGroups({ accountScope: { serverId: "home-a", accountId: "updates-account" },
            machines: [machine('laptop'), machine('studio')], thisMachineId: 'laptop', thisComputerItem: null, runs: NO_RUNS,
            machineAgents: new Map(), snapshots: new Map([['laptop', at(1_000)], ['studio', at(5_000)]]),
        });
        expect(checkedAt).toBe(5_000);
    });
});
