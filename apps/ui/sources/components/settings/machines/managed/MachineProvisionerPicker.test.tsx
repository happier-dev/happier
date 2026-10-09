import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';

installApprovalCommonModuleMocks({ text: async () => vi.importActual<typeof import('@/text')>('@/text') });
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { resetScopedHomeActionExecutorsForTests } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
beforeEach(async () => { await harness.reset(); resetScopedHomeActionExecutorsForTests(); });
afterEach(() => standardCleanup());

describe('provisioner picker demand', () => {
    it('returns the explicitly chosen provisioner and controller to composer configuration without acquiring', async () => {
        const serverId = await harness.addHome({ name: 'Build', serverUrl: 'https://build.example', serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: 'controller', installationId: 'installation' })] } });
        const contribution = { pluginId: 'custom.compute', localId: 'native' };
        const provisioner = { contribution, occurrenceId: 'occurrence', descriptor: {
            id: 'native', title: 'Custom compute', icon: 'server', resourceKind: 'VM', schemaVersion: 1,
            launchSchema: { type: 'object', properties: {}, additionalProperties: false },
            resourceSchema: { type: 'object', properties: {}, additionalProperties: false }, platforms: ['linux'], prerequisites: [],
            billing: { location: 'cloud', stoppedBilling: 'billed' }, retention: { supportedIntents: ['delete'] },
            actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', destroy: 'destroy' },
        } };
        const { MachineProvisionersListResultV1Schema } = await import('@happier-dev/protocol/plugins/contributions/machineProvisioners');
        MachineProvisionersListResultV1Schema.parse({ provisioners: [provisioner] });
        for (const [actionId, result] of [['machines.provisioners.list', { provisioners: [provisioner] }],
            ['machines.provisioners.check', { available: true }]] as const) {
            harness.answer(serverId, `/v1/actions/${actionId}`, { select: value => {
                const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
                return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result } } };
            } });
        }
        const onSelectProvisioner = vi.fn();
        const { MachineProvisionerPicker } = await import('./MachineProvisionerPicker');
        const { buildQualifiedPluginContributionKey } = await import('@happier-dev/protocol/plugins/contribution-identity');
        const screen = await renderScreen(<MachineProvisionerPicker serverId={serverId} onSelectProvisioner={onSelectProvisioner} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-picker.controller:controller')).not.toBeNull());
        await act(async () => screen.pressByTestId('managed-picker.controller:controller'));
        const row = `managed-picker.provisioners.cloud.${buildQualifiedPluginContributionKey(contribution)}`;
        await waitForHomeGovernance(() => expect(screen.findByTestId(`${row}.action`) ?? screen.findByTestId(row)
            ?? screen.findByTestId('managed-picker.unavailable')).not.toBeNull());
        expect(screen.findByTestId('managed-picker.unavailable')?.props.diagnosticCode).toBeUndefined();
        await act(async () => screen.pressByTestId(screen.findByTestId(`${row}.action`) ? `${row}.action` : row));
        expect(onSelectProvisioner).toHaveBeenCalledWith({ serverId, provisioner: buildQualifiedPluginContributionKey(contribution),
            controller: { machineId: 'controller', installationId: 'installation' } });
        expect(harness.requests.some(request => request.path.includes('machines.managed.acquire'))).toBe(false);
        await screen.unmount();
    });
    it('asks for an explicit Home and controller before reading that controller catalog without allocation', async () => {
        const first = await harness.addHome({ name: 'Build', serverUrl: 'https://build.example', serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true });
        await harness.addHome({ name: 'Other', serverUrl: 'https://other.example', serverIdentityId: 'srv_other', accountId: 'other' });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ machineListByServerId: { [first]: [createMachineFixture({ id: 'build-controller', installationId: 'build-installation' })] } });
        harness.answer(first, '/v1/actions/machines.provisioners.list', { select: value => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            return { body: { v: 1, actionId: 'machines.provisioners.list', requestId: request.requestId, execution: { ok: true, result: { provisioners: [] } } } };
        } });
        const { MachineProvisionerPicker } = await import('./MachineProvisionerPicker');
        const screen = await renderScreen(<MachineProvisionerPicker serverId="" presetOnly />);
        expect(harness.requestsFor('/v1/actions/machines.provisioners.list')).toHaveLength(0);
        await act(async () => screen.pressByTestId(`managed-picker.home:${first}`));
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-picker.controller:build-controller')
            || screen.findByTestId('managed-picker.unavailable')).not.toBeNull());
        expect(screen.findByTestId('managed-picker.controller:build-controller')).not.toBeNull();
        expect(harness.requestsFor('/v1/actions/machines.provisioners.list')).toHaveLength(0);
        await act(async () => screen.pressByTestId('managed-picker.controller:build-controller'));
        await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/actions/machines.provisioners.list').length > 0
            || screen.tree.findAll(node => node.props.testID === 'managed-picker.unavailable').length > 0).toBe(true));
        expect(harness.requestsFor('/v1/actions/machines.provisioners.list')).toHaveLength(1);
        expect(harness.requestsFor('/v1/actions/machines.provisioners.list')[0]).toMatchObject({ serverId: first, input: {
            target: { kind: 'machine', machineId: 'build-controller' }, input: { homeId: 'srv_build', controller: { machineId: 'build-controller', installationId: 'build-installation' } },
        } });
        expect(harness.requests.some(request => request.path.endsWith('/acquire'))).toBe(false);
        await screen.unmount();
    });
    it('settles a signed-out Home without an endless provisioning spinner or reading a different Home', async () => {
        const signedOut = await harness.addHome({ name: 'Signed out', serverUrl: 'https://signed-out.example', serverIdentityId: 'srv_signed_out', accountId: null });
        await harness.addHome({ name: 'Other', serverUrl: 'https://other.example', serverIdentityId: 'srv_other', accountId: 'other' });
        const { MachineProvisionerPicker } = await import('./MachineProvisionerPicker');
        const screen = await renderScreen(<MachineProvisionerPicker serverId={signedOut} />);
        await waitForHomeGovernance(() => expect(screen.tree.findAll(node => node.props.testID === 'managed-picker.unavailable').length).toBeGreaterThan(0));
        expect(harness.requestsFor('/v1/machines/managed/actions/machines.provisioners.list')).toHaveLength(0);
        await screen.unmount();
    });
});
