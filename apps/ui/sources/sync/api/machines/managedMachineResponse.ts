import * as z from 'zod/mini';
import { ManagedMachineActionOutputSchemasV1, type ManagedMachineActionIdV1,
    type ManagedMachineActionOutputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MachineProvisionerOptionsResultV1Schema, type MachineProvisionerOptionsResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { ProviderPriceV1Schema, ProviderNativeOptionFactsV1Schema, RetentionCapabilitiesV1Schema,
    MachineProvisionerNativeCauseV1Schema } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { DevcontainerEffectReviewV1Schema } from '@happier-dev/protocol/machines/managed/devcontainerV1';
import { PluginJsonValueV2Schema } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import { PluginLocalizedStringV2Schema } from '@happier-dev/protocol/plugins/contributions/public-types';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';

// CD31 development-controller transition. This is a read adapter, never a writer
// or a second selection owner. Removal condition:
// remove once every QA/dev daemon runs a bundle with CD31 producers
// Removal requires the orchestrator's reload confirmation.
const text = () => z.string().check(z.trim(), z.minLength(1));
const legacyOptionsSchema = z.strictObject({
    code: z.optional(z.literal('provider_unavailable')),
    nativeCause: z.optional(MachineProvisionerNativeCauseV1Schema),
    choices: z.array(z.strictObject({ id: text(), title: PluginLocalizedStringV2Schema,
        launch: z.optional(PluginJsonValueV2Schema), available: z.optional(z.boolean()),
        prices: z.optional(z.array(ProviderPriceV1Schema)), retention: z.optional(RetentionCapabilitiesV1Schema),
        nativeFacts: z.optional(ProviderNativeOptionFactsV1Schema), effectReview: z.optional(DevcontainerEffectReviewV1Schema),
    })),
});

function readLegacyOptions(value: unknown): MachineProvisionerOptionsResultV1 | null {
    const parsed = legacyOptionsSchema.safeParse(value);
    if (!parsed.success) return null;
    const { choices, ...facts } = parsed.data;
    const executable = choices.filter(choice => choice.launch !== undefined);
    const first = executable[0];
    const sharedBase = first && executable.every(choice => pluginJsonValuesEqual(choice.launch, first.launch)
        && (choice.effectReview === undefined && first.effectReview === undefined
            || pluginJsonValuesEqual(choice.effectReview, first.effectReview)));
    // The current ABI cannot express distinct scalar roots or per-choice effect
    // reviews. First-party legacy catalogs use object launches and a sole reviewed
    // Devcontainer base. Refuse unrepresentable catalogs instead of guessing.
    if (!sharedBase && executable.some(choice => choice.effectReview !== undefined
        || choice.launch === null || typeof choice.launch !== 'object' || Array.isArray(choice.launch)
        || Object.keys(choice.launch).some(key => key.trim() !== key || key.includes('.')))) return null;
    const result: MachineProvisionerOptionsResultV1 = {
        ...facts,
        ...(first ? { base: { launch: sharedBase ? first.launch! : {},
            ...(sharedBase && first.effectReview ? { effectReview: first.effectReview } : {}) } } : {}),
        dimensions: { size: choices.map(({ launch, effectReview: _review, ...choice }) => ({
            ...choice, ...(launch === undefined ? { available: false } : {}),
            assignments: sharedBase || launch === null || typeof launch !== 'object' || Array.isArray(launch)
                ? [] : Object.entries(launch).map(([path, value]) => ({ path, value })),
        })), image: [], location: [], network: [], duration: [] },
    };
    const current = MachineProvisionerOptionsResultV1Schema.safeParse(result);
    return current.success ? current.data : null;
}

/** One response reader for immediate native results and approval continuations. */
export function readManagedMachineActionOutputV1<T extends ManagedMachineActionIdV1>(actionId: T, value: unknown):
    Readonly<{ success: true; data: ManagedMachineActionOutputV1<T> }> | Readonly<{ success: false }> {
    const schema = ManagedMachineActionOutputSchemasV1[actionId];
    const current = schema.safeParse(value);
    if (current.success) return { success: true, data: current.data as ManagedMachineActionOutputV1<T> };
    if (actionId !== 'machines.provisioners.options') return { success: false };
    const legacy = readLegacyOptions(value);
    if (!legacy) return { success: false };
    // The action id and its exact indexed schema establish this generic result.
    return { success: true, data: legacy as ManagedMachineActionOutputV1<T> };
}
