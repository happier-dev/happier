import type { MachineProvisionerOptionsResultV1, MachineProvisionerContributionV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { hasManagedMachinePresetCreationV1, ManagedMachinePresetV1Schema, type ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { buildManagedConfigurationFactsV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
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
        size: sizes.map(({ cpu, ...size }) => ({ ...size, assignments: cpu === undefined ? [] : [{ path: 'cpu', value: cpu }] })),
        image: [], location: [], network: [], duration: [],
    } });
}

/** Mirrors the public preset producer through its real facts builder and strict read schema. */
export function createDelegatedManagedPresetFixture(input: Readonly<{
    preset: ManagedMachinePresetV1; descriptor: MachineProvisionerContributionV1;
    installationPublicKey: string; custodianAccountId: string;
}>): ManagedMachinePresetV1 {
    if (!hasManagedMachinePresetCreationV1(input.preset)) throw new Error('Delegated Preset fixture requires creation.');
    const { credentials: _credentials, ...launch } = input.preset.launch;
    return ManagedMachinePresetV1Schema.parse({ ...input.preset, launch, teamAcquireDelegated: true, delegatedAcquire: {
        kind: 'ready', controller: { installationPublicKey: input.installationPublicKey, custodian: { accountId: input.custodianAccountId } },
        provisioner: input.descriptor, reviewedFacts: buildManagedConfigurationFactsV1({
            choicesSchema: createPluginJsonSchemaZodValueAdapter(input.descriptor.launchSchema), launch,
            controller: input.preset.controller, optionStatus: 'current', prerequisites: [],
            billing: input.descriptor.billing, retentionCapabilities: input.descriptor.retention,
            preset: { id: input.preset.id, revision: input.preset.revision, name: input.preset.name,
                retention: input.preset.retention, wakeOnAcceptedMessage: input.preset.wakeOnAcceptedMessage }, setup: input.preset.setup,
        }),
    } });
}
