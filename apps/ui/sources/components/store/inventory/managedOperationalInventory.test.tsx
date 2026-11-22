import { afterEach, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act, createMachineFixture, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { AutomationSourceSelectorIdV1Schema } from '@happier-dev/protocol/automations/automationEventDeclarationV1';
import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest/ingest';
import { PluginJsonValueV2Schema } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness,
    installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import type { ManagedInventoryQuery } from './useManagedInventory';

const routerMock = await vi.hoisted(async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock());
vi.mock('expo-router', () => routerMock.module);

const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
const { storage } = await import('@/sync/domains/state/storage');
const { useManagedInventory } = await import('./useManagedInventory');
const { presentInventoryRow } = await import('./inventoryRows');
const { machinePageHref } = await import('@/components/machines/page/machinePageHref');
const { InboxArtifactSourceBoundary } = await import('@/hooks/inbox/useInboxArtifactSource');
const { createAutomationDefinitionSummary } = await import('@/sync/domains/automations/automationDefinitionProjection');
const { HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1 } = await import('@happier-dev/protocol/deployments/healthCheckV1');
function Boundary({ children }: React.PropsWithChildren) { return <InboxArtifactSourceBoundary>{children}</InboxArtifactSourceBoundary>; }
function watchesField(serviceWatchesV1: unknown) {
    return MachinePublishedMetadataV1Schema.parse({ ...createMachineFixture().metadata!, serviceWatchesV1 }).serviceWatchesV1!;
}

afterEach(async () => { standardCleanup(); await account.reset(); rpc.reset(); routerMock.resetParams(); });

it('lists configured Backups through the shared App page in Installed and Machine Overview, including never-run configuration', async () => {
    const { createDeploymentEnvironmentDetailV1, createDeploymentTargetLinkHeaderV1 } = await import('@happier-dev/deployments/testing/v1');
    const { createDeploymentEnvironmentHeaderV1 } = await import('@happier-dev/deployment-protocol/testing/v1');
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 } = await import('@happier-dev/protocol/deployments/deploymentActionsV1');
    const { buildDeploymentEnvironmentHref } = await import('@/components/projects/deployments/deploymentNavigation');
    const { DeploymentBackupConfigurationV1Schema } = await import('@happier-dev/protocol/deployments/deploymentBackupActionsV1');
    const home = await account.restore({ serverIdentityId: 'srv_inventory_backups', machines: [] });
    const scope = storage.getState().settingsScope!;
    const writer = await captureLazyActionAccountContext(scope.serverId);
    const details = ['configured', 'unconfigured', 'not-needed'].map(id => createDeploymentEnvironmentDetailV1({
        environment: createDeploymentEnvironmentHeaderV1({ id, serverId: scope.serverId,
            owner: { kind: 'account', accountId: scope.accountId }, contentArtifactId: `${id}-content` }),
    }));
    const backupConfiguration = DeploymentBackupConfigurationV1Schema.parse({ configRevision: 1, destinationRef: { pluginId: 'example.storage', localId: 'open' },
        occurrenceId: 'destination', config: { bucket: 'recovery' }, credentialBindings: [],
        sources: [{ kind: 'dump', sourceId: 'database', service: 'db', consistency: 'logical' }],
        ownership: { environmentId: 'configured', prefix: 'backups' }, retention: { kind: 'keepEverything' } });
    details[0]!.content.backup = backupConfiguration;
    details[2]!.content.backup = { notNeeded: true };
    for (const detail of details) await writer.createArtifactDocument({ artifactId: detail.environment.contentArtifactId,
        header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: detail.environment.id }, body: JSON.stringify(detail.content) });
    writer.dispose();
    const runtime = createDeploymentTargetLinkHeaderV1({ environmentId: 'configured', machines: ['backup-machine'],
        members: [{ machineId: 'backup-machine', installationId: 'runtime-installation', state: 'active' }] });
    account.home.answer(home.serverId, '/v1/deployments/environments', { select: (_input, request) => ({ body: {
        ok: true, items: new URL(request.url).searchParams.has('machineId') ? [details[0]!.environment] : details.map(detail => detail.environment),
        runtimeTargetLinks: [runtime], coverage: 'complete', nextCursor: null,
    } }) });
    const reads = () => account.home.requests.filter(request => request.path.split('?')[0] === '/v1/deployments/environments');
    let query: ManagedInventoryQuery = { scope, machine: null, projectKey: null, presented: true };
    const hook = await renderHook(() => useManagedInventory(query), { wrapper: Boundary });
    const backups = () => hook.getCurrent().rows.filter(row => row.kind === 'configuredBackup');
    await vi.waitFor(() => expect(hook.getCurrent().families.app.rows).toHaveLength(3));
    expect(backups()).toHaveLength(1);
    const row = backups()[0]!;
    const presentation = presentInventoryRow(row, query);
    expect(presentation.facts.title).toBe('configured');
    expect(presentation.machines?.map(machine => machine.machineId)).toEqual(['backup-machine']);
    expect(presentation.home.href).toBe(buildDeploymentEnvironmentHref({ serverId: scope.serverId,
        projectSourceId: details[0]!.environment.projectSourceId, environmentId: 'configured', tab: 'settings', section: 'backups' }));
    expect(reads()).toHaveLength(1);
    const retained = hook.getCurrent().rows;
    await hook.rerender();
    await flushHookEffects();
    expect(hook.getCurrent().rows).toBe(retained);
    expect(reads()).toHaveLength(1);
    query = { ...query, machine: { serverIdentityId: 'srv_inventory_backups', machineId: 'backup-machine' } };
    await hook.rerender();
    await vi.waitFor(() => expect(hook.getCurrent().families.app.rows).toHaveLength(1));
    expect(backups().map(candidate => candidate.key)).toEqual([row.key]);
    expect(presentInventoryRow(backups()[0]!, query).home).toEqual(presentation.home);
    expect(reads()).toHaveLength(2);
    query = { ...query, presented: false };
    await hook.rerender();
    expect(backups()).toEqual([]);
    query = { ...query, presented: true };
    await hook.rerender();
    await vi.waitFor(() => expect(backups()).toHaveLength(1));
    expect(reads()).toHaveLength(2);
    query = { ...query, machine: null };
    await hook.rerender();
    await vi.waitFor(() => expect(hook.getCurrent().families.app.rows).toHaveLength(3));
    expect(reads()).toHaveLength(2);
    const beforeChange = backups().find(candidate => candidate.key === row.key);
    const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
    const { buildDeploymentAccountChangeV1 } = await import('@happier-dev/protocol/deployments/deploymentActionsV1');
    await act(async () => {
        for (let index = 0; index < 10; index++) publishHomeAccountChange(scope.serverId, ['unrelated-subject'], { changeKinds: ['account'] });
    });
    expect(reads()).toHaveLength(2);
    const updateConfiguration = async (configured: boolean) => {
        const detail = details[1]!;
        detail.content.backup = configured ? { ...backupConfiguration,
            ownership: { environmentId: detail.environment.id, prefix: 'backups' } } : { notNeeded: true };
        detail.environment = createDeploymentEnvironmentHeaderV1({ ...detail.environment,
            revision: detail.environment.revision + 1, contentArtifactId: `${detail.environment.id}-${detail.environment.revision + 1}` });
        const writer = await captureLazyActionAccountContext(scope.serverId);
        try {
            await writer.createArtifactDocument({ artifactId: detail.environment.contentArtifactId,
                header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: detail.environment.id }, body: JSON.stringify(detail.content) });
        } finally { writer.dispose(); }
        const change = buildDeploymentAccountChangeV1({ projectSourceId: detail.environment.projectSourceId,
            environmentId: detail.environment.id, revision: detail.environment.revision });
        await act(async () => publishHomeAccountChange(scope.serverId, [change.entityId], { changeKinds: ['account'] }));
    };
    await updateConfiguration(true);
    await vi.waitFor(() => expect(backups()).toHaveLength(2));
    expect(reads()).toHaveLength(3);
    expect(backups().find(candidate => candidate.key === row.key)).toBe(beforeChange);
    query = { ...query, presented: false };
    await hook.rerender();
    await updateConfiguration(false);
    await flushHookEffects();
    expect(reads()).toHaveLength(3);
    query = { ...query, presented: true };
    await hook.rerender();
    await vi.waitFor(() => expect(hook.getCurrent().families.app.rows[1]?.native.environment.revision).toBe(3));
    expect(backups()).toHaveLength(1);
    expect(reads()).toHaveLength(4);
    expect(account.home.requests.filter(request => request.path.includes('/backups')
        || request.path.startsWith('/v1/deployments/environments/'))).toEqual([]);
    await hook.unmount();
});

