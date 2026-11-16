import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { ManagedMachineReadV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { MachinePageStateContext, type MachinePageState } from '../page/machinePageContext';
import { useManagedEnrolledMachine } from '@/components/settings/machines/managed/ManagedMachineSections';
import { t } from '@/text';
import { MachineSandboxesTab } from './MachineSandboxesTab';

installApprovalCommonModuleMocks();
const { router } = await import('expo-router');

let homes: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
afterEach(async () => { await standardCleanup(); await homes?.dispose(); homes = undefined; });

it('keeps an unopened preset sandbox visible and openable beside a named sandbox', async () => {
    const homeId = 'srv_host_sandboxes';
    const controller = { machineId: 'controller', installationId: 'installation' };
    const structural = { homeId, custodianAccountId: 'owner', controller, acquisitionMode: 'resource-bound',
        allocation: 'may-exist', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
    const opaque = ManagedMachineReadV1Schema.parse({
        machine: { ...structural, id: 'sealed', preset: { id: 'preset', revision: 1, contentEncryptionMode: 'plain' } },
        presetContent: { content: { t: 'plain', v: { v: 1, name: 'Unopened preset' } }, recipientEnvelope: null },
    });
    const named = ManagedMachineReadV1Schema.parse({ ...structural, id: 'named', launch: {
        provider: { pluginId: 'fixture.compute', localId: 'native' }, schemaVersion: 1, name: 'Build guest', choices: {},
    } });
    homes = await serveAccountHomes({ homes: [{ key: 'home', serverUrl: 'https://host-sandboxes.test',
        serverIdentityId: homeId, accountId: 'owner' }], route: request => request.path === '/v1/machines/managed/actions/list'
            ? Response.json({ machines: [opaque, named] }) : undefined });
    const serverId = homes.homes.home!.id;
    const machine = createMachineFixture({ id: controller.machineId, installationId: controller.installationId });
    function Route() {
        const managedEnrolled = useManagedEnrolledMachine({ serverId, enrolledMachineId: undefined });
        const state = { target: { machineId: machine.id, requestedServerId: serverId, serverId, activeServerId: serverId,
            machine, machineName: 'Host', machineSentenceName: 'Host', isServerSwitching: false,
            isHydratingMachine: false, switchReady: true }, managedEnrolled, refreshKey: 0,
            reload: async () => {} } satisfies MachinePageState;
        return <MachinePageStateContext.Provider value={state}>
            <MachineSandboxesTab serverId={serverId} machineId={machine.id} machineName="Host" online
                params={{ id: 'sandboxes' }} setParams={() => {}} />
        </MachinePageStateContext.Provider>;
    }
    const screen = await renderScreen(<Route />);
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('Build guest'));
    expect(screen.getTextContent()).toContain(t('common.machine'));
    expect(screen.findByTestId('machine-sandbox-row-sealed')).not.toBeNull();
    vi.mocked(router.push).mockClear();
    await screen.pressByTestIdAsync('machine-sandbox-row-sealed');
    expect(router.push).toHaveBeenCalledWith(`/settings/machines/managed/sealed?serverId=${encodeURIComponent(serverId)}`);
});
