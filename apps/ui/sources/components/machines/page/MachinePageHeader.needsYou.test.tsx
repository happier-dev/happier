import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { getStorage } from '@/sync/domains/state/storageStore';
import { createHydratedPlainMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';

// Modal presentation is the platform boundary.
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ renderCustomModals: true }).module);
const { ModalProvider } = await import('@/modal');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { MachinePageHeader } = await import('./MachinePageHeader');

afterEach(() => standardCleanup());

const calm = { v: 1, vitals: { state: 'reporting' }, host: { logicalCores: 4, memoryTotalBytes: 100, bootedAt: 1 }, attention: { level: 'calm', reasons: [] } };
const pressure = { level: 'needs_you', reasons: [{ key: 'memory', level: 'needs_you', since: 1, metric: 'memory', nextStep: 'review_processes', kind: 'memory_pressure', pressure: 'critical', swapping: false }] };

it('offers the needs-you action and moves the available Shell into the Machine menu', async () => {
    const serverUrl = 'https://needs-you.test';
    const serverIdentityId = 'srv_needs_you';
    const shell = await createExternalActionAccountHttpBoundary({ serverUrl, serverIdentityId, accountId: 'owner',
        machineId: 'pressed', actionId: 'machines.terminal.list', tokenEpoch: 0, requesterInvocation: 'credentials',
        execute: () => ({ ok: true, terminals: [], machineShell: { ok: true, cwd: '/home/qa' } }) });
    const machine = createHydratedPlainMachineFixture({ id: 'pressed', accountId: 'owner', machine: { active: true, activeAt: Date.now(), isShared: false,
        installationPublicKey: shell.machine.installationPublicKey,
        metadata: { ...createMachineFixture({ id: 'pressed' }).metadata!, homeDir: '/home/qa' },
        daemonState: { resources: { ...calm, attention: pressure } } } });
    const row = createPlainMachineRowFixture({ id: machine.id, accountId: 'owner', machine });
    const homes = await serveAccountHomes({
        homes: [{ key: 'a', serverUrl, serverIdentityId, accountId: 'owner', currentAccount: true }],
        route: async request => {
            if (request.path === '/v1/machines') return Response.json([row]);
            if (request.path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(request.body, id => id === machine.id ? row : null);
            if (request.path === `/v1/machines/${machine.id}`) return Response.json({ machine: row });
            return await shell.handle(request.url, { method: request.method, headers: request.headers,
                body: request.body === undefined ? undefined : JSON.stringify(request.body), signal: request.signal }) ?? undefined;
        },
    });
    const serverId = homes.homes.a!.id;
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    const store = getStorage();
    const previous = store.getState();
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [machine]);
    const target = { machineId: machine.id, requestedServerId: serverId, serverId, activeServerId: serverId, machine, online: true,
        machineName: 'Pressed', machineSentenceName: 'Pressed', isServerSwitching: false, isHydratingMachine: false, switchReady: true };
    const screen = await renderScreen(<ModalProvider>
        <MachinePageHeader target={target} managedIdentity={null} renaming={false} onRename={() => {}} />
    </ModalProvider>);
    try {
        await vi.waitFor(() => {
            const menu = screen.findAllByType(DropdownMenu).find((candidate) => candidate.props.testID === 'machine-detail-menu');
            expect(menu?.props.items).toContainEqual(expect.objectContaining({ id: 'open-terminal' }));
        });
        expect(screen.findByTestId('machine-detail-needs-you-action')).not.toBeNull();
        expect(screen.findByTestId('machine-detail-open-terminal')).toBeNull();
    } finally {
        await screen.unmount();
        await homes.dispose();
        store.setState(previous);
    }
});
