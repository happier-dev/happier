import type { MachineProvisionerOptionsResultV1, MachineProvisionerContributionV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { ManagedMachinePresetV1Schema, type ManagedMachinePresetV1, type ManagedMachinePresetUpdateInputV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { ManagedMachinePresetContentV1Schema, sealManagedMachinePresetContentV1,
    type ManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { buildManagedConfigurationFactsV1, type ManagedConfigurationFactsV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { ManagedControllerAccessV1Schema, type ManagedControllerAccessV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { createPluginJsonSchemaZodValueAdapter } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { createMachineFixture } from './machineFixtures';
import { PluginPortableReleaseManifestV1Schema, PluginAccountAvailabilityIntentReadResponseV1Schema,
    readDeclaredPackageAssetsV1, type PluginPortableReleaseManifestV1 } from '@happier-dev/protocol/plugins/availability';
import type { PluginActionInputHintsV2 } from '@happier-dev/protocol/plugins/actions/v2';
import { rehydrateCanonicalProtocolComposableSchema } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { defineMachineProvisionerSchemas, MachineProvisionerCheckResultProtocolV1Schema,
    MachineProvisionerOptionsResultProtocolV1Schema, MachineProvisionerBootstrapCarrierV1Schema,
    MachineProvisionerObservationV1Schema, MachineProvisionerPowerResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';

/** Account preset editors consume portable declarations, not a controller's live catalog. */
export function createMachineProvisionerEditorManifestFixture(input: Readonly<{
    pluginId: string; descriptor: MachineProvisionerContributionV1; optionsInputHints?: PluginActionInputHintsV2;
}>) {
    const { descriptor } = input;
    const launch = rehydrateCanonicalProtocolComposableSchema(descriptor.launchSchema);
    const resource = rehydrateCanonicalProtocolComposableSchema(descriptor.resourceSchema);
    if (!launch || !resource) throw new Error('The editor fixture requires canonical launch and resource declarations');
    const roles = defineMachineProvisionerSchemas({ launch, resource });
    const contracts: (readonly [string, object, object])[] = [
        [descriptor.actions.check, roles.checkInput.jsonSchema, MachineProvisionerCheckResultProtocolV1Schema.jsonSchema],
        [descriptor.actions.acquire, roles.acquireInput.jsonSchema, roles.acquireResult.jsonSchema],
        [descriptor.actions.bootstrap, roles.bootstrapInput.jsonSchema, MachineProvisionerBootstrapCarrierV1Schema.jsonSchema],
        [descriptor.actions.inspect, roles.resourceInput.jsonSchema, MachineProvisionerObservationV1Schema.jsonSchema],
        [descriptor.actions.destroy, roles.resourceInput.jsonSchema, MachineProvisionerPowerResultV1Schema.jsonSchema],
    ];
    if (descriptor.actions.options) contracts.push([descriptor.actions.options, descriptor.launchSchema,
        MachineProvisionerOptionsResultProtocolV1Schema.jsonSchema]);
    if (descriptor.actions.power) contracts.push([descriptor.actions.power, roles.powerInput.jsonSchema,
        MachineProvisionerPowerResultV1Schema.jsonSchema]);
    return PluginPortableReleaseManifestV1Schema.parse({ schemaVersion: 2, id: input.pluginId,
        version: '1.0.0', displayName: descriptor.title, runtime: { apiVersion: 1 }, entrypoints: { daemon: './dist/index.js' },
        hostAccess: { required: [], optional: [] }, contributes: { machineProvisioners: [descriptor],
            actions: contracts.map(([id, inputSchema, resultSchema]) => ({ id, title: id,
                scopes: ['machine'], surfaces: ['cli', 'plugin'], execution: { target: 'daemon' }, dangerLevel: 'safe', inputSchema, resultSchema,
                ...(id === descriptor.actions.options && input.optionsInputHints ? { inputHints: input.optionsInputHints } : {}) })) } });
}

/** The admitted portable release supplies editor declarations without contacting a controller. */
export function createEnabledMachinePluginIntentReadFixture(manifest: PluginPortableReleaseManifestV1) {
    return PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
        availabilityCursor: 1,
        hostingCapability: { enabled: true, maxArtifactBytes: 1024, maxAccountBytes: 2048 },
        intent: { pluginId: manifest.id, desiredVersion: manifest.version, enabled: true, offlineUiHosting: 'enabled', writableCollections: [], revision: 'fixture-1' },
        release: { ref: { pluginId: manifest.id, version: manifest.version }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`, normalizedManifest: manifest,
            collectionContracts: [], uiSlots: [], packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`,
                resources: (readDeclaredPackageAssetsV1(manifest) ?? []).map(resource => ({ ...resource, byteSize: 1, digestSha256: `sha256:${'c'.repeat(64)}` })) } },
        packageAssets: [], uiArtifacts: [],
    });
}

/** HTTP fixture response: update nulls clear stored fields; they are never persisted values. */
export function applyManagedMachinePresetUpdateFixture(preset: ManagedMachinePresetV1, input: ManagedMachinePresetUpdateInputV1) {
    const next = { ...preset, revision: input.expectedRevision + 1 };
    for (const [key, value] of Object.entries(input.patch)) {
        if (value === null || key === 'teamAcquireDelegated' && value === false) Reflect.deleteProperty(next, key);
        else Reflect.set(next, key, value);
    }
    return ManagedMachinePresetV1Schema.parse(next);
}

/** Current controllers publish the protocol required by every provisioner Action. */
export function createManagedControllerMachineFixture(overrides: Parameters<typeof createMachineFixture>[0] = {}) {
    return createMachineFixture({ operationProtocolCapabilitiesRevision: 1,
        operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } }, ...overrides });
}

/** Native options fixtures use the public independent-dimension contract. */
export function createMachineProvisionerOptionsFixture(overrides: Partial<MachineProvisionerOptionsResultV1> = {}): MachineProvisionerOptionsResultV1 {
    return { dimensions: { size: [], image: [], location: [], network: [], duration: [] }, ...overrides };
}

/** Synthetic CPU-only provider used by mounted Action/currentness tests. */
export function createManagedCpuOptionsFixture(sizes: readonly Readonly<{
    id: string; title: string; cpu?: number;
    prices?: MachineProvisionerOptionsResultV1['dimensions']['size'][number]['prices'];
}>[]): MachineProvisionerOptionsResultV1 {
    return createMachineProvisionerOptionsFixture({ base: { launch: {} }, dimensions: {
        size: sizes.map(({ cpu, ...size }) => ({ ...size,
            nativeFacts: { size: { id: size.id, title: size.title, ...(cpu === undefined ? {} : { cpuCores: cpu }) } },
            assignments: cpu === undefined ? [] : [{ path: 'cpu', value: cpu }] })),
        image: [], location: [], network: [], duration: [],
    } });
}

/** One explicit Plain stored row with a local opened view for content-facing test callers. */
export function createPlainManagedMachinePresetFixture(input: Readonly<{
    id: string; homeId: string; revision: number; name: string; owner: ManagedMachinePresetV1['owner'];
    launch?: ManagedMachinePresetContentV1['launch']; setup?: ManagedMachinePresetContentV1['setup'];
    controller?: ManagedMachinePresetV1['controller']; controllerPoolId?: ManagedMachinePresetV1['controllerPoolId'];
    retention?: ManagedMachinePresetV1['retention']; wakeOnAcceptedMessage?: boolean; archivedAt?: number;
    controllerDisplayName?: ManagedMachinePresetContentV1['controllerDisplayName'];
    teamAcquireDelegated?: ManagedMachinePresetV1['teamAcquireDelegated']; simultaneousLimit?: ManagedMachinePresetV1['simultaneousLimit'];
}>) {
    const { name, launch, setup, controllerDisplayName, ...structural } = input;
    const content = ManagedMachinePresetContentV1Schema.parse({ v: 1, name,
        ...(launch ? { launch } : {}), ...(setup ? { setup } : {}),
        ...(controllerDisplayName === undefined ? {} : { controllerDisplayName }) });
    const sealed = sealManagedMachinePresetContentV1({ presetId: input.id, mode: 'plain', content });
    const wire = ManagedMachinePresetV1Schema.parse({ ...structural,
        contentEncryptionMode: 'plain', content: sealed.content, recipients: sealed.recipients });
    const { content: _content, recipients: _recipients, ...metadata } = wire;
    const opened = { ...metadata, ...content, recipientProjection: { content: sealed.content, recipientEnvelope: null } };
    return Object.defineProperty(wire, 'opened', { enumerable: false, value: opened }) as typeof wire & Readonly<{ opened: typeof opened }>;
}

type DelegatedManagedPresetDraftV1 = Readonly<{
    id: string;
    homeId: string;
    revision: number;
    name: string;
    owner: ManagedMachinePresetV1['owner'];
    controller?: ManagedMachinePresetV1['controller'];
    controllerPoolId?: ManagedMachinePresetV1['controllerPoolId'];
    retention?: ManagedMachinePresetV1['retention'];
    wakeOnAcceptedMessage?: boolean;
    simultaneousLimit?: ManagedMachinePresetV1['simultaneousLimit'];
    archivedAt?: number;
    launch: NonNullable<ManagedMachinePresetContentV1['launch']>;
    setup?: ManagedMachinePresetContentV1['setup'];
    controllerDisplayName?: ManagedMachinePresetContentV1['controllerDisplayName'];
}>;

/**
 * Test-only local opening paired with an opaque public Preset. The sidecar is
 * deliberately non-enumerable so fixture HTTP responses retain only the
 * structural carrier that a Home can see.
 */
export type DelegatedManagedPresetFixtureV1 = ManagedMachinePresetV1 & Readonly<{
    opened: Readonly<{
        content: ManagedMachinePresetContentV1;
        launch: NonNullable<ManagedMachinePresetContentV1['launch']>;
        controllerAccess: ManagedControllerAccessV1;
        provisioner: MachineProvisionerContributionV1;
        reviewedFacts: ManagedConfigurationFactsV1;
    }>;
}>;

/** Mirrors the opaque preset producer while retaining its test-local opened snapshot. */
export function createDelegatedManagedPresetFixture(input: Readonly<{
    preset: DelegatedManagedPresetDraftV1;
    descriptor: MachineProvisionerContributionV1;
    installationPublicKey: string;
    custodianAccountId: string;
}>): DelegatedManagedPresetFixtureV1 {
    const content = ManagedMachinePresetContentV1Schema.parse({
        v: 1,
        name: input.preset.name,
        launch: input.preset.launch,
        ...(input.preset.setup === undefined ? {} : { setup: input.preset.setup }),
        ...(input.preset.controllerDisplayName === undefined ? {} : { controllerDisplayName: input.preset.controllerDisplayName }),
    });
    const reviewedFacts = buildManagedConfigurationFactsV1({
        choicesSchema: createPluginJsonSchemaZodValueAdapter(input.descriptor.launchSchema),
        launch: input.preset.launch,
        ...(input.preset.controller === undefined ? {} : { controller: input.preset.controller }),
        optionStatus: 'current', prerequisites: [],
        billing: input.descriptor.billing, retentionCapabilities: input.descriptor.retention,
        preset: { id: input.preset.id, revision: input.preset.revision, name: input.preset.name,
            ...(input.preset.retention === undefined ? {} : { retention: input.preset.retention }),
            ...(input.preset.wakeOnAcceptedMessage === undefined ? {} : { wakeOnAcceptedMessage: input.preset.wakeOnAcceptedMessage }) },
        ...(input.preset.setup === undefined ? {} : { setup: input.preset.setup }),
    });
    const envelope = sealManagedMachinePresetContentV1({ presetId: input.preset.id, mode: 'plain', content });
    const controllerAccess = ManagedControllerAccessV1Schema.parse({
        installationPublicKey: input.installationPublicKey,
        custodian: { accountId: input.custodianAccountId },
    });
    const preset = ManagedMachinePresetV1Schema.parse({
        id: input.preset.id,
        homeId: input.preset.homeId,
        revision: input.preset.revision,
        owner: input.preset.owner,
        contentEncryptionMode: 'plain',
        content: envelope.content,
        recipients: envelope.recipients,
        ...(input.preset.controller === undefined ? {} : { controller: input.preset.controller }),
        ...(input.preset.controllerPoolId === undefined ? {} : { controllerPoolId: input.preset.controllerPoolId }),
        retention: reviewedFacts.retention,
        wakeOnAcceptedMessage: reviewedFacts.wakeOnAcceptedMessage,
        teamAcquireDelegated: true,
        ...(input.preset.simultaneousLimit === undefined ? {} : { simultaneousLimit: input.preset.simultaneousLimit }),
        ...(input.preset.archivedAt === undefined ? {} : { archivedAt: input.preset.archivedAt }),
    });
    const fixture = Object.defineProperty(preset, 'opened', {
        enumerable: false,
        value: Object.freeze({ content, launch: input.preset.launch, controllerAccess,
            provisioner: input.descriptor, reviewedFacts }),
    }) as DelegatedManagedPresetFixtureV1;
    return Object.freeze(fixture);
}
