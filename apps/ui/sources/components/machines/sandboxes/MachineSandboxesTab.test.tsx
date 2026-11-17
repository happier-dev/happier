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

it('takes the Isolation door’s one availability decision: offline it says so once and the invite waits; a non-manager reads why', async () => {
    const setParams = vi.fn();
    function Route(props: Readonly<{ machine: ReturnType<typeof createMachineFixture>; online: boolean }>) {
        const state = { target: { machineId: props.machine.id, requestedServerId: 'server-a', serverId: 'server-a', activeServerId: 'server-a',
            machine: props.machine, machineName: 'Host', machineSentenceName: 'Host', isServerSwitching: false,
            isHydratingMachine: false, switchReady: true }, managedEnrolled: null, refreshKey: 0,
            reload: async () => {} } as unknown as MachinePageState;
        return <MachinePageStateContext.Provider value={state}>
            <MachineSandboxesTab serverId="server-a" machineId={props.machine.id} machineName="Host" online={props.online}
                params={{ id: 'sandboxes' }} setParams={setParams} />
        </MachinePageStateContext.Provider>;
    }
    const managed = createMachineFixture({ id: 'host', isShared: false });
    const offline = await renderScreen(<Route machine={managed} online={false} />);
    expect(offline.findByTestId('machine-sandboxes-offline')).not.toBeNull();
    await offline.pressByTestIdAsync('machine-sandboxes-empty-add');
    expect(setParams).not.toHaveBeenCalled();
    await standardCleanup();

    const online = await renderScreen(<Route machine={managed} online />);
    expect(online.findByTestId('machine-sandboxes-offline')).toBeNull();
    await online.pressByTestIdAsync('machine-sandboxes-empty-add');
    expect(setParams).toHaveBeenCalledWith({ id: 'security', page: 'isolation', add: 'sessions' });
    await standardCleanup();

    setParams.mockClear();
    const shared = await renderScreen(<Route machine={createMachineFixture({ id: 'host', isShared: true })} online />);
    expect(shared.findByTestId('machine-sandboxes-empty-add')).toBeNull();
    expect(shared.getTextContent()).toContain(t('machineDetailPage.isolation.notManager'));
});

it.each(['portable', 'profile'] as const)('settles a refused host inventory visibly through a %s Home and retries through the inventory owner', async identifier => {
    const homeId = 'srv_host_sandboxes_refused';
    let refused = true;
    homes = await serveAccountHomes({ homes: [{ key: 'home', serverUrl: 'https://host-sandboxes-refused.test',
        serverIdentityId: homeId, accountId: 'owner' }], route: request => request.path === '/v1/machines/managed/actions/list'
            ? refused ? Response.json({ code: 'permission_denied' }, { status: 403 }) : Response.json({ machines: [] }) : undefined });
    const serverId = identifier === 'profile' ? homes.homes.home!.profileId : homes.homes.home!.id;
    const machine = createMachineFixture({ id: 'controller', installationId: 'installation' });
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
    await vi.waitFor(() => expect(screen.findByTestId('machine-sandboxes-read-state')).not.toBeNull());
    expect(screen.findByTestId('machine-sandboxes-loading')).toBeNull();
    expect(screen.findByTestId('machine-sandboxes-empty')).toBeNull();
    expect(screen.getTextContent()).toContain(t('managedMachines.detail.readRefused'));
    refused = false;
    await screen.pressByTestIdAsync('machine-sandboxes-read-retry');
    await vi.waitFor(() => expect(screen.findByTestId('machine-sandboxes-empty')).not.toBeNull());
    expect(screen.findByTestId('machine-sandboxes-read-state')).toBeNull();
});
