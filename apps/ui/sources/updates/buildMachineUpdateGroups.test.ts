import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

import type { MachineCapabilitiesSnapshot } from '@/hooks/server/useMachineCapabilitiesCache';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { projectMachineAgent } from '@/agents/machineAgents/machineAgentModel';

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
    it('tells two machines with the same name apart, as every other machine list does', () => {
        const first = machine('f98b1234', { host: 'lima-happier-fresh' });
        const second = { ...machine('b8fe5678', { host: 'lima-happier-fresh' }), active: false } as Machine;
        const { groups } = buildMachineUpdateGroups({
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
        const { groups } = buildMachineUpdateGroups({
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
        const { groups } = buildMachineUpdateGroups({
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
        const { groups } = buildMachineUpdateGroups({
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
        const { groups } = buildMachineUpdateGroups({
            machines: [machine('laptop')],
            thisMachineId: 'laptop',
            thisComputerItem: null,
            runs: NO_RUNS,
            machineAgents: new Map([['laptop', { status: 'ready', lastCheckedAt: 8_000, agents: [projectMachineAgent({
                agentId: 'claude', title: 'Claude Code', checking: false, stale: false, connectedServices: [], job: null,
                facts: {
                    agentId: 'claude', title: 'Claude Code',
                    installed: true, version: '2.1.4', latestVersion: '2.1.4', update: { supported: true, command: null },
                    signIn: { status: 'signedIn', loginSupport: 'login_terminal' },
                    platform: { supported: true },
                    install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null },
                    dependencies: [],
                },
            })] }]]),
            snapshots: new Map([['laptop', snapshot]]),
        });
        expect(groups.map((group) => group.kind)).toEqual(['thisComputer']);
        expect(buildUpdatesSummary(groups.flatMap((group) => group.items))).toMatchObject({ actionableCount: 0 });
        expect(groups[0]?.items.find((item) => item.subject.kind === 'agent-cli')).toMatchObject({ state: 'upToDate', currentVersion: '2.1.4' });
    });

    it('an online machine whose tools were never checked is "not checked", never "up to date"', () => {
        const { groups, uncheckedMachineCount } = buildMachineUpdateGroups({
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
        const { groups } = buildMachineUpdateGroups({
            machines: [machine('laptop')], thisMachineId: 'laptop', thisComputerItem: null, runs: NO_RUNS,
            machineAgents: new Map([['laptop', { status: 'error', lastCheckedAt: null, agents: [projectMachineAgent({ agentId: 'claude', title: 'Claude Code', facts: null, checking: false, stale: true, connectedServices: [], job: null })] }]]),
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
        const { uncheckedMachineCount } = buildMachineUpdateGroups({
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
        const { groups } = buildMachineUpdateGroups({
            machines: [machine('laptop')], thisMachineId: 'laptop', thisComputerItem: null, runs: NO_RUNS, machineAgents: new Map(), snapshots: new Map([['laptop', snapshot]]),
        });
        const row = groups.flatMap((group) => group.items).find((item) => item.id === `laptop:installable:${helper.key}`);
        expect(row).toMatchObject({ state: 'unknown', failure: { kind: 'latestUnknown' }, action: { kind: 'none' } });
    });

    it('reports when the machines\' update facts were last checked (the header\'s "Checked …" line)', () => {
        const at = (checkedAt: number): MachineCapabilitiesSnapshot => ({
            response: { protocolVersion: 1, results: { 'tool.systemTasks': { ok: true, checkedAt, data: { kinds: [] } } } },
        });
        const { checkedAt } = buildMachineUpdateGroups({
            machines: [machine('laptop'), machine('studio')], thisMachineId: 'laptop', thisComputerItem: null, runs: NO_RUNS,
            machineAgents: new Map(), snapshots: new Map([['laptop', at(1_000)], ['studio', at(5_000)]]),
        });
        expect(checkedAt).toBe(5_000);
    });
});
