import * as React from 'react';
import { ProjectSourceV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { afterEach, expect, it, vi } from 'vitest';
import { act, createMachineFixture, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createDeploymentEnvironmentHeaderV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness,
    installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import type { ManagedInventorySectionsState } from './ManagedInventorySections';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { buildDeploymentEnvironmentHref } from '@/components/projects/deployments/deploymentNavigation';

const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
const { storage } = await import('@/sync/domains/state/storage');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { ManagedInventoryDirectory } = await import('./ManagedInventoryDirectory');
const { ItemList } = await import('@/components/ui/lists/ItemList');
const { InstalledScreen } = await import('./InstalledScreen');
const { MachineManagedInventorySection } = await import('@/components/machines/page/MachineManagedInventorySection');
const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
const { inventoryMachineKey } = await import('./inventoryRows');
const { inventoryFamilyDiagnosticCode } = await import('./inventoryCoverage');
const { serverAccountScopedResourceKey } = await import('@/sync/domains/scope/serverAccountScope');
const fields = {
    kind: { label: 'Kind', valueLabel: (value: string) => value },
    status: { label: 'Status', valueLabel: (value: string) => value },
    machine: { label: 'Machine', valueLabel: (value: string) => value },
    project: { label: 'Project', valueLabel: (value: string) => value },
};
const NO_OPEN = () => {};
afterEach(async () => { standardCleanup(); await account.reset(); rpc.reset(); });

it('groups native Projects without checkouts, retains No project, and opens both App inventory doors', async () => {
    const identity = 'srv_app_doors';
    const home = await account.restore({ serverIdentityId: identity,
        machines: ['runtime', 'controller'].map(id => createMachineFixture({ id })) });
    // The admitted Home identity alias must join the Account's canonical-profile Project rows.
    const scope = { ...storage.getState().settingsScope!, serverId: identity };
    const context = await captureLazyActionAccountContext(scope.serverId);
    let own = createDeploymentEnvironmentHeaderV1({ serverId: identity, controllerMachineId: 'controller', buildMachineId: 'controller' });
    const platform = createDeploymentEnvironmentHeaderV1({ ...own, id: 'platform-app', contentArtifactId: 'platform-label', projectSourceId: 'platform-source', runtimeTargetLinkId: 'platform-link' });
    const source = ProjectSourceV1Schema.parse({ id: own.projectSourceId, revision: 1, name: 'REPLAY129-C',
        audience: [], createdByAccountId: scope.accountId });
    account.home.answer(home.serverId, '/v1/projects/sources', { body: { ok: true, sources: [source], coverage: { complete: true, nextCursor: null } } });
    const runtime = createDeploymentTargetLinkHeaderV1({ machines: ['runtime'], members: [{ machineId: 'runtime', installationId: 'runtime-installation', state: 'active' }] });
    for (const environment of [own, platform]) await context.createArtifactDocument({ artifactId: environment.contentArtifactId,
        header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Same App name' }, body: '{}' });
    account.home.answer(home.serverId, '/v1/deployments/environments', { select: (_input, request) => {
        const machineId = new URL(request.url).searchParams.get('machineId');
        return { body: { ok: true, items: machineId ? [own] : [own, platform],
            runtimeTargetLinks: [runtime], coverage: 'complete', nextCursor: null } };
    } });
    let installed!: ManagedInventorySectionsState;
    let machine!: ManagedInventorySectionsState;
    function Doors() {
        const [query, setQuery] = React.useState('');
        const [filters, setFilters] = React.useState({});
        return <PluginSurfaceFocusEligibilityProvider active>
            <InstalledScreen query={{ scope, machine: null, projectKey: null, presented: true }}
                draft={{ query, setQuery, filters, setFilters }} fields={fields} groupBy="project" openKey={null} onOpenChange={NO_OPEN}>
                {state => { installed = state; return <ItemList><ManagedInventoryDirectory state={state}
                    input={{ scope, machine: null, projectKey: null }} groupBy="project" columns={2} preview={null}
                    testIDPrefix="installed-project" /></ItemList>; }}
            </InstalledScreen>
            <MachineManagedInventorySection query={{ scope, machine: { serverIdentityId: identity, machineId: 'runtime' }, projectKey: null, presented: true }}
                groupBy="project" openKey={null} onOpenChange={NO_OPEN}>
                {state => { machine = state; return null; }}
            </MachineManagedInventorySection>
        </PluginSurfaceFocusEligibilityProvider>;
    }
    const screen = await renderScreen(<Doors />);
    try {
        await vi.waitFor(() => expect(installed.rows.filter(row => row.kind === 'app')).toHaveLength(2));
        await vi.waitFor(() => expect(machine.rows.filter(row => row.kind === 'app')).toHaveLength(1));
        const key = serverAccountScopedResourceKey(scope, 'app', own.id);
        const all = installed.presentations.get(key)!;
        const exact = machine.presentations.get(key)!;
        expect(all.home).toEqual(exact.home);
        expect(all.home).toEqual({ href: buildDeploymentEnvironmentHref({ serverId: identity,
            projectSourceId: own.projectSourceId, environmentId: own.id }), scope });
        expect(all.machines).toEqual([{ serverIdentityId: identity, machineId: 'runtime' }]);
        expect(all.facts.fields.machine).toEqual([inventoryMachineKey(scope, { serverIdentityId: identity, machineId: 'runtime' })]);
        await vi.waitFor(() => expect(installed.groups.find(group => group.key === own.projectSourceId)?.rows.map(row => row.key)).toContain(key));
        expect(screen.getTextContent()).toContain('REPLAY129-C');
        expect(screen.getTextContent()).toContain('No project');
        expect(installed.presentations.get(key)?.projects).toEqual([own.projectSourceId]);
        const platformKey = serverAccountScopedResourceKey(scope, 'app', platform.id);
        expect(installed.presentations.get(platformKey)?.machines).toBeNull();
        expect(installed.groups.find(group => group.key === 'unassigned')?.rows.map(row => row.key)).toContain(platformKey);
        expect(installed.presentations.get(platformKey)?.home).toEqual({ href: buildDeploymentEnvironmentHref({ serverId: identity,
            environmentId: platform.id, projectSourceId: platform.projectSourceId }), scope });
        const reads = account.home.requests.filter(request => request.path.split('?')[0] === '/v1/deployments/environments');
        expect(reads).toHaveLength(2);
        // Both doors share the native Project catalog; no per-App detail reads.
        expect(account.home.requests.filter(request => request.path.split('?')[0] === '/v1/projects/sources')).toHaveLength(1);
        expect(account.home.requests.filter(request => request.path.startsWith('/v1/projects/sources/'))).toHaveLength(0);
        expect(reads.map(request => new URL(request.path, 'https://home.test').searchParams.get('machineId')).sort()).toEqual([null, 'runtime'].sort());
        expect(account.home.requests.filter(request => request.path.startsWith('/v1/deployments/environments/'))).toHaveLength(0);
        expect(rpc.state.requests.filter(request => request.method !== 'capabilities.detect')).toHaveLength(0);
        const apps = installed.families.find(family => family.kind === 'app');
        expect(apps).toBeDefined();
        if (!apps || apps.kind !== 'app') throw new Error('Missing App inventory family');
        const ownRow = installed.rows.find(row => row.key === key);
        const platformRow = installed.rows.find(row => row.key === platformKey);
        own = { ...own, revision: own.revision + 1 };
        await act(async () => { await apps.result.navigation.refresh(); });
        expect(installed.rows.find(row => row.key === key)).not.toBe(ownRow);
        expect.soft(installed.rows.find(row => row.key === platformKey)).toBe(platformRow);
        await act(async () => { applyProjectAccountRowsFixture(storage, { workspaceRefs: [
            { id: 'ours', serverId: scope.serverId, machineId: 'controller', rootPath: '/ours', createdAtMs: 1,
                projectKey: 'our-project', source: { sourceId: own.projectSourceId, revision: 1 } },
            { id: 'foreign', serverId: 'different-home', machineId: 'controller', rootPath: '/foreign', createdAtMs: 1,
                projectKey: 'foreign-project', source: { sourceId: own.projectSourceId, revision: 1 } },
        ] }); });
        expect.soft(installed.presentations.get(key)?.projects).toEqual(['our-project']);
        account.home.answer(home.serverId, '/v1/deployments/environments', { body: { ok: false, error: 'deployment_access_denied' } });
        await act(async () => { await apps.result.navigation.refresh(); });
        const failed = installed.families.find(family => family.kind === 'app')!;
        expect(inventoryFamilyDiagnosticCode(failed.result.coverage)).toBe('deployment_access_denied');
        // The native owner withdraws denied content; a failure is not a confirmed empty family.
        expect(installed.rows.filter(row => row.kind === 'app')).toHaveLength(0);
        expect(failed.result.coverage).toHaveProperty('unavailable');
        await flushHookEffects();
        expect(account.home.requests.filter(request => request.path.split('?')[0] === '/v1/deployments/environments')).toHaveLength(4);
    } finally { await screen.unmount(); context.dispose(); }
});
