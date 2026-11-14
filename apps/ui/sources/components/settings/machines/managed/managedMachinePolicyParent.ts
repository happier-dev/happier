import { projectRetainedManagedCredentialSelectionsV1, type ManagedMachineV1, type ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { BillingCapabilitiesV1, RetentionCapabilitiesV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import type { DevcontainerEffectReviewV1 } from '@happier-dev/protocol/machines/managed/devcontainerV1';
import type { MachineRetentionPolicyV1 } from '@happier-dev/protocol/account/settings/machineRetentionDefaultsV1';
import { resolveMachineRetentionPolicyV1 } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { createPluginJsonSchemaZodValueAdapter } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { PluginJsonValueV2Schema } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import type { PluginJsonValueV2 } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { settingsParse } from '@/sync/domains/settings/settings';
import { createManagedProvisionerClient } from './managedProvisionerClient';
import { readManagedConfiguration } from './readManagedConfiguration';
import { refreshManagedProvisionerAvailability } from './managedProvisionerAvailability';
import { createMachinePresetCollectionClient } from './machinePresetCollectionClient';
import type { MachinePresetCollectionSettledResult } from './machinePresetCollectionClient';
import { readManagedProvisionerOptionsInput } from './useManagedProvisionerOptionsInput';
import { createManagedConfiguratorDraft, refreshManagedConfiguratorOptions, managedConfiguratorFacts,
    managedConfiguratorCapabilities, managedConfiguratorProjection, type ManagedConfiguratorDraft } from './managedConfiguratorModel';

export type ManagedMachinePolicyParent = Readonly<{
    policy: MachineRetentionPolicyV1;
    billing: BillingCapabilitiesV1;
    capabilities: RetentionCapabilitiesV1;
    providerTitle: string;
}>;

type ManagedMachineNativeReadInput = Readonly<{
    machine: ManagedMachineV1;
    controller?: ManagedControllerV1;
    binding: ServerCredentialAccountScopeBinding;
    signal: AbortSignal;
    onApprovalPending: (approval: ActionApprovalRegistration) => void;
}>;

/** Current native options have one Home/controller/schema-qualified reader for Reset and Rebuild. */
async function readManagedMachineNativeReview(input: ManagedMachineNativeReadInput): Promise<Readonly<{
    kind: 'ready'; provisioner: ManagedConfiguratorDraft['provisioner']; selected: ManagedConfiguratorDraft['selected'];
    effectReview?: DevcontainerEffectReviewV1;
}> | Readonly<{ kind: 'failed'; code: string }>> {
    const { machine, binding, signal } = input;
    const controller = input.controller ?? machine.controller;
    const current = () => !signal.aborted && binding.isCurrent();
    if (!current()) return { kind: 'failed', code: 'action_account_scope_changed' };
    const options = { signal, onApprovalPending: input.onApprovalPending };
    const client = createManagedProvisionerClient(binding.scope, machine.homeId);
    const catalog = await client.read('machines.provisioners.list', { homeId: machine.homeId, controller,
        contribution: machine.launch.provider }, options);
    if (!current()) return { kind: 'failed', code: 'action_account_scope_changed' };
    if (catalog.kind === 'failed') return catalog;
    const provisioner = catalog.value.provisioners.find(row => sameStrictJsonValue(row.contribution, machine.launch.provider)
        && row.descriptor.schemaVersion === machine.launch.schemaVersion);
    if (!provisioner) return { kind: 'failed', code: 'managed_parent_unavailable' };
    const nativeInput = { homeId: machine.homeId, controller, contribution: machine.launch.provider,
        ...(machine.launch.credentials ? { credentials: projectRetainedManagedCredentialSelectionsV1(machine.launch.credentials) } : {}) };
    let selected: ManagedConfiguratorDraft['selected'] = null;
    let effectReview: DevcontainerEffectReviewV1 | undefined;
    const optionsAction = provisioner.descriptor.actions.options;
    const retainedQuery: { schema?: ReturnType<typeof createPluginJsonSchemaZodValueAdapter>; selectors?: PluginJsonValueV2 } = {};
    const readSelectors = optionsAction ? async (signal: AbortSignal): Promise<MachinePresetCollectionSettledResult<PluginJsonValueV2>> => {
        const schemas = await readManagedProvisionerOptionsInput({ binding, controller, provisioner, signal });
        if (!current()) return { kind: 'failed', code: 'action_account_scope_changed' };
        if (schemas.kind !== 'ready') return { kind: 'failed', code: schemas.kind === 'unavailable' && schemas.error !== 'option_unavailable'
            ? schemas.error : 'managed_parent_unavailable' };
        // The same current options input projection used for a saved launch: query fields only.
        // Reset's selected variant must still equal the complete retained launch.
        const querySchema = createStoredReadSchema(createPluginJsonSchemaZodValueAdapter(schemas.schema));
        const parsed = querySchema.safeParse(machine.launch.choices);
        if (!parsed.success) return { kind: 'failed', code: 'managed_parent_unavailable' };
        const selectors = PluginJsonValueV2Schema.parse(parsed.data);
        retainedQuery.schema = querySchema;
        retainedQuery.selectors = selectors;
        return { kind: 'succeeded', value: selectors } as const;
    } : undefined;
    refreshManagedProvisionerAvailability(binding, nativeInput);
    const native = await readManagedConfiguration({ binding, client, nativeInput, occurrenceId: provisioner.occurrenceId,
        provisioner: provisioner.descriptor,
        ...(readSelectors ? { selectors: readSelectors, optionsAfterAvailableCheck: true } : {}),
        signal, onApprovalPending: input.onApprovalPending });
    if (native.kind === 'retired') return { kind: 'failed', code: 'action_account_scope_changed' };
    if (native.failure) return { kind: 'failed', code: native.failure.code };
    if (!native.check?.available) return { kind: 'failed', code: 'managed_parent_unavailable' };
    const { schema: querySchema, selectors } = retainedQuery;
    if (querySchema && native.options) {
        const draft = refreshManagedConfiguratorOptions({ ...createManagedConfiguratorDraft({ provisioner, controller,
            name: machine.launch.name }), selected: { id: 'retained', title: machine.launch.name, launch: machine.launch.choices } }, native.options);
        selected = managedConfiguratorFacts(draft)?.optionStatus === 'current' ? draft.selected : null;
        // Rebuild reviews the current native effect at the retained query; Reset
        // continues to require exactly the retained executable launch.
        const projection = managedConfiguratorProjection(draft);
        if (projection?.kind === 'ready' && projection.effectReview) {
            const projected = querySchema.safeParse(projection.launch);
            if (projected.success && pluginJsonValuesEqual(projected.data, selectors)) effectReview = projection.effectReview;
        }
    }
    return { kind: 'ready', provisioner, selected, ...(effectReview ? { effectReview } : {}) };
}

export async function readManagedMachineRebuildReview(input: ManagedMachineNativeReadInput): Promise<Readonly<{
    kind: 'ready'; review: DevcontainerEffectReviewV1;
}> | Readonly<{ kind: 'failed'; code: string }>> {
    const native = await readManagedMachineNativeReview(input);
    if (native.kind === 'failed') return native;
    if (!native.provisioner.descriptor.retention.supportedIntents.includes('rebuild')
        || !native.provisioner.descriptor.actions.rebuild || !native.effectReview) {
        return { kind: 'failed', code: 'managed_parent_unavailable' };
    }
    return { kind: 'ready', review: native.effectReview };
}

/** Reset reads today's parent; the creation receipt is deliberately not an input to policy resolution. */
export async function readManagedMachinePolicyParent(input: ManagedMachineNativeReadInput): Promise<Readonly<{
    kind: 'ready'; parent: ManagedMachinePolicyParent;
}> | Readonly<{ kind: 'failed'; code: string }>> {
    const { machine, binding, signal } = input;
    const current = () => !signal.aborted && binding.isCurrent();
    const options = { signal, onApprovalPending: input.onApprovalPending };
    const native = await readManagedMachineNativeReview(input);
    if (native.kind === 'failed') return native;
    const { provisioner, selected } = native;
    if (provisioner.descriptor.actions.options && !selected) return { kind: 'failed', code: 'managed_parent_unavailable' };
    const { billing, retention: capabilities } = managedConfiguratorCapabilities({ provisioner, selected });
    const preset = machine.preset ? await createMachinePresetCollectionClient(binding.scope, machine.homeId)
        .read('machines.presets.get', { homeId: machine.homeId, id: machine.preset.id }, options) : null;
    if (!current()) return { kind: 'failed', code: 'action_account_scope_changed' };
    if (preset?.kind === 'failed') return preset;
    if (preset?.kind === 'succeeded' && preset.value.kind === 'refused') return { kind: 'failed', code: preset.value.code };
    const account = await captureLazyActionAccountContext(binding.serverId, signal);
    try {
        if (account.accountId !== binding.accountId) return { kind: 'failed', code: 'action_account_scope_changed' };
        // readSettings may be cached. Reset's approved contract requires the actual current Account parent.
        const settings = settingsParse(await account.readRawSettings());
        account.assertCurrent();
        if (!current()) return { kind: 'failed', code: 'action_account_scope_changed' };
        const currentPreset = preset?.kind === 'succeeded' && preset.value.kind === 'found' ? preset.value.preset : null;
        const descriptor = provisioner.descriptor;
        const policy = resolveMachineRetentionPolicyV1({ billing, nativeCapabilities: capabilities,
            categoryPreferences: settings.machineRetentionDefaultsV1,
            ...(currentPreset ? { presetOverride: { retention: currentPreset.retention,
                wakeOnAcceptedMessage: currentPreset.wakeOnAcceptedMessage } } : {}) });
        // The parent is the policy itself; its resolution record (category, sources) would never equal a machine's rule.
        return { kind: 'ready', parent: { policy: { retention: policy.retention, wakeOnAcceptedMessage: policy.wakeOnAcceptedMessage },
            billing, capabilities,
            providerTitle: typeof descriptor.title === 'string' ? descriptor.title : descriptor.title.fallback } };
    } finally { account.dispose(); }
}
