import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { getStorage } from '@/sync/domains/state/storageStore';
import { createHydratedPlainMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';

// Modal presentation is the platform boundary.
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ renderCustomModals: true }).module);
const { ModalProvider } = await import('@/modal');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { MachinePageHeader } = await import('./MachinePageHeader');

afterEach(() => standardCleanup());

const calm = { v: 1, vitals: { state: 'reporting' }, host: { logicalCores: 4, memoryTotalBytes: 100, bootedAt: 1 }, attention: { level: 'calm', reasons: [] } };
const pressure = { level: 'needs_you', reasons: [{ key: 'memory', level: 'needs_you', since: 1, metric: 'memory', nextStep: 'review_processes', kind: 'memory_pressure', pressure: 'critical', swapping: false }] };

it('keeps the action row the same size when a machine comes to need you: the terminal steps into the menu, so the title never wraps', async () => {
    const serverUrl = 'https://needs-you.test';
    const serverIdentityId = 'srv_needs_you';
    const shell = await createExternalActionAccountHttpBoundary({ serverUrl, serverIdentityId, accountId: 'owner',
        machineId: 'pressed', actionId: 'machines.terminal.list', tokenEpoch: 0, requesterInvocation: 'credentials',
        execute: () => ({ ok: true, terminals: [], machineShell: { ok: true, cwd: '/home/qa' } }) });
    const homes = await serveAccountHomes({
        homes: [{ key: 'a', serverUrl, serverIdentityId, accountId: 'owner', currentAccount: true }],
        route: request => shell.handle(request.url, { method: request.method, headers: request.headers,
            body: request.body === undefined ? undefined : JSON.stringify(request.body), signal: request.signal })
            .then(response => response ?? undefined),
    });
    const serverId = homes.homes.a!.id;
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    const store = getStorage();
    const previous = store.getState();
    const machine = createHydratedPlainMachineFixture({ id: 'pressed', accountId: 'owner', machine: { active: true, activeAt: Date.now(), isShared: false,
        metadata: { ...createMachineFixture({ id: 'pressed' }).metadata!, homeDir: '/home/qa' },
        daemonState: { resources: { ...calm, attention: pressure } } } });
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
