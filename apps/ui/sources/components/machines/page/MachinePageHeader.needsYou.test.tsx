import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { getStorage } from '@/sync/domains/state/storageStore';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: rpc }));

// Modal presentation is the platform boundary.
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ renderCustomModals: true }).module);
const { ModalProvider } = await import('@/modal');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { MachinePageHeader } = await import('./MachinePageHeader');

afterEach(() => standardCleanup());

const calm = { v: 1, vitals: { state: 'reporting' }, host: { logicalCores: 4, memoryTotalBytes: 100, bootedAt: 1 }, attention: { level: 'calm', reasons: [] } };
const pressure = { level: 'needs_you', reasons: [{ key: 'memory', level: 'needs_you', since: 1, metric: 'memory', nextStep: 'review_processes', kind: 'memory_pressure', pressure: 'critical', swapping: false }] };

it('keeps the action row the same size when a machine comes to need you: the terminal steps into the menu, so the title never wraps', async () => {
    const homes = await serveAccountHomes({
        homes: [{ key: 'a', serverUrl: 'https://needs-you.test', accountId: 'owner', currentAccount: true }],
        route: request => request.path === '/v1/machines/read-batch' ? createMachineReadBatchResponseFixture(request.body,
            id => createPlainMachineRowFixture({ id, accountId: 'owner' })) : undefined,
    });
    const serverId = homes.homes.a!.id;
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    rpc.mockResolvedValue({ ok: true, terminals: [], machineShell: { ok: true, cwd: '/home/qa' } });
    const store = getStorage();
    const previous = store.getState();
    const machine = createMachineFixture({ id: 'pressed', active: true, activeAt: Date.now(), isShared: false,
        metadata: { ...createMachineFixture({ id: 'pressed' }).metadata!, homeDir: '/home/qa' },
        daemonState: { resources: { ...calm, attention: pressure } } });
    store.getState().applyMachines([machine], true);
    const target = { machineId: machine.id, requestedServerId: serverId, serverId, activeServerId: serverId, machine, online: true,
        machineName: 'Pressed', machineSentenceName: 'Pressed', isServerSwitching: false, isHydratingMachine: false, switchReady: true };
    const screen = await renderScreen(<ModalProvider>
        <MachinePageHeader target={target} managedIdentity={null} renaming={false} onRename={() => {}} />
    </ModalProvider>);
    try {
        expect(screen.findByTestId('machine-detail-needs-you-action')).not.toBeNull();
        expect(screen.findByTestId('machine-detail-open-terminal')).toBeNull();
        await vi.waitFor(() => {
            const menu = screen.findAllByType(DropdownMenu).find((candidate) => candidate.props.testID === 'machine-detail-menu');
            expect(JSON.stringify(menu?.props.items ?? menu?.props.actions ?? [])).toContain('open-terminal');
        });
    } finally {
        await screen.unmount();
        await homes.dispose();
        store.setState(previous);
    }
});
