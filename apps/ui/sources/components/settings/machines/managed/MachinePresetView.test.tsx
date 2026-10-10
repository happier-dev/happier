import * as React from 'react';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installMachinesSettingsCommonModuleMocks } from '../machinesSettingsTestHelpers';
import { teamSummaryFixture, teamCapabilitiesFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { PluginJsonSchemaV2Schema, PluginProjectedActionV2Schema, type PluginJsonSchemaV2 } from '@happier-dev/protocol';
import { DaemonContributionRegistryProjectionDescribeResponseSchema, DaemonPluginActionSchemasReadResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { MachineProvisionersListResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE } from '@/dev/testkit/fixtures/pluginProviderDaemonProjection';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';

const route = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const boundary = vi.hoisted(() => ({ rpc: vi.fn() }));
// Vitest substitutes Metro's deferred loader, not the admitted Action or inventory logic.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(boundary.rpc);
});
installMachinesSettingsCommonModuleMocks({
    text: async () => vi.importActual<typeof import('@/text')>('@/text'),
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ router: route }).module;
    },
});
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
// Transform the real owners after the transport/platform boundaries, outside the case budget.
const { MachinePresetView } = await import('./MachinePresetView');
const { MachinesSettingsView } = await import('../MachinesSettingsView');
const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
const { MachineProvisionerPicker } = await import('./MachineProvisionerPicker');
const { Item } = await import('@/components/ui/lists/Item');
const { MachineConfigurationReceipt } = await import('./MachineConfigurationReceipt');
const { MachinePresetDetail } = await import('./MachinePresetDetail');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { InstalledPluginBrandMark } = await import('@/components/plugins/shared/InstalledPluginBrandMark');
const { t } = await import('@/text');
const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { resetMachineProjectionReadsForTests } = await import('@/sync/ops/machineContributionRegistryProjection');
beforeEach(async () => {
    await harness.reset();
    route.push.mockReset();
    route.replace.mockReset();
    (await import('@/sync/ops/actions/scopedHomeActionExecutor')).resetScopedHomeActionExecutorsForTests();
    clearDaemonMergedProjectionCacheForTests(); resetMachineProjectionReadsForTests();
    boundary.rpc.mockReset().mockResolvedValue({ ok: false, code: 'unsupported' });
});
afterEach(() => standardCleanup());

const preset = { id: 'preset', homeId: 'srv_history', revision: 3, name: 'Build box',
    owner: { kind: 'account', accountId: 'owner' },
    recipe: { provider: { pluginId: 'custom.compute', localId: 'native' }, schemaVersion: 1, name: 'Future guest', choices: {} },
    controller: { machineId: 'controller', installationId: 'installation' }, simultaneousLimit: { maximum: 2 } } as const;
const savedCredential = { purpose: { consumer: preset.recipe.provider, purpose: 'native-management' },
    account: { service: { pluginId: 'custom.compute', localId: 'native-account' }, accountId: 'saved-native-account' } } as const;
const resource = { id: 'resource', homeId: 'srv_history', custodianAccountId: 'owner', preset: { id: 'preset', revision: 1 },
    launch: { ...preset.recipe, name: 'Original guest' }, controller: preset.controller,
    resource: { contributionRef: preset.recipe.provider, schemaVersion: 1, value: { nativeId: 'original' } },
    allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false, enrolledMachineId: 'guest' } as const;
const provisioner: MachineProvisionersListResultV1['provisioners'][number] = { contribution: preset.recipe.provider, occurrenceId: 'occurrence', credentialPurposes: [], descriptor: {
    id: 'native', title: 'Custom compute', icon: 'server', resourceKind: 'VM', schemaVersion: 1,
    launchSchema: { type: 'object', properties: { cpu: { type: 'integer', minimum: 1 } }, additionalProperties: false },
    resourceSchema: { type: 'object', properties: {}, additionalProperties: false }, platforms: ['linux'], prerequisites: [],
    billing: { location: 'cloud', stoppedBilling: 'billed' }, retention: { supportedIntents: ['delete'] },
    actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', destroy: 'destroy' },
} };

function seedOptionsDeclaration(row: MachineProvisionersListResultV1['provisioners'][number], inputSchema: PluginJsonSchemaV2,
    schemaAvailable = true, installed?: Readonly<Record<string, unknown>>) {
    const action = { pluginId: row.contribution.pluginId, localId: row.descriptor.actions.options };
    const actionKey = buildQualifiedPluginContributionKey(action);
    // Infrastructure role metadata may be CLI/plugin-only. Reading its public
    // schema for a managed options query does not make it a new UI Action.
    const projectedAction = PluginProjectedActionV2Schema.parse({ id: action.localId, pluginId: action.pluginId,
        occurrenceId: 'options-occurrence', title: 'Read native options', scopes: ['machine'], surfaces: ['cli', 'plugin'],
        execution: { target: 'daemon' }, available: true, dangerLevel: 'safe' });
    const projection = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection: {
        ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE, agentsById: {}, diagnostics: [],
        installedPackagesById: { [action.pluginId]: { ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.installedPackagesById['acme.review'], id: action.pluginId,
            ...installed } },
        actionsById: { [actionKey]: projectedAction },
    } });
    boundary.rpc.mockImplementation(async (request: { machineId: string; method: string; payload: unknown }) => {
        if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return projection;
        if (request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ) {
            expect(request.machineId).toBe(preset.controller.machineId);
            expect(request.payload).toEqual({ machineId: preset.controller.machineId,
                expectedOccurrenceId: projectedAction.occurrenceId, qualifiedActionId: actionKey });
            return DaemonPluginActionSchemasReadResponseSchema.parse(schemaAvailable
                ? { ok: true, inputSchema } : { ok: false, code: 'stale_occurrence' });
        }
        return { ok: false, code: 'unsupported' };
    });
}