it('consumes only recorded watches as configured subjects across both doors without native discovery', async () => {
    const identity = 'srv_inventory_recorded_watches';
    const watches = watchesField({ v: 1, watches: [{ v: 1, watchId: 'adopted-native', name: 'Database watch',
        adapter: { pluginId: 'example.service', localId: 'native' }, nativeResourceId: 'opaque-native-id', lifecyclePurpose: 'infrastructure' }] });
    const machines = ['a', 'b'].map(id => createMachineFixture({ id, metadata: { ...createMachineFixture().metadata!,
        agentInventory: { checkedAt: 1, installedAgentIds: [] }, serviceWatchesV1: watches } }));
    await account.restore({ serverIdentityId: identity, machines });
    const scope = storage.getState().settingsScope!;
    let query: ManagedInventoryQuery = { scope, machine: null, projectKey: null, presented: true };
    const hook = await renderHook(() => useManagedInventory(query), { wrapper: Boundary });
    await vi.waitFor(() => expect(hook.getCurrent().operationalFamilies.watchedService.rows).toHaveLength(2));
    expect(hook.getCurrent().rows.filter(row => row.kind === 'watchedService')).toHaveLength(2);
    const native = hook.getCurrent().operationalFamilies.watchedService.rows[0]!;
    expect(presentInventoryRow(native, query).home.href).toBe(machinePageHref({ door: 'rail', target: { serverId: scope.serverId, machineId: 'a' },
        tab: { id: 'services', page: 'service', service: watches.watches[0]!.watchId } }));
    // Configuration is not a native observation. Opening All starts no list, discovery, logs or control Action.
    expect(native).not.toHaveProperty('state');
    expect(rpc.state.requests).toHaveLength(0);
    query = { ...query, machine: { serverIdentityId: identity, machineId: 'b' } };
    await hook.rerender();
    expect(hook.getCurrent().operationalFamilies.watchedService.rows.map(row => row.machineId)).toEqual(['b']);
    query = { ...query, projectKey: 'unproven-project' };
    await hook.rerender();
    expect(hook.getCurrent().operationalFamilies.watchedService.rows).toEqual([]);
    query = { ...query, projectKey: null, presented: false };
    await act(async () => { await hook.rerender(); });
    expect(rpc.state.requests.filter(request => request.method !== 'capabilities.detect')).toHaveLength(0);
});

