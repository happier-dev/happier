import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { createProcessesAnswer } from '@/components/machines/processes/testkit/processesAnswerFixture';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const boundary = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
// Only the network boundary is replaced; Actions, projections, hooks and render bodies stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () =>
    (await import('@/dev/testkit/mocks/serverScopedRpc')).createServerScopedMachineRpcBoundaryMock(boundary.rpc));
installDisconnectedServerSocketBoundary();
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { machineResourceStore } = await import('@/sync/domains/machines/resources/machineResourceStore');
const { machineStorageStore } = await import('@/sync/domains/machines/storage/machineStorageStore');
const { machineProcessesStore } = await import('@/sync/domains/machines/processes/machineProcessesStore');
const { MachineVitalsOverview } = await import('./MachineVitalsOverview');
const { MachineMonitoringRows } = await import('./MachineMonitoringRows');
const { MachineUsingTheMost } = await import('./MachineUsingTheMost');
const { DiskTile } = await import('./DiskTile');

afterEach(() => {
    standardCleanup();
    machineResourceStore.reset();
    machineStorageStore.reset();
    machineProcessesStore.reset();
    boundary.rpc.mockReset();
});

it('keeps three changing process and storage publications at their leaves while vitals leave monitoring untouched', async () => {
    const serverId = 'srv_vitals_publications';
    await home.addHome({ name: 'Publication Home', serverUrl: 'https://vitals-publications.test',
        serverIdentityId: serverId, accountId: 'owner', currentAccount: true });
    const machine = createMachineFixture({ id: 'machine', active: true, activeAt: Date.now(), storageMode: 'plain' });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [machine]);
    let at = Date.now();
    let cpuBusy = 12;
    let memoryBytes = 1_000_000;
    let storageBytes = 4_000_000_000;
    const owner = createProcessesAnswer().owners[0]!;
    boundary.rpc.mockImplementation(({ method }: { method: string }) => {
        if (method.includes('watch') || method.includes('history')) return new Promise(() => {});
        if (method === RPC_METHODS.MACHINES_PROCESSES_LIST) return Promise.resolve({
            v: 1, machineId: machine.id, capturedAtMs: at, state: 'live', platform: 'linux', evidenceModel: 'fenced',
            owners: [{ ...owner, totals: { ...owner.totals, memoryBytes } }], leftBehind: [],
            totals: { happier: { ...owner.totals, memoryBytes }, leftBehind: { processCount: 0, memoryBytes: 0 } },
        });
        if (method === RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET) return Promise.resolve({
            revision: at, sizedAt: at, volumes: [{ volume: { volumeId: 'disk', mountPath: '/', label: 'Disk' },
                totalBytes: 100_000_000_000, freeBytes: 80_000_000_000, happierBytes: storageBytes, pileBytes: 0, trashBytes: 0 }],
            categories: [], suggestionsTop: [], pile: { count: 0, freesBytes: 0, droppedSinceLastView: [] },
            trash: { count: 0, allocatedBytes: 0 }, wholeDisk: { enabled: false, scans: [] },
        });
        if (method.includes('vitals') && !method.includes('summaries')) return Promise.resolve({ state: 'reporting', sample: {
            v: 1, sampledAt: at, intervalMs: 2_000, cpu: { reported: true, busyPct: cpuBusy },
            memory: { reported: true, totalBytes: 100, availableBytes: 80, usedBytes: 20, pressure: { level: 'calm', source: 'psi' } },
            disk: { reported: true, volumes: [{ id: 'disk', mount: '/', label: 'Disk', totalBytes: 100_000_000_000, availableBytes: 80_000_000_000 }] },
            network: { reported: true, rxBps: 12, txBps: 3 },
        }, series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] }, attention: { level: 'calm', reasons: [] } });
        return new Promise(() => {});
    });
    const vitalsKey = { serverId, machineId: machine.id, expectedAccountId: 'owner', view: 'overview' as const };
    const storageKey = { serverId, machineId: machine.id, expectedAccountId: 'owner' };
    const processKey = { serverId, machineId: machine.id, accountId: 'owner', scope: 'happier' as const, view: 'owners' as const };
    await machineResourceStore.read(vitalsKey);
    await machineStorageStore.read(storageKey);
    await machineProcessesStore.read(processKey);
    expect(machineResourceStore.getState(vitalsKey).status).toBe('ready');
    expect(machineStorageStore.getState(storageKey).status).toBe('ready');
    expect(machineProcessesStore.getState(processKey).status).toBe('ready');

    // A subtree Profiler includes correctly-local descendant commits. Count the real memo bodies instead.
    const vitals = vi.spyOn(MachineVitalsOverview as unknown as { type: (props: React.ComponentProps<typeof MachineVitalsOverview>) => React.ReactNode }, 'type');
    const monitoring = vi.spyOn(MachineMonitoringRows as unknown as { type: (props: React.ComponentProps<typeof MachineMonitoringRows>) => React.ReactNode }, 'type');
    const processes = vi.spyOn(MachineUsingTheMost as unknown as { type: (props: React.ComponentProps<typeof MachineUsingTheMost>) => React.ReactNode }, 'type');
    const disk = vi.spyOn(DiskTile as unknown as { type: (props: React.ComponentProps<typeof DiskTile>) => React.ReactNode }, 'type');
    onTestFinished(() => { vitals.mockRestore(); monitoring.mockRestore(); processes.mockRestore(); disk.mockRestore(); });
    const screen = await renderScreen(<MachineVitalsOverview serverId={serverId} machine={machine}
        machineName="Publication Machine" online onOpenProcesses={() => {}} />);
    expect(screen.findByTestId('machine-vitals-sheet')).not.toBeNull();
    expect(vitals).toHaveBeenCalled();
    const counts: Record<string, Record<string, number>> = {};
    for (const family of ['vitals', 'processes', 'storage']) {
        vitals.mockClear(); monitoring.mockClear(); processes.mockClear(); disk.mockClear();
        for (let index = 0; index < 3; index++) await act(async () => {
            at += 2_000;
            if (family === 'vitals') { cpuBusy += 1; await machineResourceStore.read(vitalsKey); }
            if (family === 'processes') { memoryBytes += 1_000_000; await machineProcessesStore.read(processKey); }
            if (family === 'storage') { storageBytes += 1_000_000_000; await machineStorageStore.read(storageKey); }
        });
        counts[family] = { vitals: vitals.mock.calls.length, monitoring: monitoring.mock.calls.length,
            processes: processes.mock.calls.length, disk: disk.mock.calls.length };
    }
    console.info('three changing publications per family', counts);
    expect(counts.vitals?.vitals).toBe(3);
    for (const row of Object.values(counts)) expect(row.monitoring).toBe(0);
    expect(counts.processes).toEqual({ vitals: 0, monitoring: 0, processes: 3, disk: 0 });
    expect(counts.storage).toEqual({ vitals: 0, monitoring: 0, processes: 0, disk: 3 });
    await screen.unmount();
});
