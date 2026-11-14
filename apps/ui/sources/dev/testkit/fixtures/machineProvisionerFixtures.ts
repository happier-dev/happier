import type { MachineProvisionerOptionsResultV1, MachineProvisionerContributionV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { ManagedMachinePresetV1Schema, type ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { ManagedMachinePresetContentV1Schema, sealManagedMachinePresetContentV1,
    type ManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { buildManagedConfigurationFactsV1, type ManagedConfigurationFactsV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { ManagedControllerAccessV1Schema, type ManagedControllerAccessV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { createPluginJsonSchemaZodValueAdapter } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { createMachineFixture } from './machineFixtures';

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
}>) {
    const { name, launch, setup, ...structural } = input;
    const content = ManagedMachinePresetContentV1Schema.parse({ v: 1, name,
        ...(launch ? { launch } : {}), ...(setup ? { setup } : {}) });
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