it('keeps watch content unchanged for heartbeat and unrelated metadata, then publishes changed watch configuration', async () => {
    const watches = watchesField({ v: 1, watches: [{ v: 1, watchId: 'recorded-service', name: 'Database',
        adapter: { pluginId: 'example.service', localId: 'native' }, nativeResourceId: 'native-database', lifecyclePurpose: 'infrastructure' }] });
    const machine = createMachineFixture({ id: 'watched-machine', metadata: { ...createMachineFixture().metadata!,
        agentInventory: { checkedAt: 1, installedAgentIds: [] }, serviceWatchesV1: watches } });
    await account.restore({ serverIdentityId: 'srv_inventory_watch_locality', machines: [machine] });
    const scope = storage.getState().settingsScope!;
    const admittedMachine = storage.getState().machines[machine.id]!;
    const query: ManagedInventoryQuery = { scope, machine: null, projectKey: null, presented: true };
    const hook = await renderHook(() => useManagedInventory(query), { wrapper: Boundary });
    await vi.waitFor(() => expect(hook.getCurrent().operationalFamilies.watchedService.rows).toHaveLength(1));
    await flushHookEffects();
    const before = hook.getCurrent().operationalFamilies.watchedService.rows;
    await act(async () => { storage.getState().applyMachines([{ ...admittedMachine, activeAt: machine.activeAt + 1,
        metadataVersion: machine.metadataVersion + 1, metadata: { ...machine.metadata!, displayName: 'Renamed Machine' } }], false,
    { sourceServerId: scope.serverId, sourceAccountId: scope.accountId }); });
    await flushHookEffects();
    expect(hook.getCurrent().operationalFamilies.watchedService.rows).toBe(before);
    const changed = watchesField({ ...watches, watches: [{ ...watches.watches[0]!, name: 'Updated database' }] });
    await act(async () => { storage.getState().applyMachines([{ ...admittedMachine, metadataVersion: machine.metadataVersion + 2,
        metadata: { ...machine.metadata!, serviceWatchesV1: changed } }], false,
    { sourceServerId: scope.serverId, sourceAccountId: scope.accountId }); });
    await vi.waitFor(() => expect(hook.getCurrent().operationalFamilies.watchedService.rows[0]?.native.name).toBe('Updated database'));
    expect(rpc.state.requests).toHaveLength(0);
    // An owner withdrawal is not another kind of unchanged content.
    await act(async () => { storage.getState().applyMachines([{ ...admittedMachine, metadataVersion: machine.metadataVersion + 3, revokedAt: 1 }], false,
        { sourceServerId: scope.serverId, sourceAccountId: scope.accountId }); });
    await vi.waitFor(() => expect(hook.getCurrent().operationalFamilies.watchedService.rows).toEqual([]));
});

// QA-DEPLOY-1114 #16: Account A (175 Machines, some still loading) read "Nothing watched yet". A Machine whose content
// isn't readable yet can hold watches, so the family is partial until it is read, as Setup already says.
it('keeps watched services partial while a visible Machine\'s content is unread, and complete once it is read', async () => {
    const watches = watchesField({ v: 1, watches: [{ v: 1, watchId: 'recorded-service', name: 'Database',
        adapter: { pluginId: 'example.service', localId: 'native' }, nativeResourceId: 'native-database', lifecyclePurpose: 'infrastructure' }] });
    const machine = createMachineFixture({ id: 'unread-machine', metadata: { ...createMachineFixture().metadata!,
        agentInventory: { checkedAt: 1, installedAgentIds: [] }, serviceWatchesV1: watches } });
    await account.restore({ serverIdentityId: 'srv_inventory_watch_unread', machines: [machine] });
    const scope = storage.getState().settingsScope!;
    const admitted = storage.getState().machines[machine.id]!;
    await act(async () => { storage.getState().applyMachines([{ ...admitted, metadata: null, metadataVersion: machine.metadataVersion + 1 }], false,
        { sourceServerId: scope.serverId, sourceAccountId: scope.accountId }); });
    const query: ManagedInventoryQuery = { scope, machine: null, projectKey: null, presented: true };
    const hook = await renderHook(() => useManagedInventory(query), { wrapper: Boundary });
    await flushHookEffects();
    await vi.waitFor(() => expect(hook.getCurrent().operationalFamilies.watchedService.coverage).not.toBe('loading'));
    expect(hook.getCurrent().operationalFamilies.watchedService.rows).toEqual([]);
    expect(hook.getCurrent().operationalFamilies.watchedService.coverage).not.toBe('available');
    await act(async () => { storage.getState().applyMachines([{ ...admitted, metadataVersion: machine.metadataVersion + 2 }], false,
        { sourceServerId: scope.serverId, sourceAccountId: scope.accountId }); });
    await vi.waitFor(() => expect(hook.getCurrent().operationalFamilies.watchedService.rows).toHaveLength(1));
    expect(hook.getCurrent().operationalFamilies.watchedService.coverage).toBe('available');
    await hook.unmount();
});

