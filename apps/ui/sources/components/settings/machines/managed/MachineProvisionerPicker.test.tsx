import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';

installApprovalCommonModuleMocks({ text: async () => vi.importActual<typeof import('@/text')>('@/text') });
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { resetScopedHomeActionExecutorsForTests } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
beforeEach(async () => { await harness.reset(); resetScopedHomeActionExecutorsForTests(); });
afterEach(() => standardCleanup());

// The Add route owns page presentation; without it the grouped-menu header intentionally omits page actions.
function renderPicker(element: React.ReactElement) {
    return renderScreen(<ListPresentationProvider value="page">{element}</ListPresentationProvider>);
}

describe('provisioner picker demand', () => {
    it.each(['cloud', 'unknown'] as const)('retains native presentation and check vocabulary without acquiring (%s billing)', async location => {
        const serverId = await harness.addHome({ name: 'Build', serverUrl: 'https://build.example', serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: 'controller', installationId: 'installation', activeAt: Date.now(), kind: 'persistent' })] },
            machineListStatusByServerId: { [serverId]: 'idle' } });
        const contribution = { pluginId: 'custom.compute', localId: 'native' };
        const provisioner = { contribution, occurrenceId: 'occurrence', descriptor: {
            id: 'native', title: 'Custom compute', icon: 'server', resourceKind: 'native-compute-vm', schemaVersion: 1,
            kindTitle: { key: 'native.kind', fallback: 'VM' }, description: { key: 'native.description', fallback: 'A custom native guest.' },
            launchSchema: { type: 'object', properties: {}, additionalProperties: false },
            resourceSchema: { type: 'object', properties: {}, additionalProperties: false }, platforms: ['linux'], prerequisites: [],
            billing: { location, stoppedBilling: 'billed' }, retention: { supportedIntents: ['delete'] },
            actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', destroy: 'destroy' },
        } };
        const { MachineProvisionersListResultV1Schema } = await import('@happier-dev/protocol/plugins/contributions/machineProvisioners');
        MachineProvisionersListResultV1Schema.parse({ provisioners: [provisioner] });
        for (const [actionId, result] of [['machines.provisioners.list', { provisioners: [provisioner] }],
            ['machines.provisioners.check', { available: false, code: 'license_required', status: { key: 'native.license', fallback: 'License required' } }]] as const) {
            harness.answer(serverId, `/v1/actions/${actionId}`, { select: value => {
                const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
                return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result } } };
            } });
        }
        const onSelectProvisioner = vi.fn();
        const { MachineProvisionerPicker } = await import('./MachineProvisionerPicker');
        const { buildQualifiedPluginContributionKey } = await import('@happier-dev/protocol/plugins/contribution-identity');
        const screen = await renderPicker(<MachineProvisionerPicker serverId={serverId} onSelectProvisioner={onSelectProvisioner} />);
        const row = `managed-picker.provisioners.cloud.${buildQualifiedPluginContributionKey(contribution)}`;
        await waitForHomeGovernance(() => expect(screen.findByTestId(`${row}.action`) ?? screen.findByTestId(row)
            ?? screen.findByTestId('managed-picker.unavailable')).not.toBeNull());
        expect(screen.findByTestId('managed-picker.unavailable')?.props.diagnosticCode).toBeUndefined();
        await waitForHomeGovernance(() => {
            const cards = screen.tree.findAll(node => Array.isArray(node.props.cards)).flatMap(node => node.props.cards);
            expect(cards).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'VM', description: 'A custom native guest.',
                status: expect.objectContaining({ label: location === 'unknown' ? 'License required · Billing unknown' : 'License required' }) })]));
        });
        await act(async () => screen.pressByTestId(screen.findByTestId(`${row}.action`) ? `${row}.action` : row));
        expect(onSelectProvisioner).toHaveBeenCalledWith({ serverId, provisioner: buildQualifiedPluginContributionKey(contribution),
            controller: { machineId: 'controller', installationId: 'installation' } });
        expect(harness.requests.some(request => request.path.includes('machines.managed.acquire'))).toBe(false);
        await screen.unmount();
    });
    it('asks for an explicit Home, then reads the preselected controller catalog without allocation', async () => {
        const first = await harness.addHome({ name: 'Build', serverUrl: 'https://build.example', serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true });
        await harness.addHome({ name: 'Other', serverUrl: 'https://other.example', serverIdentityId: 'srv_other', accountId: 'other' });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ machineListByServerId: { [first]: [createMachineFixture({ id: 'build-controller', installationId: 'build-installation', activeAt: Date.now(), kind: 'persistent' })] },
            machineListStatusByServerId: { [first]: 'idle' } });
        harness.answer(first, '/v1/actions/machines.provisioners.list', { select: value => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            return { body: { v: 1, actionId: 'machines.provisioners.list', requestId: request.requestId, execution: { ok: true, result: { provisioners: [] } } } };
        } });
        const { MachineProvisionerPicker } = await import('./MachineProvisionerPicker');
        const screen = await renderPicker(<MachineProvisionerPicker serverId="" presetOnly />);
        expect(harness.requestsFor('/v1/actions/machines.provisioners.list')).toHaveLength(0);
        expect(screen.findByTestId('managed-picker.controller.chip')).toBeNull();
        await act(async () => screen.pressByTestId(`managed-picker.home:${first}`));
        // The Home's only machine that can manage is preselected in the scope chip, so its catalog is the first frame.
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-picker.controller.chip')).not.toBeNull());
        await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/actions/machines.provisioners.list').length > 0
            || screen.tree.findAll(node => node.props.testID === 'managed-picker.unavailable').length > 0).toBe(true));
        expect(harness.requestsFor('/v1/actions/machines.provisioners.list')).toHaveLength(1);
        expect(harness.requestsFor('/v1/actions/machines.provisioners.list')[0]).toMatchObject({ serverId: first, input: {
            target: { kind: 'machine', machineId: 'build-controller' }, input: { homeId: 'srv_build', controller: { machineId: 'build-controller', installationId: 'build-installation' } },
        } });
        expect(harness.requests.some(request => request.path.endsWith('/acquire'))).toBe(false);
        await screen.unmount();
    });
    it('names an offline controller under its chip instead of blaming the provisioner, and offers setup when nothing can manage', async () => {
        const serverId = await harness.addHome({ name: 'Build', serverUrl: 'https://build.example', serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: 'asleep', installationId: 'installation', active: false, activeAt: 0, kind: 'persistent' })] },
            machineListStatusByServerId: { [serverId]: 'idle' } });
        const { MachineProvisionerPicker } = await import('./MachineProvisionerPicker');
        const screen = await renderPicker(<MachineProvisionerPicker serverId={serverId} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-picker.offline')).not.toBeNull());
        expect(screen.findByTestId('managed-picker.controller.chip')).not.toBeNull();
        expect(screen.findByTestId('managed-picker.unavailable')).toBeNull();
        await screen.unmount();

        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: 'plain', installationId: null })] } });
        const onSetUpThisComputer = vi.fn();
        const empty = await renderPicker(<MachineProvisionerPicker serverId={serverId} onSetUpThisComputer={onSetUpThisComputer} />);
        await waitForHomeGovernance(() => expect(empty.findByTestId('managed-picker.no-controller')).not.toBeNull());
        await act(async () => empty.pressByTestId('managed-picker.no-controller-action'));
        expect(onSetUpThisComputer).toHaveBeenCalledTimes(1);
        await empty.unmount();
    });
    it('settles a signed-out Home without an endless provisioning spinner or reading a different Home', async () => {
        const signedOut = await harness.addHome({ name: 'Signed out', serverUrl: 'https://signed-out.example', serverIdentityId: 'srv_signed_out', accountId: null });
        await harness.addHome({ name: 'Other', serverUrl: 'https://other.example', serverIdentityId: 'srv_other', accountId: 'other' });
        const { MachineProvisionerPicker } = await import('./MachineProvisionerPicker');
        const screen = await renderPicker(<MachineProvisionerPicker serverId={signedOut} />);
        await waitForHomeGovernance(() => expect(screen.tree.findAll(node => node.props.testID === 'managed-picker.unavailable').length).toBeGreaterThan(0));
        expect(harness.requestsFor('/v1/machines/managed/actions/machines.provisioners.list')).toHaveLength(0);
        await screen.unmount();
    });
});
