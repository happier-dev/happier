import type { MachineIsolationPolicyV1, MachineIsolationWorkChoiceV1 } from '@happier-dev/protocol/machines/machineIsolationV1';
import { machineIsolationMetadataFieldV1 } from '@happier-dev/protocol/machines/machineIsolationPolicyV1';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contributionIdentity';

export type MachineIsolationWorkKind = keyof MachineIsolationPolicyV1['workKinds'];
export type MachineIsolationLifecycle = Extract<MachineIsolationWorkChoiceV1, { kind: 'sandbox' }>['lifecycle'];

/** The work kinds, in the policy owner's own order (its default policy), never a hand-kept list. */
export const MACHINE_ISOLATION_WORK_KINDS = Object.keys(machineIsolationMetadataFieldV1.defaultValue().workKinds) as readonly MachineIsolationWorkKind[];

/** Saved policy assignments, rather than running Sessions, say which kinds of work use a sandbox. */
export function machineIsolationSandboxUsedWorkKinds(policy: MachineIsolationPolicyV1,
    configuredSandboxId: string): readonly MachineIsolationWorkKind[] {
    return MACHINE_ISOLATION_WORK_KINDS.filter(kind => {
        const choice = policy.workKinds[kind];
        return choice.kind === 'sandbox' && choice.configuredSandboxId === configuredSandboxId;
    });
}

/** One configured sandbox as the page shows it: its preset's name and whether its type can host the Agent's own sandbox. */
export type MachineIsolationEntryPresentation = Readonly<{
    id: string;
    name: string;
    /** `null` until the sandbox type's declaration is known; then whether it can host the Agent's own sandbox. */
    supportsAgentNativeSandbox: boolean | null;
}>;

/** Where one kind of work runs: Directly (`null`) or a configured sandbox, keeping that kind's lifecycle when it had one. */
export function withMachineIsolationWorkTarget(policy: MachineIsolationPolicyV1, kind: MachineIsolationWorkKind,
    configuredSandboxId: string | null): MachineIsolationPolicyV1 {
    const current = policy.workKinds[kind];
    const choice: MachineIsolationWorkChoiceV1 = configuredSandboxId === null ? { kind: 'directly' }
        : { kind: 'sandbox', configuredSandboxId, lifecycle: current.kind === 'sandbox' ? current.lifecycle : 'fresh' };
    return { ...policy, workKinds: { ...policy.workKinds, [kind]: choice } };
}

export function withMachineIsolationLifecycle(policy: MachineIsolationPolicyV1, kind: MachineIsolationWorkKind,
    lifecycle: MachineIsolationLifecycle): MachineIsolationPolicyV1 {
    const current = policy.workKinds[kind];
    if (current.kind !== 'sandbox') return policy;
    return { ...policy, workKinds: { ...policy.workKinds, [kind]: { ...current, lifecycle } } };
}

/**
 * Adds a sandbox type + preset entry (or finds the one already configured for that pair) and, when the add flow was
 * opened for a kind of work, runs that kind in it, new each time. Nothing is created until work starts.
 */
export function withMachineIsolationSandbox(policy: MachineIsolationPolicyV1, entry: Readonly<{
    provisioner: PluginContributionIdentityV1; presetId: string; useFor?: MachineIsolationWorkKind;
}>, newId: () => string): Readonly<{ policy: MachineIsolationPolicyV1; id: string }> {
    const existing = Object.entries(policy.configuredSandboxes).find(([, configured]) => configured.presetId === entry.presetId
        && configured.provisioner.pluginId === entry.provisioner.pluginId && configured.provisioner.localId === entry.provisioner.localId);
    const id = existing?.[0] ?? newId();
    const withEntry: MachineIsolationPolicyV1 = existing ? policy : { ...policy, configuredSandboxes: { ...policy.configuredSandboxes,
        [id]: { provisioner: { pluginId: entry.provisioner.pluginId, localId: entry.provisioner.localId }, presetId: entry.presetId } } };
    return { id, policy: entry.useFor ? withMachineIsolationWorkTarget(withEntry, entry.useFor, id) : withEntry };
}

/** Removing an entry moves every work kind that used it back to Directly, in the same save. */
export function withoutMachineIsolationSandbox(policy: MachineIsolationPolicyV1, id: string): MachineIsolationPolicyV1 {
    const { [id]: _removed, ...configuredSandboxes } = policy.configuredSandboxes;
    const workKinds = Object.fromEntries(MACHINE_ISOLATION_WORK_KINDS.map(kind => {
        const choice = policy.workKinds[kind];
        return [kind, choice.kind === 'sandbox' && choice.configuredSandboxId === id ? { kind: 'directly' } : choice];
    })) as MachineIsolationPolicyV1['workKinds'];
    return { ...policy, configuredSandboxes, workKinds };
}

/**
 * What the "Agent's own sandbox" row says before anyone turns it on: the sandboxes work actually runs in, and
 * which of their types cannot host it. Support is the type's own declaration (seam B), resolved per preset.
 */
export function describeMachineIsolationNativeSupport(policy: MachineIsolationPolicyV1,
    entries: readonly MachineIsolationEntryPresentation[]): Readonly<{
        usesSandbox: boolean; unsupported: readonly string[]; allUnsupported: boolean;
    }> {
    const used = new Set(MACHINE_ISOLATION_WORK_KINDS.flatMap(kind => {
        const choice = policy.workKinds[kind];
        return choice.kind === 'sandbox' ? [choice.configuredSandboxId] : [];
    }));
    const usedEntries = entries.filter(entry => used.has(entry.id));
    const unsupported = usedEntries.filter(entry => entry.supportsAgentNativeSandbox === false).map(entry => entry.name);
    return { usesSandbox: used.size > 0, unsupported,
        allUnsupported: usedEntries.length > 0 && unsupported.length === usedEntries.length };
}