function setupField(sources: readonly unknown[]) {
    return MachinePublishedMetadataV1Schema.parse({ ...createMachineFixture().metadata!,
        setup: { version: 1, revision: 1, exclusions: [], sources } }).setup!;
}
const healthCheckSummary = (id: string, enabled = true) => createAutomationDefinitionSummary({ id, name: `Check ${id}`, description: null, enabled,
    targetType: 'existingSession', existingSessionId: 'session-1', templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1, assignments: [],
    triggers: [{ id: `33333333-3333-4333-8333-33333333333${id}`, revision: 1, enabled: true, createdAt: 1, updatedAt: 1, kind: 'pluginEvent',
        eventRef: { pluginId: HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, localId: 'health-status' }, sourceSelectorId: '22222222-2222-4222-8222-222222222222',
        sourceContractVersion: 1, observation: { kind: 'checkpointedPull', watcher: null }, sourceStatus: null, sourceCatalogStatus: null }] } as never);

async function healthCheckDetail(id: string, enabled = true, encryption?: Readonly<{ secret: Uint8Array }>, notificationsOnly = false) {
    const { sealAutomationTriggerDefinitionStoredEnvelopeV1 } = await import('@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent');
    const { AutomationDefinitionDetailSchema } = await import('@happier-dev/protocol/automations/automationApiV3');
    const summary = healthCheckSummary(id, enabled);
    const { detail: _privateDetail, linkedExistingSessionId: _linkedSession, ...summaryInput } = summary;
    const trigger = summary.triggers[0]!;
    if (trigger.kind !== 'pluginEvent') throw new Error('Expected health Event fixture');
    return AutomationDefinitionDetailSchema.parse({ ...summaryInput, targetType: null, existingSessionId: null,
        observationOnly: { kind: 'observationOnly', templateVersion: summary.templateVersion },
        triggers: [{ ...trigger, triggerDefinitionEnvelope: JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({
            ...(encryption ? { mode: 'e2ee' as const, material: { type: 'legacy' as const, secret: encryption.secret },
                randomBytes: (length: number) => new Uint8Array(length).fill(3) } : { mode: 'plain' as const }),
            binding: { v: 1, automationId: summary.id, triggerId: trigger.id, triggerRevision: trigger.revision,
                triggerKind: 'pluginEvent', eventRef: trigger.eventRef, sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse(trigger.sourceSelectorId) },
            definition: { v: 1, sourceInstanceId: `health:shop:${id}`, displayLabel: 'Shop availability',
                sourceConfig: { v: 1, subject: { kind: 'environment', environmentId: 'shop' }, checks: notificationsOnly ? [] : [{ checkId: 'readiness',
                    kind: { pluginId: HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, localId: 'http' }, binding: { kind: 'healthCheck' },
                    config: { endpoint: 'https://shop.example/ready', expectStatus: 204 }, periodMs: 300_000, consecutiveFailuresBeforeAlerting: 1 }],
                    ...(notificationsOnly ? { alerts: { channels: [], phases: ['open', 'recovered'] } } : {}) },
                filter: null, maximumObservationAgeMs: null },
        })) }] });
}

it('lists each attached preset as Setup on its Machine, including one that has never run, without a Software duplicate for direct installs', async () => {
    const identity = 'srv_inventory_setup';
    const setup = setupField([
        { kind: 'bundledPreset', ref: { pluginId: 'happier.machine.recipes', localId: 'web-host', revision: '1' }, setup: { items: [] } },
        { kind: 'direct', setup: { toolchain: { adapterId: 'mise', config: '[tools]' } } },
    ]);
    const machine = createMachineFixture({ id: 'setup-machine', metadata: { ...createMachineFixture().metadata!,
        agentInventory: { checkedAt: 1, installedAgentIds: [] }, setup } });
    await account.restore({ serverIdentityId: identity, machines: [machine] });
    const scope = storage.getState().settingsScope!;
    const query: ManagedInventoryQuery = { scope, machine: null, projectKey: null, presented: true };
    const hook = await renderHook(() => useManagedInventory(query), { wrapper: Boundary });
    await vi.waitFor(() => expect(hook.getCurrent().operationalFamilies.setup.rows).toHaveLength(1));
    expect(hook.getCurrent().operationalFamilies.setup.coverage).toBe('available');
    const row = hook.getCurrent().operationalFamilies.setup.rows[0]!;
    expect(row).toMatchObject({ kind: 'setup', machineId: 'setup-machine' });
    expect(row.source.kind).toBe('bundledPreset');
    expect(presentInventoryRow(row, query).home.href).toBe(machinePageHref({ door: 'rail', target: { serverId: scope.serverId, machineId: 'setup-machine' }, tab: { id: 'setup' } }));
    expect(hook.getCurrent().rows.some(candidate => candidate.kind === 'setup')).toBe(true);
    expect(rpc.state.requests).toHaveLength(0);
});

it('omits a settled environment notification source that has no checks', async () => {
    const automations = await Promise.all([healthCheckDetail('a'), healthCheckDetail('b', true, undefined, true)]);
    await account.restore({ serverIdentityId: 'srv_inventory_checks', machines: [], httpAnswers: {
        'POST /v3/automations/query': { body: { automations, nextCursor: null } },
    } });
    const scope = storage.getState().settingsScope!;
    await act(async () => { storage.setState({ automations: { a: healthCheckSummary('a'), b: healthCheckSummary('b') },
        isDataReady: true, automationDefinitionNextCursor: null }); });
    const hook = await renderHook(() => useManagedInventory({ scope, machine: null, projectKey: null, presented: true, kinds: ['configuredCheck'] }),
        { wrapper: Boundary });
    await vi.waitFor(() => expect(hook.getCurrent().operationalFamilies.configuredCheck.coverage).toEqual({ partial: 'health_result_unavailable' }));
    expect(hook.getCurrent().operationalFamilies.configuredCheck.rows.map(row => row.automationId)).toEqual(['a']);
    await hook.unmount();
});

