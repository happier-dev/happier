import type { ManagedMachineV1, ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { BillingCapabilitiesV1, RetentionCapabilitiesV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import type { MachineRetentionPolicyV1 } from '@happier-dev/protocol/account/settings/machineRetentionDefaultsV1';
import { resolveMachineRetentionPolicyV1 } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { settingsParse } from '@/sync/domains/settings/settings';
import { createManagedProvisionerClient } from './managedProvisionerClient';
import { createMachinePresetCollectionClient } from './machinePresetCollectionClient';

export type ManagedMachinePolicyParent = Readonly<{
    policy: MachineRetentionPolicyV1;
    billing: BillingCapabilitiesV1;
    capabilities: RetentionCapabilitiesV1;
    providerTitle: string;
}>;

/** Reset reads today's parent; the creation receipt is deliberately not an input to policy resolution. */
export async function readManagedMachinePolicyParent(input: Readonly<{
    machine: ManagedMachineV1;
    controller?: ManagedControllerV1;
    binding: ServerCredentialAccountScopeBinding;
    signal: AbortSignal;
    onApprovalPending: (approval: ActionApprovalRegistration) => void;
}>): Promise<Readonly<{ kind: 'ready'; parent: ManagedMachinePolicyParent }> | Readonly<{ kind: 'failed'; code: string }>> {
    const { machine, binding, signal } = input;
    const controller = input.controller ?? machine.controller;
    const current = () => !signal.aborted && binding.isCurrent();
    if (!current()) return { kind: 'failed', code: 'action_account_scope_changed' };
    const options = { signal, onApprovalPending: input.onApprovalPending };
    const client = createManagedProvisionerClient(binding.scope, machine.homeId);
    const catalog = await client.read('machines.provisioners.list', { homeId: machine.homeId, controller }, options);
    if (!current()) return { kind: 'failed', code: 'action_account_scope_changed' };
    if (catalog.kind === 'failed') return catalog;
    const provisioner = catalog.value.provisioners.find(row => sameStrictJsonValue(row.contribution, machine.launch.provider)
        && row.descriptor.schemaVersion === machine.launch.schemaVersion);
    if (!provisioner) return { kind: 'failed', code: 'managed_parent_unavailable' };
    const checked = await client.read('machines.provisioners.check', { homeId: machine.homeId, controller,
        contribution: machine.launch.provider, ...(machine.launch.credentials ? { credentials: machine.launch.credentials.map(({ configurationRevision: _basis, ...credential }) => credential) } : {}) }, options);
    if (!current()) return { kind: 'failed', code: 'action_account_scope_changed' };
    if (checked.kind === 'failed') return checked;
    if (!checked.value.available) return { kind: 'failed', code: 'managed_parent_unavailable' };
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
        const policy = resolveMachineRetentionPolicyV1({ billing: descriptor.billing, nativeCapabilities: descriptor.retention,
            categoryPreferences: settings.machineRetentionDefaultsV1,
            ...(currentPreset ? { presetOverride: { retention: currentPreset.retention,
                wakeOnAcceptedMessage: currentPreset.wakeOnAcceptedMessage } } : {}) });
        return { kind: 'ready', parent: { policy, billing: descriptor.billing, capabilities: descriptor.retention,
            providerTitle: typeof descriptor.title === 'string' ? descriptor.title : descriptor.title.fallback } };
    } finally { account.dispose(); }
}
