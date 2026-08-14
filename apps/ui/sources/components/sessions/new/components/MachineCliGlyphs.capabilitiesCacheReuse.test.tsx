import * as React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installMachineComponentCommonModuleMocks } from '@/components/machines/machineComponentTestHelpers';
import { MachineCliGlyphs } from './MachineCliGlyphs';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installMachineComponentCommonModuleMocks();

const detectCalls = vi.hoisted(() => ({ machineIds: [] as string[] }));
const daemonStateVersionRef = vi.hoisted(() => ({ current: 1 }));

// `machineCapabilitiesDetect` is the machine RPC boundary (`capabilities.detect` is routed per
// machine daemon), so it is mocked here; everything below it — the module-level capabilities
// cache, the daemon-scoped cache key, and the row component — runs for real.
vi.mock('@/sync/ops', () => ({
    machineCapabilitiesDetect: vi.fn(async (machineId: string) => {
        detectCalls.machineIds.push(machineId);
        return { supported: true, response: { protocolVersion: 1, results: {} } };
    }),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
        serverId: 'server-a',
        serverUrl: 'https://example.test',
        kind: 'stack',
        generation: 1,
    }),
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useMachineCliDetectionTarget: () => ({
        daemonStateVersion: daemonStateVersionRef.current,
        isOnline: true,
    }),
}));

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => ['claude'],
}));

vi.mock('@/agents/registry/AgentIcon', () => ({
    AgentIcon: ({ agentId, testID }: { agentId: string; testID?: string }) =>
        React.createElement('AgentIcon', { testID: testID ?? `machine-cli-logo:${agentId}`, agentId }),
}));

const MACHINE_IDS = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];

describe('MachineCliGlyphs capabilities cache reuse across picker opens', () => {
    beforeEach(() => {
        detectCalls.machineIds = [];
    });

    async function openMachinePicker(serverId = 'server-a') {
        return await renderScreen(
            React.createElement(
                'View',
                null,
                ...MACHINE_IDS.map((machineId) =>
                    React.createElement(MachineCliGlyphs, {
                        key: machineId,
                        machineId,
                        serverId,
                        isOnline: true,
                    }),
                ),
            ),
        );
    }

    it('re-opening the picker with unchanged daemon state performs no capability fetches', async () => {
        const first = await openMachinePicker();
        await first.unmount();
        expect(detectCalls.machineIds.length).toBeGreaterThan(0);

        detectCalls.machineIds = [];
        const second = await openMachinePicker();
        await second.unmount();

        // The capabilities cache is module-scoped, so it must outlive the popover unmount.
        // If this ever regresses, every picker open re-detects every online machine.
        expect(detectCalls.machineIds).toEqual([]);
    });

    it('bumping a machine daemonStateVersion re-detects that machine on the next open', async () => {
        const warm = await openMachinePicker();
        await warm.unmount();

        detectCalls.machineIds = [];
        daemonStateVersionRef.current += 1;
        const afterBump = await openMachinePicker();
        await afterBump.unmount();

        expect([...new Set(detectCalls.machineIds)].sort()).toEqual([...MACHINE_IDS].sort());
    });

    it('detects a machine once even when the same machine is rendered in several picker sections', async () => {
        // The picker renders favorites, recents and "all" from one machine list, so a favorited
        // machine mounts several glyph rows in a single open. Each row asks the cache
        // independently; the shared in-flight fetch must collapse them onto ONE daemon probe.
        const duplicatedMachineId = 'm-duplicated-across-sections';
        const opened = await renderScreen(
            React.createElement(
                'View',
                null,
                ...['favorites', 'recent', 'all'].map((section) =>
                    React.createElement(MachineCliGlyphs, {
                        key: section,
                        machineId: duplicatedMachineId,
                        serverId: 'server-a',
                        isOnline: true,
                    }),
                ),
            ),
        );
        await opened.unmount();

        expect(detectCalls.machineIds.filter((id) => id === duplicatedMachineId)).toEqual([duplicatedMachineId]);
    });
});