it('lists saved Checks from Automation summaries, keeps never-run and off subjects, and does not place them on a selected Machine', async () => {
    const details = await Promise.all([healthCheckDetail('a'), healthCheckDetail('b', false)]);
    await account.restore({ serverIdentityId: 'srv_inventory_checks', machines: [], httpAnswers: {
        'POST /v3/automations/query': { body: { automations: details, nextCursor: null } },
    } });
    const scope = storage.getState().settingsScope!;
    await act(async () => { storage.setState({ automations: { a: healthCheckSummary('a'), b: healthCheckSummary('b', false) }, isDataReady: true, automationDefinitionNextCursor: null }); });
    let query: ManagedInventoryQuery = { scope, machine: null, projectKey: null, presented: true };
    const hook = await renderHook(() => useManagedInventory(query), { wrapper: Boundary });
    await vi.waitFor(() => expect(hook.getCurrent().operationalFamilies.configuredCheck.rows).toHaveLength(2));
    await vi.waitFor(() => expect(hook.getCurrent().operationalFamilies.configuredCheck.coverage).toEqual({ partial: 'health_result_unavailable' }));
    const row = hook.getCurrent().operationalFamilies.configuredCheck.rows.find(candidate => candidate.automationId === 'b')!;
    expect(row.lastResults).toMatchObject({ kind: 'unavailable' });
    const presented = presentInventoryRow(row, query);
    expect(presented.facts.title).toBe('Check b');
    expect(presented.facts.status).toBe('off');
    expect(presented.home.href).toBe('/automations/b');
    await act(async () => { storage.setState({ automationDefinitionNextCursor: 'more' }); });
    await vi.waitFor(() => expect(hook.getCurrent().operationalFamilies.configuredCheck.coverage).toEqual({ partial: 'automation_page' }));
    query = { ...query, machine: { serverIdentityId: 'srv_inventory_checks', machineId: 'unknown' } };
    await hook.rerender();
    expect(hook.getCurrent().operationalFamilies.configuredCheck.rows).toEqual([]);
    await hook.unmount();
});

// SERVICES-ACCEPT-1116 F4: a Check is one kind of Automation, paged with all the others. One Show more brings the
// next saved Check even when the Automation page after this one holds none, instead of answering with nothing.
it.each(['manual', 'complete'] as const)('follows the Automation pages past ones without a Check (%s coverage)', async coverage => {
    const [a, c] = await Promise.all([healthCheckDetail('a'), healthCheckDetail('c')]);
    const { triggers: _triggers, ...plain } = a;
    const other = { ...plain, id: 'other', name: 'Nightly report', triggers: [] };
    const pages: Record<string, Readonly<{ automations: unknown[]; nextCursor: string | null }>> = {
        first: { automations: [a], nextCursor: 'p2' }, p2: { automations: [other], nextCursor: 'p3' }, p3: { automations: [c], nextCursor: null },
    };
    const page = (cursor: string | null | undefined) => ({ body: pages[cursor ?? 'first'] });
    await account.restore({ serverIdentityId: 'srv_inventory_check_pages', machines: [], httpAnswers: {
        'POST /v3/automations/query': { select: (input) => page((input as { cursor?: string } | null)?.cursor) },
        'GET /v3/automations': { select: (_input, request) => page(new URL(request.url).searchParams.get('cursor')) },
    } });
    const scope = storage.getState().settingsScope!;
    await act(async () => { storage.setState({ automations: { a: healthCheckSummary('a') }, isDataReady: true, automationDefinitionNextCursor: 'p2' }); });
    const query = { scope, machine: null, projectKey: null, presented: true, kinds: ['configuredCheck'] as const,
        completeConfiguredChecks: coverage === 'complete' };
    const hook = await renderHook(() => useManagedInventory(query), { wrapper: Boundary });
    if (coverage === 'manual') {
        await vi.waitFor(() => expect(hook.getCurrent().operationalFamilies.configuredCheck.coverage).toEqual({ partial: 'automation_page' }));
        const more = hook.getCurrent().operationalFamilies.configuredCheck.continuation as () => Promise<unknown>;
        await act(async () => { await more(); });
    }
    await vi.waitFor(() => expect(hook.getCurrent().operationalFamilies.configuredCheck.rows.map(row => row.automationId)).toEqual(['a', 'c']));
    expect(hook.getCurrent().operationalFamilies.configuredCheck.coverage).not.toEqual({ partial: 'automation_page' });
    await hook.unmount();
});

it('reads an addressed Check outside the loaded Automation page without traversing unrelated definitions', async () => {
    const [first, selected] = await Promise.all([healthCheckDetail('a'), healthCheckDetail('c')]);
    await account.restore({ serverIdentityId: 'srv_inventory_addressed_check', machines: [], httpAnswers: {
        'GET /v3/automations/c': { body: selected },
        'POST /v3/automations/query': { body: { automations: [first], nextCursor: 'unrelated-page' } },
    } });
    const scope = storage.getState().settingsScope!;
    await act(async () => storage.getState().applyAutomations([healthCheckSummary('a')], 'unrelated-page'));
    const query = { scope, machine: null, projectKey: null, presented: true, kinds: ['configuredCheck'] as const,
        configuredCheck: { automationId: selected.id, triggerId: selected.triggers[0]!.id } };
    const hook = await renderHook(() => useManagedInventory(query), { wrapper: Boundary });
    await vi.waitFor(() => expect(hook.getCurrent().operationalFamilies.configuredCheck.rows.map(row => row.automationId)).toEqual(['c']));
    expect(account.home.requests.filter(request => request.path === '/v3/automations/c')).toHaveLength(1);
    expect(account.home.requests.filter(request => request.path === '/v3/automations/query')).toHaveLength(0);
    await hook.unmount();
});