async function seed() {
    const serverId = await harness.addHome({ name: 'History', serverUrl: 'https://history.example', serverIdentityId: 'srv_history', accountId: 'owner', currentAccount: true });
    await harness.addHome({ name: 'Other', serverUrl: 'https://other.example', serverIdentityId: 'srv_other', accountId: 'other' });
    harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset } });
    harness.answer(serverId, '/v1/machines/managed/actions/list', { select: input => ({ body: { machines:
        input && typeof input === 'object' && 'archived' in input ? [] : [resource] } }) });
    return serverId;
}

async function seedConfiguration(serverId: string) {
    seedOptionsDeclaration(provisioner, PluginJsonSchemaV2Schema.parse({ type: 'object', properties: {}, additionalProperties: false }));
    const { storage } = await import('@/sync/domains/state/storage');
    const machine = createMachineFixture({ id: preset.controller.machineId, installationId: preset.controller.installationId });
    const scopeId = resolveServerProfileScopeIdForIdentifier(serverId);
    storage.setState({ machineListByServerId: { [scopeId]: [machine] } });
    for (const [actionId, result] of [
        ['machines.provisioners.list', { controller: preset.controller, provisioners: [provisioner] }],
        ['machines.provisioners.check', { available: true }],
        ['machines.provisioners.options', { choices: [{ id: 'saved', title: 'Saved size', launch: {} },
            { id: 'large', title: 'Larger size', launch: { cpu: 4 } }] }],
    ] as const) harness.answer(serverId, `/v1/actions/${actionId}`, { select: value => {
        const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
        expect(request.target).toEqual({ kind: 'machine', machineId: preset.controller.machineId });
        expect(request.input).toMatchObject({ homeId: preset.homeId, controller: preset.controller });
        return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result } } };
    } });
    return scopeId;
}

