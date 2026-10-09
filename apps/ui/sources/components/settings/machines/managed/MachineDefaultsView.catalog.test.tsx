import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import type { MachineProvisionersListResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import type { ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

installApprovalCommonModuleMocks({ text: async () => vi.importActual<typeof import('@/text')>('@/text') });
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { resetScopedHomeActionExecutorsForTests } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
beforeEach(async () => { await harness.reset(); resetScopedHomeActionExecutorsForTests(); });
afterEach(() => standardCleanup());

function provisioner(title: string, location: 'local' | 'cloud'): MachineProvisionersListResultV1['provisioners'][number] {
    return { contribution: { pluginId: 'custom.compute', localId: location }, occurrenceId: `${location}-occurrence`, descriptor: {
        id: location, title, icon: 'server', resourceKind: 'VM', schemaVersion: 1,
        launchSchema: { type: 'object', properties: {}, additionalProperties: false }, resourceSchema: { type: 'object', properties: {}, additionalProperties: false },
        platforms: ['linux'], prerequisites: [], billing: { location, stoppedBilling: location === 'local' ? 'not-billed' : 'billed' }, retention: { supportedIntents: ['start', 'stop', 'delete'] },
        actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
    } };
}

describe('Machine Defaults installed provisioner names', () => {
    it('aggregates actual installed controllers of only the focused Home without pretending a Home-global catalog', async () => {
        const home = await harness.addHome({ name: 'Build', serverUrl: 'https://build.example', serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true });
        const other = await harness.addHome({ name: 'Other', serverUrl: 'https://other.example', serverIdentityId: 'srv_other', accountId: 'other', currentAccount: true, active: false });
        const focusedHome = resolveServerProfileScopeIdForIdentifier(home);
        const otherHome = resolveServerProfileScopeIdForIdentifier(other);
        expect(getActiveServerSnapshot().serverId).toBe(focusedHome);
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ machineListByServerId: {
            [focusedHome]: [createMachineFixture({ id: 'local-controller', installationId: 'local-installation' }), createMachineFixture({ id: 'cloud-controller', installationId: 'cloud-installation' }), createMachineFixture({ id: 'guest-without-installation' })],
            [otherHome]: [createMachineFixture({ id: 'other-controller', installationId: 'other-installation' })],
        } });
        harness.answer(home, '/v1/actions/machines.provisioners.list', { select: value => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            const rows = request.target.kind === 'machine' && request.target.machineId === 'local-controller'
                ? [provisioner('Local guest', 'local')] : [provisioner('Cloud service', 'cloud')];
            return { body: { v: 1, actionId: 'machines.provisioners.list', requestId: request.requestId, execution: { ok: true, result: { provisioners: rows } } } };
        } });
        const controllers: readonly ManagedControllerV1[] = [
            { machineId: 'local-controller', installationId: 'local-installation' },
            { machineId: 'cloud-controller', installationId: 'cloud-installation' },
        ];
        const { useManagedProvisioners } = await import('./useManagedProvisioners');
        const catalog = await renderHook(() => useManagedProvisioners(focusedHome, undefined, controllers));
        await waitForHomeGovernance(() => expect(catalog.getCurrent().loading).toBe(false));
        expect(catalog.getCurrent().provisioners.map(row => row.descriptor.title)).toEqual(['Local guest', 'Cloud service']);
        await catalog.unmount();
        const { MachineDefaultsView } = await import('./MachineDefaultsView');
        const screen = await renderScreen(<MachineDefaultsView />);
        await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/actions/machines.provisioners.list').length > 0
            || screen.getTextContent().includes('Until I delete it')).toBe(true));
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Local guest'));
        expect(screen.getTextContent()).toContain('Cloud service');
        expect(harness.requestsFor('/v1/actions/machines.provisioners.list').map(request => request.input)).toEqual(expect.arrayContaining([
            expect.objectContaining({ target: { kind: 'machine', machineId: 'local-controller' }, input: { homeId: 'srv_build', controller: { machineId: 'local-controller', installationId: 'local-installation' } } }),
            expect.objectContaining({ target: { kind: 'machine', machineId: 'cloud-controller' }, input: { homeId: 'srv_build', controller: { machineId: 'cloud-controller', installationId: 'cloud-installation' } } }),
        ]));
        expect(harness.requestsFor('/v1/actions/machines.provisioners.list').every(request => request.serverId === home)).toBe(true);
        expect(harness.requests.some(request => request.path.endsWith('/acquire'))).toBe(false);
        await screen.unmount();
    });
});
