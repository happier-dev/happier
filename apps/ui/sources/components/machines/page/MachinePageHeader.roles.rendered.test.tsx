import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { router } from 'expo-router';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol/v1';

import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import { t } from '@/text';

// Only Home HTTP and Machine RPC are substituted; the header, the role census hook and the Environment headers stay real.
const machineTransport = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(machineTransport.rpc);
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { MachinePageHeader } = await import('./MachinePageHeader');
const { MachineServicesTab } = await import('@/components/machines/services/MachineServicesTab');

let serverId: string;
const accountId = 'account';
const machineId = 'machine';
const serverIdentityId = 'srv_header_roles';

beforeEach(async () => {
    await homes.reset();
    machineTransport.rpc.mockReset();
    machineTransport.rpc.mockImplementation(() => new Promise(() => {}));
    await initializeRealAppRuntimeForTests();
    installHomeGovernanceBoundaries(homes);
    serverId = await homes.addHome({ name: 'Header roles', serverUrl: 'https://header-roles.test',
        serverIdentityId, accountId, currentAccount: true, active: true });
    const row = { ...createPlainMachineRowFixture({ id: machineId, accountId }), installationId: 'installation' };
    homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async input => ({ body:
        await createMachineReadBatchResponseFixture(input, () => row).json() }) });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    const credentials = await TokenStorage.getCredentialsForServerUrl('https://header-roles.test', { serverId });
    if (!credentials) throw new Error('Header roles Home credentials unavailable');
    await restoreConnectionToActiveServer(credentials);
    vi.mocked(router.push).mockClear();
});
afterEach(async () => { standardCleanup(); await homes.reset(); });

async function seedRoleEnvironment() {
    const environment = createDeploymentEnvironmentHeaderV1({ serverId: serverIdentityId, id: 'controller-environment', projectSourceId: 'shop-source' });
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const writer = await captureLazyActionAccountContext(serverId);
    try {
        await writer.createArtifactDocument({ artifactId: environment.contentArtifactId,
            header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Production' }, body: '{}' });
    } finally { writer.dispose(); }
    homes.answer(serverId, '/v1/deployments/machine-references', { body: { homeId: serverIdentityId, machineId,
        coverage: 'complete', nextCursor: null,
        references: [{ kind: 'deployment_environment', id: environment.id, name: '', deploymentRoles: ['controller', 'runtime'] }] } });
    homes.answer(serverId, '/v1/deployments/environments', { body: { ok: true, items: [environment], nextCursor: null } });
    return environment;
}

const headerTarget = () => ({ machineId, requestedServerId: serverId, serverId, activeServerId: serverId,
    machine: createMachineFixture({ id: machineId, active: true, isShared: false }),
    machineName: 'nl3', machineSentenceName: 'nl3', online: true, isServerSwitching: false,
    isHydratingMachine: false, switchReady: true } as const);

it('reads the role census once per Machine page open while the header and the Services roles section are both mounted', async () => {
    await seedRoleEnvironment();
    const censusReads = () => homes.requests.filter(request => request.path.startsWith('/v1/deployments/machine-references')).length;
    const screen = await renderScreen(<>
        <MachinePageHeader target={headerTarget()} managedIdentity={null} renaming={false} onRename={() => {}} />
        <MachineServicesTab serverId={serverId} machineId={machineId} machineName="nl3" online={true}
            params={{ id: 'services' }} setParams={() => {}} />
    </>);
    try {
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-detail-role-controller')).not.toBeNull());
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-services-role:controller-environment')).not.toBeNull());
        expect(censusReads(), 'one census read serves both consumers').toBe(1);
    } finally { await screen.unmount(); }
});

it('renders the Machine page header with its exact deployment roles as translated facts, the single one linking to its Environment', async () => {
    const environment = createDeploymentEnvironmentHeaderV1({ serverId: serverIdentityId, id: 'controller-environment', projectSourceId: 'shop-source' });
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const writer = await captureLazyActionAccountContext(serverId);
    try {
        await writer.createArtifactDocument({ artifactId: environment.contentArtifactId,
            header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Production' }, body: '{}' });
    } finally { writer.dispose(); }
    homes.answer(serverId, '/v1/deployments/machine-references', { body: { homeId: serverIdentityId, machineId,
        coverage: 'complete', nextCursor: null,
        references: [{ kind: 'deployment_environment', id: environment.id, name: '', deploymentRoles: ['controller', 'runtime'] }] } });
    homes.answer(serverId, '/v1/deployments/environments', { body: { ok: true, items: [environment], nextCursor: null } });
    const machine = createMachineFixture({ id: machineId, active: true, isShared: false });
    const target = { machineId, requestedServerId: serverId, serverId, activeServerId: serverId, machine,
        machineName: 'nl3', machineSentenceName: 'nl3', online: true, isServerSwitching: false,
        isHydratingMachine: false, switchReady: true } as const;
    const screen = await renderScreen(<MachinePageHeader target={target} managedIdentity={null} renaming={false} onRename={() => {}} />);
    try {
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-detail-role-controller')).not.toBeNull());
        const text = screen.getTextContent();
        expect(text).toContain(t('machineServices.roles.role.controller'));
        // Runtime is the Services tab's group, not a header role.
        expect(screen.findHostByTestId('machine-detail-role-runtime')).toBeNull();
        expect(screen.findHostByTestId('machine-detail-role-build')).toBeNull();
        // The fact's link (the plugin-ui header wraps the fact text in its own pressable).
        const link = screen.findHostByTestId('machine-detail-role-controller')!
            .findAll(node => node.props.accessibilityRole === 'link' && typeof node.props.onPress === 'function')[0]!;
        expect(link.props.accessibilityLabel).toContain('Production');
        await act(async () => { link.props.onPress(); });
        expect(router.push).toHaveBeenCalledWith({ pathname: '/deployments/[projectSourceId]', params: {
            serverId, projectSourceId: 'shop-source', deploymentEnvironment: environment.id } });
    } finally { await screen.unmount(); }
});
