import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { MachineProvisionersListResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { ManagedMachineActionInputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { PluginApi, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import { CUA_PLUGIN } from '../../../../../../../packages/plugins/machine-cua/src/manifest';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createManagedControllerMachineFixture } from '@/dev/testkit/fixtures/machineProvisionerFixtures';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { installBundledPluginUiDeclarationsForTests } from '@/dev/testkit/mocks/bundledPluginUiAssets';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { clearPluginAccountAvailabilityProjection, replacePluginAccountAvailabilityProjection } from '@/sync/domains/plugins/availability/projection';

installApprovalCommonModuleMocks({ text: async () => vi.importActual<typeof import('@/text')>('@/text') });
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { resetScopedHomeActionExecutorsForTests } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
beforeEach(async () => { await harness.reset(); resetScopedHomeActionExecutorsForTests(); });
afterEach(async () => { standardCleanup(); await harness.reset(); });

it('keeps sandbox kinds in their native setup groups when a later catalog read cannot admit a choice', async () => {
    onTestFinished(installBundledPluginUiDeclarationsForTests([]));
    onTestFinished(clearPluginAccountAvailabilityProjection);
    const serverId = await harness.addHome({ name: 'Build', serverUrl: 'https://sandbox-groups.example.test',
        serverIdentityId: 'srv_sandbox_groups', accountId: 'owner', currentAccount: true });
    replacePluginAccountAvailabilityProjection({ scope: { serverId: resolveServerProfileScopeIdForIdentifier(serverId) || serverId, accountId: 'owner' },
        snapshot: { availabilityCursor: 1, inventoryComplete: true, materializations: [], snapshots: [], intentReads: [] } });
    const controller = { machineId: 'devbox', installationId: 'installation' };
    const machine = createManagedControllerMachineFixture({ id: controller.machineId, installationId: controller.installationId, activeAt: Date.now(), kind: 'persistent' });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [
        { ...machine, metadata: { ...machine.metadata!, platform: 'linux' } },
    ]);
    const cuaActions = new Map<string, ActionHandler>();
    // Plugin registration and the host dependency service are system boundaries; the real Cua check supplies its repair.
    await CUA_PLUGIN.activate({ actions: { register(id: string, handler: ActionHandler) { cuaActions.set(id, handler); return { dispose() {} }; } },
        connectedAccounts: { register() { return { dispose() {} }; } } } as unknown as PluginApi);
    const cuaCheck = await cuaActions.get('sandbox-check')!({}, { signal: new AbortController().signal, services: {
        managedServices: { dependencies: { status: async () => ({ state: 'missing', id: 'cua-cli', supported: true }) } },
    } } as unknown as PluginInvocationContext);
    const cuaDescriptor = CUA_PLUGIN.manifest.contributes.machineProvisioners!.find(entry => entry.id === 'local-sandbox')!;
    const descriptor = { id: 'ready', title: 'Dev container', icon: 'server', resourceKind: 'Container', schemaVersion: 1,
        launchSchema: { type: 'object', properties: {}, additionalProperties: false },
        resourceSchema: { type: 'object', properties: {}, additionalProperties: false }, platforms: ['linux'], prerequisites: [],
        billing: { location: 'local', stoppedBilling: 'not-billed' }, retention: { supportedIntents: ['start', 'stop', 'delete'] },
        sessionPlacement: { kind: 'controller-local' },
        actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' } };
    const list = MachineProvisionersListResultV1Schema.parse({ controller, provisioners: [...['ready', 'installable', 'unsupported'].map(id => ({
        contribution: { pluginId: 'sandbox.kinds', localId: id }, occurrenceId: `occurrence-${id}`, credentialPurposes: [], acquireExecutionTarget: 'daemon',
        descriptor: { ...descriptor, id, title: id },
    })), { contribution: { pluginId: CUA_PLUGIN.manifest.id, localId: 'local-sandbox' }, occurrenceId: 'occurrence-cua',
        credentialPurposes: [], acquireExecutionTarget: 'daemon', descriptor: cuaDescriptor }] });
    let catalogFailed = false;
    await answerExternalActionAccountForHome(harness, serverId, { ...controller, actionId: 'machines.provisioners.list', tokenEpoch: 0,
        requesterInvocation: 'optional', execute: async () => catalogFailed ? { ok: false, errorCode: 'unavailable', error: 'unavailable' } : list,
        failure: execution => {
            const parsed = ExternalActionResponseEnvelopeV1Schema.safeParse({ v: 1, actionId: 'machines.provisioners.list', execution });
            return parsed.success && !parsed.data.execution.ok ? parsed.data.execution : null;
        } });
    await answerExternalActionAccountForHome(harness, serverId, { ...controller, actionId: 'machines.provisioners.check', tokenEpoch: 0,
        requesterInvocation: 'optional', execute: async input => {
            const { contribution } = ManagedMachineActionInputSchemasV1['machines.provisioners.check'].parse(input);
            if (contribution.pluginId === CUA_PLUGIN.manifest.id) return cuaCheck;
            const id = contribution.localId;
            return id === 'ready' ? { available: true } : { available: false, prerequisites: [{ requirement: { kind: 'systemTool', id }, status: 'unavailable',
                ...(id === 'installable' ? { repairAction: { action: { pluginId: 'sandbox.kinds', localId: 'install' }, input: {} } } : {}) }] };
        } });
    const { MachineIsolationAddSandboxModal } = await import('./MachineIsolationAddSandboxModal');
    const setChrome = vi.fn();
    const screen = await renderScreen(<ListPresentationProvider value="page">
        <MachineIsolationAddSandboxModal onClose={() => {}} setChrome={setChrome} serverId={serverId} controller={controller} machineName="devbox" onAdded={() => {}} />
    </ListPresentationProvider>);
    const inGroup = (groupId: string, id: string) => screen.tree.findAll(node => node.props.testID === groupId)
        .some(group => group.findAll(node => node.props.testID === `machine-isolation-add.kind:sandbox.kinds/${id}`).length > 0);
    try {
        await waitForHomeGovernance(() => {
            expect(inGroup('machine-isolation-add.kinds', 'ready')).toBe(true);
            expect(inGroup('machine-isolation-add.kinds', 'installable')).toBe(true);
            expect(inGroup('machine-isolation-add.elsewhere', 'unsupported')).toBe(true);
            expect(screen.tree.findAll(node => node.props.testID === 'machine-isolation-add.kinds')
                .some(group => group.findAll(node => node.props.testID === `machine-isolation-add.kind:${CUA_PLUGIN.manifest.id}/local-sandbox`).length > 0)).toBe(true);
        });
        await screen.pressByTestIdAsync(`machine-isolation-add.kind:${CUA_PLUGIN.manifest.id}/local-sandbox`);
        const footer = await renderScreen(setChrome.mock.calls.at(-1)![0].footer);
        try {
            await footer.pressByTestIdAsync('machine-isolation-add.continue');
            await footer.update(setChrome.mock.calls.at(-1)![0].footer);
            const install = footer.findByTestId('machine-isolation-add.setup-action');
            const { t } = await import('@/text');
            expect(install).not.toBeNull();
            expect(install!.findAll(node => node.props.children === t('managedMachines.add.action.getApp')).length).toBeGreaterThan(0);
            expect(install?.props.disabled).not.toBe(true);
            await footer.pressByTestIdAsync('machine-isolation-add.back');
        } finally { await footer.unmount(); }
        catalogFailed = true;
        await act(async () => { await harness.switchAccount(serverId, 'owner', { currentAccount: true }); });
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-picker.unavailable')).not.toBeNull());
        expect(inGroup('machine-isolation-add.kinds', 'ready')).toBe(true);
        expect(inGroup('machine-isolation-add.kinds', 'installable')).toBe(true);
        expect(inGroup('machine-isolation-add.elsewhere', 'unsupported')).toBe(true);
        expect(screen.tree.findAll(node => node.props.testID === 'machine-isolation-add.kind:sandbox.kinds/ready' && node.props.disabled === true).length).toBeGreaterThan(0);
        expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toHaveLength(0);
    } finally { await screen.unmount(); }
});