it.each([404, 503])('keeps an addressed Check refusal distinct from unavailable storage (HTTP %s)', async status => {
    await account.restore({ serverIdentityId: `srv_inventory_addressed_${status}`, machines: [], httpAnswers: {
        'GET /v3/automations/retained': { status, body: { error: status === 404 ? 'automation_not_found' : 'database_connection_unavailable' } },
    } });
    const scope = storage.getState().settingsScope!;
    const query = { scope, machine: null, projectKey: null, presented: true, kinds: ['configuredCheck'] as const,
        configuredCheck: { automationId: 'retained', triggerId: 'retained-trigger' } };
    const hook = await renderHook(() => useManagedInventory(query), { wrapper: Boundary });
    await vi.waitFor(() => expect(hook.getCurrent().operationalFamilies.configuredCheck.coverage).toEqual(status === 404
        ? 'available' : { unavailable: { code: 'database_connection_unavailable', status: 503 } }));
    expect(hook.getCurrent().operationalFamilies.configuredCheck.rows).toEqual([]);
    expect(account.home.requests.filter(request => request.path === '/v3/automations/retained')).toHaveLength(1);
    await hook.unmount();
});

it('keeps an addressed Check storage failure visible beside cached facts and retries that address', async () => {
    const { createAutomationDefinitionFromDetail } = await import('@/sync/domains/automations/automationDefinitionProjection');
    const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
    await loadSyncSingletonForTests();
    const { renderAccountScreen } = await import('@/dev/testkit/render/renderAccountScreen');
    const { ServiceCheckPage } = await import('@/components/projects/deployments/ServiceCheckPage');
    const selected = await healthCheckDetail('retained');
    await account.restore({ serverIdentityId: 'srv_inventory_addressed_cached', machines: [], httpAnswers: {
        'GET /v3/automations/retained': { status: 503, body: { error: 'database_connection_unavailable' } },
    } });
    const scope = storage.getState().settingsScope!;
    await act(async () => storage.getState().applyAutomations([createAutomationDefinitionFromDetail(selected)], 'unrelated-page'));
    routerMock.module.router.setParams({ automation: selected.id, trigger: selected.triggers[0]!.id });
    const screen = await renderAccountScreen(<ServiceCheckPage />);
    await vi.waitFor(() => expect(screen.findHostByTestId('services.check.page.coverage.unavailable.retry')).toBeTruthy());
    expect(screen.findHostByTestId('services.check.page.missing')).toBeNull();
    expect(screen.findHostByTestId('services.check.page.header')).toBeTruthy();
    expect(account.home.requests.filter(request => request.path === '/v3/automations/retained')).toHaveLength(1);
    account.home.answer(scope.serverId, 'GET /v3/automations/retained', { body: selected });
    await screen.pressByTestIdAsync('services.check.page.coverage.unavailable.retry');
    await vi.waitFor(() => expect(screen.findHostByTestId('services.check.page.coverage.unavailable.retry')).toBeNull());
    expect(screen.findHostByTestId('services.check.page.missing')).toBeNull();
    expect(account.home.requests.filter(request => request.path === '/v3/automations/retained')).toHaveLength(2);
    expect(account.home.requests.filter(request => request.path === '/v3/automations/query')).toHaveLength(0);
    await screen.unmount();
});

it('removes an addressed Check cached row after its canonical read returns not found', async () => {
    const { createAutomationDefinitionFromDetail } = await import('@/sync/domains/automations/automationDefinitionProjection');
    const selected = await healthCheckDetail('retained');
    await account.restore({ serverIdentityId: 'srv_inventory_addressed_cached_missing', machines: [], httpAnswers: {
        'GET /v3/automations/retained': { status: 404, body: { error: 'automation_not_found' } },
    } });
    const scope = storage.getState().settingsScope!;
    await act(async () => storage.getState().applyAutomations([createAutomationDefinitionFromDetail(selected)], null));
    const query = { scope, machine: null, projectKey: null, presented: true, kinds: ['configuredCheck'] as const,
        configuredCheck: { automationId: selected.id, triggerId: selected.triggers[0]!.id } };
    const hook = await renderHook(() => useManagedInventory(query), { wrapper: Boundary });
    await vi.waitFor(() => expect(hook.getCurrent().operationalFamilies.configuredCheck.coverage).toBe('available'));
    expect(hook.getCurrent().operationalFamilies.configuredCheck.rows).toEqual([]);
    await hook.unmount();
});