describe('reachable preset detail', () => {
    it('reopens retired resources from the Machines archive without returning them to its active list', async () => {
        const serverId = await seed();
        const scopeId = await seedConfiguration(serverId);
        const { setActiveServer } = await import('@/sync/domains/server/serverRuntime');
        await setActiveServer({ serverId, scope: 'tab' });
        await harness.selectHomes([serverId]);
        harness.answer(serverId, '/v1/machines/managed/actions/list', { select: input => ({ body: { machines:
            input && typeof input === 'object' && 'archived' in input ? [{ ...resource, archivedAt: 1 }] : [] } }) });
        const screen = await renderSettingsView(<MachinesSettingsView />);
        await waitForHomeGovernance(() => {
            expect(Boolean(screen.findByTestId(`settings.machines.archived.${scopeId}`))).toBe(true);
        });
        expect(screen.findByTestId(`settings.machines.managed.${scopeId}.resource`)).toBeNull();
        await act(async () => screen.pressByTestId(`settings.machines.archived.${scopeId}`));
        await waitForHomeGovernance(() => expect(screen.findByTestId(`settings.machines.managed.${scopeId}.resource`)).not.toBeNull());
        await act(async () => screen.pressByTestId(`settings.machines.managed.${scopeId}.resource`));
        expect(route.push).toHaveBeenLastCalledWith(`/settings/machines/managed/resource?serverId=${encodeURIComponent(scopeId)}`);
        expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toEqual([]);
    });
    it('hides Create one on the addressed Account opt-out while keeping edits and history available', async () => {
        const serverId = await seed();
        const scopeId = await seedConfiguration(serverId);
        harness.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
            managedMachineCreationEnabled: false,
        } }, version: 1 } });
        const screen = await renderSettingsView(<MachinePresetView serverId={scopeId} presetId="preset" />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('machine-preset.detail.machine.resource')).not.toBeNull());
        await flushHookEffects();
        expect(Boolean(screen.findByTestId('machine-preset.detail.createOne'))).toBe(false);
        expect(screen.findByTestId('machine-preset.creation-disabled')).not.toBeNull();
        expect(screen.findByTestId('machine-preset.edit')).not.toBeNull();
        expect(screen.findByTestId('machine-preset.detail.archive')).not.toBeNull();
        harness.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
            managedMachineCreationEnabled: true,
        } }, version: 2 } });
        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        await act(async () => publishHomeAccountChange(scopeId));
        await waitForHomeGovernance(() => expect(screen.findByTestId('machine-preset.detail.createOne')).not.toBeNull());
        expect(screen.findByTestId('machine-preset.creation-disabled')).toBeNull();
        expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toEqual([]);
    });
    it('withdraws a Team preset editor when its Team read loses access without changing the credential or preset response', async () => {
        const serverId = await seed();
        const scopeId = await seedConfiguration(serverId);
        const teamPreset = { ...preset, owner: { kind: 'team', teamId: 'team-1' }, environment: { setupScript: 'echo team setup' } };
        harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: teamPreset } });
        const { bindHomeDomainActionHttpRequestV1 } = await import('@happier-dev/protocol/actions/homeDomainActionFamily');
        const request = bindHomeDomainActionHttpRequestV1('teams.get', { v: 1, teamId: 'team-1' });
        harness.answer(serverId, request.path, { body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({ manageSettings: true }) }) });
        const screen = await renderSettingsView(<ManagedMachineConfigurationView serverId={scopeId}
            provisioner={buildQualifiedPluginContributionKey(preset.recipe.provider)} presetId={preset.id} presetOnly />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.environment.setup.input')?.props.value).toBe('echo team setup'));
        harness.answer(serverId, request.path, { status: 403, body: { code: 'permission_denied' } });
        const { refreshTeam } = await import('@/sync/engine/teams/teamsDirectoryEngine');
        const { createServerAccountScope } = await import('@/sync/domains/scope/serverAccountScope');
        const { createTeamAddress } = await import('@/sync/domains/teams/teamAddress');
        const scope = createServerAccountScope(scopeId, 'owner');
        const address = createTeamAddress(scopeId, 'team-1');
        if (!scope || !address) throw new Error('Expected the seeded exact Team scope');
        await act(async () => { await refreshTeam(scope, address); });
        await flushHookEffects();
        expect(screen.findByTestId('managed-config.environment.setup.input')).toBeNull();
        expect(screen.findByTestId('managed-config.choice:large')).toBeNull();
        expect(harness.requestsFor('/v1/machines/presets/get')).toHaveLength(1);
    });
    it.each(['permission_denied', 'unavailable'])('refreshes protected editor content on Home changes (%s)', async code => {
        const serverId = await seed();
        const scopeId = await seedConfiguration(serverId);
        const environment = { setupScript: 'echo protected setup', secretRefs: { v: 1, bindings: { TOKEN: { ref: 'protected-secret' } } } };
        harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: { ...preset, environment } } });
        await harness.requireUiApproval(serverId, 'machines.presets.update');
        const screen = await renderSettingsView(<ManagedMachineConfigurationView serverId={scopeId}
            provisioner={buildQualifiedPluginContributionKey(preset.recipe.provider)} presetId={preset.id} presetOnly />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.environment.setup.input')?.props.value).toBe(environment.setupScript));
        await act(async () => screen.changeTextByTestId('managed-config.environment.setup.input', 'echo unsaved setup'));
        await act(async () => screen.pressByTestId('managed-config.choice:large'));
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(false));
        await act(async () => screen.pressByTestId('managed-config.create'));
        await waitForHomeGovernance(() => expect(harness.artifacts(serverId).list()).toHaveLength(1));
        const pendingId = harness.artifacts(serverId).list()[0]!.id;
        harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'refused', code } });
        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        await act(async () => publishHomeAccountChange(scopeId));
        await flushHookEffects();
        expect(harness.requestsFor('/v1/machines/presets/get'), 'The mounted preset editor must refresh its read on the same Home wake').toHaveLength(2);
        if (code === 'permission_denied') {
            expect(screen.findByTestId('managed-config.environment.setup.input')).toBeNull();
            expect(screen.findByTestId('managed-config.environment.secret:TOKEN')).toBeNull();
            expect(screen.findByTestId('managed-config.choice:large')).toBeNull();
            expect(screen.findByTestId('managed-config.receipt')).toBeNull();
            expect(screen.findByTestId('managed-config.create')).toBeNull();
        } else {
            expect(screen.findByTestId('managed-config.environment.setup.input')?.props.value).toBe('echo unsaved setup');
            expect(screen.findAllByType(Item).find(node => node.props.testID === 'managed-config.choice:large')?.props.selected).toBe(true);
        }
        harness.answer(serverId, '/v1/machines/presets/update', { body: { kind: 'saved', preset: { ...preset, revision: 4 } } });
        await expect(decideApprovalAsInbox(scopeId, pendingId, 'approve')).resolves.toMatchObject({ ok: true });
        await flushHookEffects();
        expect(route.replace).not.toHaveBeenCalled();
    });
    it.each([true, false])('revalidates saved native sizing only through its current declared same-path selectors (schema available: %s)', async schemaAvailable => {
        const serverId = await seed();
        const scopeId = await seedConfiguration(serverId);
        // Public Cua schemas/options from machine-cua/src/machine/schemas.ts
        // and nativeFacts.ts: runtime, image and reviewed size share launch paths;
        // `on` belongs only to launch, never to the options input.
        const size = { cpu: 2, memoryBytes: 4 * 1024 ** 3, diskBytes: 10 * 1024 ** 3 };
        const selectors = { runtimeId: 'gvisor', imageId: 'ghcr.io/trycua/browser:latest', size };
        const launch = { on: 'local', ...selectors };
        const sizeSchema = { type: 'object', properties: {
            cpu: { type: 'integer', minimum: 1, maximum: 4_294_967_295 },
            memoryBytes: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
            diskBytes: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        }, required: ['cpu', 'memoryBytes', 'diskBytes'], additionalProperties: false };
        const inputSchema = PluginJsonSchemaV2Schema.parse({ type: 'object', properties: {
            runtimeId: { anyOf: ['gvisor', 'runc', 'qemu', 'lume'].map(value => ({ type: 'string', const: value })) },
            imageId: { type: 'string', minLength: 1 }, size: sizeSchema,
        }, additionalProperties: false });
        const cua: MachineProvisionersListResultV1['provisioners'][number] = { ...provisioner,
            contribution: { pluginId: 'happier.machine.cua', localId: 'local-sandbox' }, descriptor: { ...provisioner.descriptor,
                id: 'local-sandbox', title: 'Cua local sandbox', resourceKind: 'cua-local-sandbox',
                launchSchema: { type: 'object', properties: { ...inputSchema.properties, on: { type: 'string', const: 'local' } },
                    required: ['on', 'runtimeId', 'imageId', 'size'], additionalProperties: false },
                billing: { location: 'local', stoppedBilling: 'not-billed' },
                actions: { ...provisioner.descriptor.actions, options: 'sandbox-options' },
            } };
        seedOptionsDeclaration(cua, inputSchema, schemaAvailable);
        const saved = { ...preset, recipe: { ...preset.recipe, provider: cua.contribution, choices: launch } };
        harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: saved } });
        harness.answer(serverId, '/v1/actions/machines.provisioners.list', { select: value => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            return { body: { v: 1, actionId: 'machines.provisioners.list', requestId: request.requestId,
                execution: { ok: true, result: { controller: preset.controller, provisioners: [cua] } } } };
        } });
        let available = true;
        harness.answer(serverId, '/v1/actions/machines.provisioners.options', { select: value => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            expect(request.target).toEqual({ kind: 'machine', machineId: preset.controller.machineId });
            const reviewed = request.input !== null && typeof request.input === 'object' && 'selectors' in request.input
                && pluginJsonValuesEqual(request.input.selectors, selectors);
            return { body: { v: 1, actionId: 'machines.provisioners.options', requestId: request.requestId,
                execution: { ok: true, result: { choices: [{ id: `gvisor:${selectors.imageId}`, title: selectors.imageId,
                    available, ...(available && reviewed ? { launch } : {}), nativeFacts: {
                        ...(reviewed ? { size: { id: '2:4294967296:10737418240', title: '2 CPU', cpuCores: size.cpu,
                            memoryBytes: size.memoryBytes, diskBytes: size.diskBytes } } : {}),
                        image: { id: selectors.imageId, title: selectors.imageId }, location: { id: 'gvisor', title: 'gvisor' },
                    } }] } } } };
        } });
        const screen = await renderSettingsView(<MachinePresetView serverId={scopeId} presetId={preset.id} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('machine-preset.detail')).not.toBeNull());
        if (!schemaAvailable) {
            await waitForHomeGovernance(() => expect(screen.findByTestId('machine-preset.configuration-unavailable')).not.toBeNull());
            expect(harness.requestsFor('/v1/actions/machines.provisioners.options')).toHaveLength(0);
        } else {
            await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/actions/machines.provisioners.options').length).toBeGreaterThan(0));
            const first = ExternalActionRequestEnvelopeV1Schema.parse(harness.requestsFor('/v1/actions/machines.provisioners.options')[0]!.input);
            expect(first.input).toEqual({ homeId: preset.homeId, controller: preset.controller,
                contribution: cua.contribution, selectors });
            await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('2 CPU'));
            expect(screen.getTextContent()).toContain(selectors.imageId);
            expect(screen.findByTestId('machine-preset.configuration-unavailable')).toBeNull();
            // The native owner can invalidate that exact image's disk sizing.
            // Refresh must retain reviewed sizing and disclose unavailability,
            // never choose a replacement or acquire another resource.
            available = false;
            const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
            await act(async () => publishHomeAccountChange(scopeId));
            await waitForHomeGovernance(() => expect(screen.findByTestId('machine-preset.configuration-unavailable')).not.toBeNull());
            expect(screen.getTextContent()).toContain('2 CPU');
            expect(screen.getTextContent()).toContain(selectors.imageId);
        }
        expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toEqual([]);
    });

    it('shows current labelled recipe facts from the saved launch rather than the first available choice', async () => {
        const serverId = await seed();
        const scopeId = await seedConfiguration(serverId);
        const { storage } = await import('@/sync/domains/state/storage');
        const originalController = createMachineFixture({ id: preset.controller.machineId, installationId: preset.controller.installationId,
            metadata: { ...createMachineFixture().metadata!, displayName: 'Original preset controller' } });
        storage.getState().applyMachines([originalController], true, { sourceServerId: scopeId });
        const saved = { ...preset, recipe: { ...preset.recipe, choices: { cpu: 4 }, credentials: [savedCredential] } };
        harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: saved } });
        harness.answer(serverId, '/v1/actions/machines.provisioners.options', { select: value => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            expect(request.target).toEqual({ kind: 'machine', machineId: preset.controller.machineId });
            expect(request.input).toMatchObject({ homeId: preset.homeId, controller: preset.controller });
            return { body: { v: 1, actionId: 'machines.provisioners.options', requestId: request.requestId,
                execution: { ok: true, result: { choices: request.input && typeof request.input === 'object'
                    && 'credentials' in request.input && JSON.stringify(request.input.credentials) === JSON.stringify([savedCredential]) ? [
                    { id: 'other', title: 'Other recipe', launch: { cpu: 8 }, nativeFacts: { size: { id: 'other', title: 'Other size' } } },
                    { id: 'saved', title: 'Saved recipe', launch: { cpu: 4 }, nativeFacts: {
                        size: { id: 'large', title: 'Four cores', cpuCores: 4 }, image: { id: 'linux', title: 'Linux guest' },
                        location: { id: 'west', title: 'West coast' } },
                        prices: [{ amount: '0.012', currency: 'USD', unit: 'hour', source: 'Native quote', observedAt: 10 }] },
                ] : [] } } } };
        } });
        const screen = await renderSettingsView(<MachinePresetView serverId={scopeId} presetId={preset.id} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('machine-preset.detail')).not.toBeNull());
        await flushHookEffects();
        expect(harness.requestsFor('/v1/actions/machines.provisioners.options')).toHaveLength(1);
        for (const actionId of ['machines.provisioners.check', 'machines.provisioners.options']) {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(harness.requestsFor(`/v1/actions/${actionId}`)[0]!.input);
            expect(envelope.input).toMatchObject({ credentials: [savedCredential] });
        }
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Four cores'));
        expect(screen.getTextContent()).toContain('Linux guest');
        expect(screen.getTextContent()).toContain('West coast');
        expect(screen.getTextContent()).toContain('Native quote');
        expect(screen.getTextContent()).not.toContain('Other size');
        expect(screen.findRowByTitle('Original guest')).not.toBeNull();
        expect(screen.tree.findByType(MachineConfigurationReceipt).props.model.facts).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'controller', value: 'Original preset controller' }),
        ]));
        harness.answer(serverId, '/v1/actions/machines.provisioners.options', { select: value => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            return { body: { v: 1, actionId: 'machines.provisioners.options', requestId: request.requestId,
                execution: { ok: true, result: { choices: [{ id: 'other', title: 'Other recipe', launch: { cpu: 8 },
                    nativeFacts: { size: { id: 'other', title: 'Other size' } } }] } } } };
        } });
        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        await act(async () => publishHomeAccountChange(scopeId));
        await waitForHomeGovernance(() => expect(screen.findByTestId('machine-preset.configuration-unavailable')).not.toBeNull());
        expect(screen.getTextContent()).toContain('Four cores');
        expect(screen.getTextContent()).toContain('Native quote');
        expect(screen.getTextContent()).not.toContain('Other size');
        harness.answer(serverId, '/v1/actions/machines.provisioners.options', { status: 503, body: { code: 'unavailable' } });
        const priorReads = harness.requestsFor('/v1/actions/machines.provisioners.options').length;
        await act(async () => screen.pressByTestId('machine-preset.configuration-unavailable-action'));
        await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/actions/machines.provisioners.options')).toHaveLength(priorReads + 1));
        expect(screen.getTextContent()).toContain('Four cores');
        expect(screen.getTextContent()).toContain('Native quote');
        expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toEqual([]);
        // A new installation can reuse a Machine id, but cannot supply the
        // human identity of the preset's retained original controller.
        await act(async () => storage.getState().applyMachines([{ ...originalController, installationId: 'replacement-installation',
            seq: originalController.seq + 1, updatedAt: originalController.updatedAt + 1,
            metadata: { ...originalController.metadata!, displayName: 'Replacement controller computer' } }], true, { sourceServerId: scopeId }));
        await flushHookEffects();
        const receipt = screen.tree.findByType(MachineConfigurationReceipt).props.model;
        expect(receipt.facts).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'controller', value: t('common.unknown') })]));
        // The page says what the preset makes; its sections never repeat their own title, and the edit rule is not the page's purpose.
        const detailModel = screen.tree.findByType(MachinePresetDetail).props.model;
        expect(detailModel.audience.description).not.toBe(t('machinePresets.audience'));
        expect(detailModel.description).not.toBe(t('machinePresets.futureOnly'));
        expect(detailModel.description).not.toBe('');
        expect(JSON.stringify(receipt.facts)).not.toContain('Replacement controller computer');
        expect(receipt.facts.find((fact: { id: string; value: string }) => fact.id === 'controller').value).not.toBe(preset.controller.machineId);
    });

    it('opens New preset through the exact controller picker and saves a recipe without acquiring', async () => {
        const serverId = await seed();
        const scopeId = await seedConfiguration(serverId);
        const picker = await renderSettingsView(<MachineProvisionerPicker serverId={scopeId} presetOnly />);
        // The Home's one controller is preselected, so its catalog is the first frame.
        const providerKey = buildQualifiedPluginContributionKey(preset.recipe.provider);
        const actionId = `managed-picker.provisioners.cloud.${providerKey}.action`;
        const rowId = `managed-picker.provisioners.cloud.${providerKey}`;
        await waitForHomeGovernance(() => expect(picker.findByTestId(actionId) ?? picker.findByTestId(rowId)).not.toBeNull());
        await act(async () => picker.pressByTestId(picker.findByTestId(actionId) ? actionId : rowId));
        const href = String(route.push.mock.calls.at(-1)?.[0]);
        const destination = new URL(href, 'https://happier.example');
        expect(destination.pathname).toBe(`/settings/machines/add/${encodeURIComponent(providerKey)}`);
        expect(Object.fromEntries(destination.searchParams)).toEqual({ serverId: scopeId, presetOnly: 'true',
            machineId: preset.controller.machineId, installationId: preset.controller.installationId });
        await picker.unmount();
        const screen = await renderSettingsView(<ManagedMachineConfigurationView serverId={scopeId} provisioner={providerKey}
            presetOnly initialController={preset.controller} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.choice:large')).not.toBeNull());
        await act(async () => screen.pressByTestId('managed-config.choice:large'));
        expect(screen.findByTestId('managed-config.receipt:keep:choice:deadline')).toBeNull();
        harness.answer(serverId, '/v1/machines/presets/create', { select: input => {
            expect(input).toMatchObject({ homeId: preset.homeId, name: 'Custom compute', owner: preset.owner,
                controller: preset.controller, recipe: { ...preset.recipe, name: 'Custom compute', choices: { cpu: 4 } } });
            const id = input && typeof input === 'object' && 'id' in input ? input.id : null;
            expect(typeof id).toBe('string');
            return { body: { kind: 'saved', preset: { ...preset, id, revision: 1, name: 'Custom compute',
                recipe: { ...preset.recipe, name: 'Custom compute', choices: { cpu: 4 } } } } };
        } });
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(false));
        await act(async () => screen.pressByTestId('managed-config.create'));
        await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/presets/create')).toHaveLength(1));
        const createdInput = harness.requestsFor('/v1/machines/presets/create')[0]?.input;
        if (!createdInput || typeof createdInput !== 'object' || !('id' in createdInput) || typeof createdInput.id !== 'string') {
            throw new Error('Expected the strict preset creation input');
        }
        const createdId = createdInput.id;
        await waitForHomeGovernance(() => expect(route.replace).toHaveBeenLastCalledWith(`/settings/machines/presets/${createdId}?serverId=${encodeURIComponent(scopeId)}`));
        expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toEqual([]);
    });

    it('preserves an edited recipe after rejection and revision conflict, then saves through normal approval', async () => {
        const serverId = await seed();
        const scopeId = await seedConfiguration(serverId);
        await harness.requireUiApproval(serverId, 'machines.presets.update');
        const screen = await renderSettingsView(<ManagedMachineConfigurationView serverId={scopeId}
            provisioner={buildQualifiedPluginContributionKey(preset.recipe.provider)} presetId={preset.id} presetOnly />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.choice:large')).not.toBeNull());
        await act(async () => screen.pressByTestId('managed-config.choice:large'));
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(false));
        await act(async () => screen.pressByTestId('managed-config.create'));
        await waitForHomeGovernance(() => expect(harness.artifacts(serverId).list()).toHaveLength(1));
        expect(harness.requestsFor('/v1/machines/presets/update')).toEqual([]);
        const rejectedId = harness.artifacts(serverId).list()[0]!.id;
        await expect(decideApprovalAsInbox(scopeId, rejectedId, 'reject')).resolves.toMatchObject({ ok: true });
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.error')).not.toBeNull());
        expect(screen.findAllByType(Item).find(node => node.props.testID === 'managed-config.choice:large')?.props.selected).toBe(true);
        expect(route.replace).not.toHaveBeenCalled();
        harness.answer(serverId, '/v1/machines/presets/update', { body: { kind: 'conflict', currentRevision: 4 } });
        await act(async () => screen.pressByTestId('managed-config.create'));
        await waitForHomeGovernance(() => expect(harness.artifacts(serverId).list()).toHaveLength(2));
        const conflictId = harness.artifacts(serverId).list()[1]!.id;
        await expect(decideApprovalAsInbox(scopeId, conflictId, 'approve')).resolves.toMatchObject({ ok: true });
        await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/presets/update')).toHaveLength(1));
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(false));
        expect(screen.findAllByType(Item).find(node => node.props.testID === 'managed-config.choice:large')?.props.selected).toBe(true);
        expect(route.replace).not.toHaveBeenCalled();
        harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: { ...preset, revision: 4 } } });
        await act(async () => screen.pressByTestId('managed-config.error-action'));
        await flushHookEffects();
        expect(harness.requestsFor('/v1/machines/presets/get')).toHaveLength(2);
        expect(screen.findAllByType(Item).find(node => node.props.testID === 'managed-config.choice:large')?.props.selected).toBe(true);
        harness.answer(serverId, '/v1/machines/presets/update', { body: { kind: 'saved', preset: { ...preset, revision: 5,
            recipe: { ...preset.recipe, choices: { cpu: 4 } } } } });
        await act(async () => screen.pressByTestId('managed-config.create'));
        await waitForHomeGovernance(() => expect(harness.artifacts(serverId).list()).toHaveLength(3));
        const savedId = harness.artifacts(serverId).list()[2]!.id;
        await expect(decideApprovalAsInbox(scopeId, savedId, 'approve')).resolves.toMatchObject({ ok: true });
        await waitForHomeGovernance(() => expect(route.replace).toHaveBeenLastCalledWith(`/settings/machines/presets/preset?serverId=${encodeURIComponent(scopeId)}`));
        expect(harness.requestsFor('/v1/machines/presets/update').map(request => request.input)).toEqual([
            expect.objectContaining({ homeId: preset.homeId, id: preset.id, expectedRevision: 3,
                patch: expect.objectContaining({ recipe: { ...preset.recipe, choices: { cpu: 4 } }, controller: preset.controller }) }),
            expect.objectContaining({ homeId: preset.homeId, id: preset.id, expectedRevision: 4,
                patch: expect.objectContaining({ recipe: { ...preset.recipe, choices: { cpu: 4 } } }) }),
        ]);
        expect(harness.requestsFor('/v1/machines/presets/create')).toEqual([]);
        expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toEqual([]);
    });

    it('saves a preset copy with its explicit Keep and wake choices without allocating or editing the original', async () => {
        const serverId = await seed();
        const scopeId = await seedConfiguration(serverId);
        const policy = { retention: { kind: 'unused', afterMs: 7_200_000, effect: 'delete' }, wakeOnAcceptedMessage: false } as const;
        const original = { ...preset, recipe: { ...preset.recipe, credentials: [savedCredential] }, ...policy };
        harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: original } });
        harness.answer(serverId, '/v1/actions/machines.provisioners.list', { select: value => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            return { body: { v: 1, actionId: 'machines.provisioners.list', requestId: request.requestId,
                execution: { ok: true, result: { controller: preset.controller, provisioners: [{ ...provisioner,
                    credentialPurposes: [{ purpose: savedCredential.purpose,
                        options: [{ value: savedCredential.account, label: 'Saved native account' }] }],
                }] } } } };
        } });
        harness.answer(serverId, '/v1/machines/presets/create', { select: input => {
            const id = input && typeof input === 'object' && 'id' in input ? input.id : null;
            return { body: { kind: 'saved', preset: { ...original, id, revision: 1 } } };
        } });
        const screen = await renderSettingsView(<ManagedMachineConfigurationView serverId={scopeId}
            provisioner={buildQualifiedPluginContributionKey(preset.recipe.provider)} presetId={preset.id} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.save-preset')?.props.disabled).toBe(false));
        await act(async () => screen.pressByTestId('managed-config.save-preset'));
        await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/presets/create')).toHaveLength(1));
        const copied = harness.requestsFor('/v1/machines/presets/create')[0]!.input;
        expect(copied).toMatchObject({ homeId: preset.homeId, recipe: original.recipe, controller: preset.controller, ...policy });
        for (const actionId of ['machines.provisioners.check', 'machines.provisioners.options']) {
            const requests = harness.requestsFor(`/v1/actions/${actionId}`);
            expect(requests.length).toBeGreaterThan(0);
            for (const request of requests) expect(ExternalActionRequestEnvelopeV1Schema.parse(request.input).input)
                .toMatchObject({ credentials: [savedCredential] });
        }
        expect(copied).not.toMatchObject({ id: preset.id });
        expect(harness.requestsFor('/v1/machines/presets/update')).toEqual([]);
        expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toEqual([]);
    });

    it('mounts accessible presets in the Machines collection and opens the selected Home', async () => {
        const serverId = await seed();
        await harness.selectHomes([serverId]);
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [preset] } });
        const scopeId = resolveServerProfileScopeIdForIdentifier(serverId);
        const screen = await renderSettingsView(<MachinesSettingsView />);
        await waitForHomeGovernance(() => expect(screen.findByTestId(`settings.machines.preset.${scopeId}.preset`)).not.toBeNull());
        await act(async () => screen.pressByTestId(`settings.machines.preset.${scopeId}.preset`));
        expect(route.push).toHaveBeenLastCalledWith(`/settings/machines/presets/preset?serverId=${encodeURIComponent(scopeId)}`);
        // The group creates a preset from its header "+"; no separate "New preset" row repeats it.
        expect(screen.getTextContent()).not.toContain(t('machinePresets.newPreset'));
        await act(async () => screen.pressByTestId(`settings.machines.presets.new.${scopeId}`));
        expect(route.push).toHaveBeenLastCalledWith(`/settings/machines/presets/new?serverId=${encodeURIComponent(scopeId)}`);
        expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toEqual([]);
    });

    it('opens history and edits the future recipe on the captured Home without acquiring compute', async () => {
        const serverId = await seed();
        const scopeId = resolveServerProfileScopeIdForIdentifier(serverId);
        harness.answer(serverId, '/v1/actions/machines.provisioners.list', { select: value => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            expect(request.target).toEqual({ kind: 'machine', machineId: preset.controller.machineId });
            expect(request.input).toEqual({ homeId: preset.homeId, controller: preset.controller });
            return { body: { v: 1, actionId: 'machines.provisioners.list', requestId: request.requestId,
                execution: { ok: true, result: { controller: preset.controller, provisioners: [provisioner] } } } };
        } });
        const screen = await renderSettingsView(<MachinePresetView serverId={serverId} presetId="preset" />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('machine-preset.detail.machine.resource')).not.toBeNull());
        await waitForHomeGovernance(() => expect(screen.findAll(node => node.props.children === 'Custom compute').length).toBeGreaterThan(0));
        expect(screen.findRowByTitle('Original guest')).not.toBeNull();
        expect(screen.findRowByTitle('Original guest')?.props.subtitle).toContain('1');
        await act(async () => screen.pressByTestId('machine-preset.detail.machine.resource'));
        expect(route.push).toHaveBeenLastCalledWith(`/settings/machines/guest?serverId=${encodeURIComponent(scopeId)}`);
        await act(async () => screen.pressByTestId('machine-preset.edit'));
        const configurationPath = `/settings/machines/add/${encodeURIComponent(buildQualifiedPluginContributionKey(preset.recipe.provider))}?serverId=${encodeURIComponent(scopeId)}&presetId=preset`;
        expect(route.push).toHaveBeenLastCalledWith(`${configurationPath}&presetOnly=true`);
        await act(async () => screen.pressByTestId('machine-preset.detail.createOne'));
        expect(route.push).toHaveBeenLastCalledWith(configurationPath);
        expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toEqual([]);
    });

    it('archives and restores the preset with its reviewed revision without changing its admitted resources', async () => {
        const serverId = await seed();
        const archived = { ...preset, revision: 4, archivedAt: 1 };
        harness.answer(serverId, '/v1/machines/presets/archive', { body: { kind: 'saved', preset: archived } });
        const screen = await renderSettingsView(<MachinePresetView serverId={serverId} presetId="preset" />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('machine-preset.detail.archive')).not.toBeNull());
        harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: archived } });
        await act(async () => screen.pressByTestId('machine-preset.detail.archive'));
        await waitForHomeGovernance(() => expect(screen.findByTestId('machine-preset.detail.restore')).not.toBeNull());
        harness.answer(serverId, '/v1/machines/presets/restore', { body: { kind: 'saved', preset: { ...preset, revision: 5 } } });
        harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: { ...preset, revision: 5 } } });
        await act(async () => screen.pressByTestId('machine-preset.detail.restore'));
        await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/presets/restore')[0]?.input).toEqual({ homeId: 'srv_history', id: 'preset', expectedRevision: 4 }));
        expect(harness.requestsFor('/v1/machines/presets/archive')[0]?.input).toEqual({ homeId: 'srv_history', id: 'preset', expectedRevision: 3 });
        expect(screen.findByTestId('machine-preset.detail.machine.resource')).not.toBeNull();
        expect(harness.requests.filter(request => request.path.includes('/managed/')).every(request => request.path.endsWith('/list'))).toBe(true);
        expect(harness.requests.filter(request => request.path.startsWith('/v1/actions/'))
            .every(request => request.path === '/v1/actions/machines.provisioners.list')).toBe(true);
    });

    it('edits Running at once and Managed from in place through the reviewed preset update Action', async () => {
        const serverId = await seed();
        const scopeId = await seedConfiguration(serverId);
        const { storage } = await import('@/sync/domains/state/storage');
        const builder = createMachineFixture({ id: 'builder', installationId: 'builder-installation',
            metadata: { ...createMachineFixture().metadata!, displayName: 'Builder' } });
        storage.setState({ machineListByServerId: { [scopeId]: [
            createMachineFixture({ id: preset.controller.machineId, installationId: preset.controller.installationId }), builder] } });
        await harness.requireUiApproval(serverId, 'machines.presets.update');
        const screen = await renderSettingsView(<MachinePresetView serverId={serverId} presetId="preset" />);
        const field = (testID: string) => screen.findAllByType(DropdownMenu)
            .find(menu => menu.props.itemTrigger?.itemProps?.testID === testID);
        await waitForHomeGovernance(() => expect(field('machine-preset.detail.limit')?.props.selectedId).toBe('2'));
        expect(field('machine-preset.detail.controller')?.props.selectedId).toBe(preset.controller.machineId);
        expect(field('machine-preset.detail.controller')?.props.items.map((item: { id: string }) => item.id))
            .toEqual(expect.arrayContaining([preset.controller.machineId, 'builder']));

        const limited = { ...preset, revision: 4, simultaneousLimit: { maximum: 3 } };
        harness.answer(serverId, '/v1/machines/presets/update', { body: { kind: 'saved', preset: limited } });
        harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: limited } });
        await act(async () => field('machine-preset.detail.limit')!.props.onSelect('3'));
        // The edit asks first, exactly like the configurator's Save; nothing is written before approval.
        await waitForHomeGovernance(() => expect(harness.artifacts(serverId).list()).toHaveLength(1));
        expect(harness.requestsFor('/v1/machines/presets/update')).toEqual([]);
        await expect(decideApprovalAsInbox(scopeId, harness.artifacts(serverId).list()[0]!.id, 'approve')).resolves.toMatchObject({ ok: true });
        await waitForHomeGovernance(() => expect(field('machine-preset.detail.limit')?.props.selectedId).toBe('3'));

        harness.answer(serverId, '/v1/machines/presets/update', { body: { kind: 'conflict', currentRevision: 5 } });
        await act(async () => field('machine-preset.detail.controller')!.props.onSelect('builder'));
        await waitForHomeGovernance(() => expect(harness.artifacts(serverId).list()).toHaveLength(2));
        await expect(decideApprovalAsInbox(scopeId, harness.artifacts(serverId).list()[1]!.id, 'approve')).resolves.toMatchObject({ ok: true });
        await waitForHomeGovernance(() => expect(screen.findByTestId('machine-preset.mutation-error')).not.toBeNull());
        expect(harness.requestsFor('/v1/machines/presets/update').map(request => request.input)).toEqual([
            { homeId: preset.homeId, id: preset.id, expectedRevision: 3, patch: { simultaneousLimit: { maximum: 3 } } },
            { homeId: preset.homeId, id: preset.id, expectedRevision: 4,
                patch: { controller: { machineId: 'builder', installationId: 'builder-installation' } } },
        ]);
        expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toEqual([]);
    });

    it('marks the provisioner with its package’s contributed brand mark', async () => {
        const serverId = await seed();
        await seedConfiguration(serverId);
        const resource = { pluginId: preset.recipe.provider.pluginId, localId: 'brand-icon' };
        const digest = `sha256:${'c'.repeat(64)}`;
        // The wrapped UI Vitest owner runs at the package root.
        const bytes = readFileSync(join(resolve(process.cwd(), '../..'), 'packages/plugins/machine-hetzner/assets/brand.png'));
        seedOptionsDeclaration(provisioner, PluginJsonSchemaV2Schema.parse({ type: 'object', properties: {}, additionalProperties: false }), true,
            { source: { kind: 'localPath', locator: '/plugins/custom-compute' }, occurrenceId: 'package-occurrence',
                brand: { state: 'available', resource, digest, width: 256, height: 256 } });
        const projected = boundary.rpc.getMockImplementation()!;
        // Daemon Resource transport only: brand admission and rendering stay real.
        boundary.rpc.mockImplementation(async (request: { machineId: string; method: string; payload: unknown }) =>
            request.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ
                ? { ok: true, resource, kind: 'asset', contentType: 'image/png', digest, bytesBase64: bytes.toString('base64') }
                : projected(request));
        const screen = await renderSettingsView(<MachinePresetView serverId={serverId} presetId="preset" />);
        await waitForHomeGovernance(() => expect(screen.findAllByType(InstalledPluginBrandMark)
            .some(node => node.props.brand.bytes?.byteLength === bytes.byteLength)).toBe(true));
    });

    it('withdraws recipe and history after the credential lifetime retires', async () => {
        const serverId = await seed();
        const screen = await renderSettingsView(<MachinePresetView serverId={serverId} presetId="preset" />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('machine-preset.detail.machine.resource')).not.toBeNull());
        harness.answer(serverId, '/v1/machines/presets/get', { status: 403, body: { kind: 'refused', code: 'permission_denied' } });
        await act(async () => { await harness.switchAccount(serverId, 'other-owner'); });
        await waitForHomeGovernance(() => expect(screen.findByTestId('machine-preset.detail.machine.resource')).toBeNull());
        expect(screen.findByTestId('machine-preset.edit')).toBeNull();
    });

    it('uses the Team capability projection for management even when the viewer role says owner', async () => {
        const serverId = await seed();
        const teamPreset = { ...preset, owner: { kind: 'team', teamId: 'team-1' } } as const;
        harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: teamPreset } });
        const { bindHomeDomainActionHttpRequestV1 } = await import('@happier-dev/protocol/actions/homeDomainActionFamily');
        const request = bindHomeDomainActionHttpRequestV1('teams.get', { v: 1, teamId: 'team-1' });
        harness.answer(serverId, request.path, { body: teamSummaryFixture({ name: 'Platform', viewerRole: 'owner',
            capabilities: teamCapabilitiesFixture({ manageSettings: false }) }) });
        const screen = await renderSettingsView(<MachinePresetView serverId={serverId} presetId="preset" />);
        await waitForHomeGovernance(() => expect(screen.findRowByTitle('Platform')).not.toBeNull());
        expect(screen.findByTestId('machine-preset.edit')).toBeNull();
        expect(screen.findByTestId('machine-preset.detail.archive')).toBeNull();
        expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toEqual([]);
    });
});