it.each(['plain', 'e2ee'] as const)('reads never-observed Check definition facts once for the presented Account and releases private page demand when hidden (%s)', async mode => {
    const { createAutomationDefinitionFromDetail } = await import('@/sync/domains/automations/automationDefinitionProjection');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { readAutomationDefinitionDetailsDemand } = await import('@/sync/domains/automations/automationReadDemand');
    const secret = new Uint8Array(32).fill(17);
    await account.restore({ serverIdentityId: 'srv_inventory_check_facts', machines: [], ...(mode === 'e2ee' ? { e2eeSecret: secret } : {}) });
    const scope = storage.getState().settingsScope!;
    const detail = await healthCheckDetail('a', true, mode === 'e2ee' ? { secret } : undefined);
    const { DEPLOYMENT_RECEIPT_CHANGED_EVENT_REF_V1, DEPLOYMENT_RECEIPT_EVENT_REFS_V1, DeploymentReceiptEventSourceConfigV1Schema } = await import('@happier-dev/protocol/deployments/deploymentReceiptEventsV1');
    const { sealAutomationTriggerDefinitionStoredEnvelopeV1 } = await import('@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent');
    const eventRefs = [DEPLOYMENT_RECEIPT_CHANGED_EVENT_REF_V1, DEPLOYMENT_RECEIPT_EVENT_REFS_V1.failed, DEPLOYMENT_RECEIPT_EVENT_REFS_V1.failed];
    const unrelated = await Promise.all(eventRefs.map(async (eventRef, index) => {
        const row = await healthCheckDetail(['b', 'c', 'd'][index]!, true, mode === 'e2ee' ? { secret } : undefined);
        const trigger = row.triggers[0]!;
        if (trigger.kind !== 'pluginEvent') throw new Error('Expected Event fixture');
        return { ...row, name: 'Workflow triggers', triggers: [{ ...trigger, eventRef,
            triggerDefinitionEnvelope: JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({
                ...(mode === 'e2ee' ? { mode, material: { type: 'legacy' as const, secret }, randomBytes: (length: number) => new Uint8Array(length).fill(4) } : { mode }),
                binding: { v: 1, automationId: row.id, triggerId: trigger.id, triggerRevision: trigger.revision, triggerKind: 'pluginEvent', eventRef,
                    sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse(trigger.sourceSelectorId) },
                definition: PluginJsonValueV2Schema.parse({ v: 1, sourceInstanceId: `deployment:${row.id}`, displayLabel: 'Deployment failed',
                    sourceConfig: DeploymentReceiptEventSourceConfigV1Schema.parse({ v: 1, serverId: scope.serverId, environmentId: 'shop', observingSince: 1 }),
                    filter: null, maximumObservationAgeMs: null }),
            })) }] };
    }));
    account.home.answer(scope.serverId, 'POST /v3/automations/query', { body: { automations: [detail, ...unrelated], nextCursor: null } });
    const { detail: _detail, linkedExistingSessionId: _linked, ...summary } = createAutomationDefinitionFromDetail(detail);
    await act(async () => storage.setState({ automations: { a: createAutomationDefinitionSummary(summary),
        ...Object.fromEntries(unrelated.map(row => [row.id, createAutomationDefinitionFromDetail(row)])) }, isDataReady: true }));
    let query: ManagedInventoryQuery = { scope, machine: null, projectKey: null, presented: true, kinds: ['configuredCheck'] };
    const hook = await renderHook(() => useManagedInventory(query), { wrapper: Boundary });
    await vi.waitFor(() => expect(hook.getCurrent().operationalFamilies.configuredCheck.rows[0]).toMatchObject({
        definitionFacts: { kind: 'available', checks: [{ checkId: 'readiness', targetLabel: 'shop.example/ready', periodMs: 300_000 }] },
    }));
    expect(hook.getCurrent().operationalFamilies.configuredCheck.rows.map(row => row.automationId)).toEqual(['a']);
    expect(Object.keys(storage.getState().automations)).toEqual(expect.arrayContaining(unrelated.map(row => row.id)));
    const { plugin } = await import('../../../../../../packages/plugins/machine-services/src/manifest');
    const { PluginAccountAvailabilityIntentReadResponseV1Schema, createPackageAssetArchiveV1 } = await import('@happier-dev/protocol/plugins/availability');
    const { replacePluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
    const parsed = ingestPluginManifestV2(plugin.manifest);
    if (!parsed.ok) throw new Error('Expected bundled health plugin manifest');
    const manifest = parsed.manifest;
    const archive = createPackageAssetArchiveV1({ manifest,
        files: manifest.contributes.resources.flatMap(resource => resource.source !== 'dynamic' && resource.kind === 'asset'
            ? [{ path: resource.path, bytes: new TextEncoder().encode('{}') }] : []) });
    if (!archive) throw new Error('Expected actual plugin assets to form a release fixture');
    const response = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({ availabilityCursor: 1,
        hostingCapability: { enabled: false },
        intent: { pluginId: plugin.manifest.id, desiredVersion: plugin.manifest.version, enabled: true,
            offlineUiHosting: 'disabled', writableCollections: [], revision: 'health-kinds' },
        release: { ref: { pluginId: plugin.manifest.id, version: plugin.manifest.version },
            archiveDigestSha256: `sha256:${'a'.repeat(64)}`, normalizedManifest: plugin.manifest, collectionContracts: [], uiSlots: [],
            packageAssetArchive: archive.descriptor },
        packageAssets: [], uiArtifacts: [] });
    await act(async () => replacePluginAccountAvailabilityProjection({ scope, snapshot: { availabilityCursor: 1,
        intentReads: [{ pluginId: plugin.manifest.id, response }], materializations: [], snapshots: [] } }));
    await vi.waitFor(() => expect(hook.getCurrent().operationalFamilies.configuredCheck.rows[0]).toMatchObject({
        definitionFacts: { kind: 'available', checks: [{ checkId: 'readiness', name: 'HTTP' }] },
    }));
    const { PluginMachineMaterializationV1Schema } = await import('@happier-dev/protocol/plugins/availability');
    const materialization = PluginMachineMaterializationV1Schema.parse({ serverIdentityId: 'srv_inventory_check_facts',
        machineId: 'observer', materializationId: 'health-installation', pluginId: plugin.manifest.id, version: plugin.manifest.version,
        sourceClass: 'localPath', portableRelease: false, declaredManifest: plugin.manifest, uiArtifacts: [],
        enabled: true, trustState: 'trusted', observedAt: 1 });
    const peer = PluginMachineMaterializationV1Schema.parse({ ...materialization, machineId: 'other-observer',
        declaredManifest: { ...plugin.manifest, contributes: { ...plugin.manifest.contributes,
            healthCheckKinds: manifest.contributes.healthCheckKinds.map(kind => ({ ...kind, title: 'Other Machine check' })) } } });
    await act(async () => replacePluginAccountAvailabilityProjection({ scope, snapshot: { availabilityCursor: 2,
        intentReads: [{ pluginId: plugin.manifest.id, response: { ...response, intent: null, release: null } }],
        materializations: [peer, materialization], snapshots: [peer, materialization].map(row => ({
            serverIdentityId: row.serverIdentityId, machineId: row.machineId, materializations: [row] })) } }));
    // No observer has been assigned yet; neither its source label nor another Machine declares its check kind.
    await vi.waitFor(() => expect(hook.getCurrent().operationalFamilies.configuredCheck.rows[0]).toMatchObject({
        definitionFacts: { kind: 'available', observerMachineId: null, checks: [{ checkId: 'readiness', name: null }] },
    }));
    await act(async () => storage.setState({ automations: { a: createAutomationDefinitionFromDetail({ ...detail,
        triggers: detail.triggers.map(trigger => trigger.kind === 'pluginEvent' ? { ...trigger,
            observation: { kind: 'checkpointedPull', watcher: { machineId: 'observer', machineInstallationId: 'observer-installation',
                pluginId: plugin.manifest.id, materializationId: 'health-installation' } } } : trigger) }) } }));
    // The Machine that runs the check is named once it is assigned (Monitoring says when it stops checking).
    await vi.waitFor(() => expect(hook.getCurrent().operationalFamilies.configuredCheck.rows[0]).toMatchObject({
        definitionFacts: { kind: 'available', observerMachineId: 'observer', checks: [{ checkId: 'readiness', name: 'HTTP' }] },
    }));
    const lifetime = captureActiveServerAccountScopeLifetime();
    expect(readAutomationDefinitionDetailsDemand(lifetime)).toBe(true);
    const ownedReads = () => account.home.requests.filter(request => request.path.startsWith('/v3/automations')
        || request.path.startsWith('/v1/deployments/domains') || request.path === '/v1/account/encryption/currentness');
    const reads = ownedReads().length;
    const rows = hook.getCurrent().operationalFamilies.configuredCheck.rows;
    expect(rows[0]!.native.name).toBe('Check a');
    if (rows[0]!.definitionFacts.kind !== 'available') throw new Error('Expected readable source facts');
    expect(rows[0]!.definitionFacts.checks[0]).not.toHaveProperty('address');
    await hook.rerender(); await flushHookEffects();
    expect(hook.getCurrent().operationalFamilies.configuredCheck.rows).toBe(rows);
    expect(ownedReads().length).toBe(reads);
    query = { ...query, presented: false };
    await hook.rerender(); await flushHookEffects();
    expect(hook.getCurrent().operationalFamilies.configuredCheck.rows).toEqual([]);
    expect(readAutomationDefinitionDetailsDemand(lifetime)).toBe(false);
    expect(ownedReads().length).toBe(reads);
    let releaseCurrentness!: () => void;
    const currentnessGate = new Promise<void>(resolve => { releaseCurrentness = resolve; });
    let currentnessRequested = false;
    account.home.answer(scope.serverId, '/v1/account/encryption/currentness', {
        select: () => { currentnessRequested = true; return { status: 503, body: { error: 'unavailable' }, respondAfter: currentnessGate }; },
    });
    try {
        query = { ...query, presented: true };
        await hook.rerender();
        await vi.waitFor(() => expect(currentnessRequested).toBe(true));
        expect(hook.getCurrent().operationalFamilies.configuredCheck.rows[0]?.definitionFacts.kind).toBe('loading');
    } finally { releaseCurrentness(); }
    await vi.waitFor(() => expect(hook.getCurrent().operationalFamilies.configuredCheck.rows[0]?.definitionFacts.kind).toBe('unavailable'));
    query = { ...query, presented: false };
    await hook.rerender(); await flushHookEffects();
    await account.restore({ accountId: 'other-account', serverIdentityId: 'srv_inventory_check_facts', machines: [], httpAnswers: {
        'POST /v3/automations/query': { body: { automations: [], nextCursor: null } },
    } });
    query = { ...query, scope: storage.getState().settingsScope!, presented: true };
    await hook.rerender(); await flushHookEffects();
    await vi.waitFor(() => expect(hook.getCurrent().operationalFamilies.configuredCheck.coverage).toBe('available'));
    expect(hook.getCurrent().operationalFamilies.configuredCheck.rows).toEqual([]);
    expect(readAutomationDefinitionDetailsDemand(lifetime)).toBe(false);
});
