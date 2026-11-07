import * as React from 'react';
import type { ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { MachineProvisionersListResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import type { PluginJsonSchemaV2 } from '@happier-dev/protocol/plugins/contributions/public-types';
import type { PluginProjectedActionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { machinePluginActionSchemasRead } from '@/sync/ops/machineContributionRegistryProjection';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { readPluginAccountAvailability, usePluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/projection';
import { retainDeep, retainShallow } from '@/sync/domains/state/structuralSharing';

export type ManagedProvisionerOptionsInput = Readonly<{ kind: 'none' | 'loading' }>
    | Readonly<{ kind: 'unavailable'; error: string }>
    | Readonly<{ kind: 'ready'; schema: PluginJsonSchemaV2; action: Pick<PluginProjectedActionV2, 'pluginId' | 'id' | 'occurrenceId'> }>;
const none = { kind: 'none' } as const;
const loading = { kind: 'loading' } as const;
const controllerUnavailable = { kind: 'unavailable', error: 'controller_unavailable' } as const;

/** Chooser and retained-policy reads share the catalog's exact occurrence-qualified options schema. */
export async function readManagedProvisionerOptionsInput(input: Readonly<{
    binding: ServerCredentialAccountScopeBinding;
    controller?: ManagedControllerV1;
    provisioner: MachineProvisionersListResultV1['provisioners'][number];
    signal: AbortSignal;
}>): Promise<ManagedProvisionerOptionsInput> {
    const { binding, controller, provisioner, signal } = input;
    const localId = provisioner.descriptor.actions.options;
    if (!localId) return none;
    const identity = { pluginId: provisioner.contribution.pluginId, localId };
    const occurrenceId = provisioner.occurrenceId;
    if (!controller) {
        const selected = await readPluginAccountAvailability(binding.scope).ensureCurrentAccountExecution(identity.pluginId);
        if (selected.kind !== 'available') return { kind: 'unavailable', error: selected.code };
        const action = selected.custodyId === occurrenceId
            ? selected.manifest.contributes.actions.find(action => action.id === localId) : undefined;
        return action?.inputSchema ? { kind: 'ready', schema: action.inputSchema,
            action: { pluginId: identity.pluginId, id: localId, occurrenceId } }
            : { kind: 'unavailable', error: 'option_unavailable' };
    }
    const result = await machinePluginActionSchemasRead(controller.machineId, {
        serverId: binding.serverId, expectedOccurrenceId: occurrenceId,
        qualifiedActionId: buildQualifiedPluginContributionKey(identity), signal,
    });
    return !result.supported ? { kind: 'unavailable', error: result.reason }
        : !result.result.ok ? { kind: 'unavailable', error: result.result.code }
            : !result.result.inputSchema ? { kind: 'unavailable', error: 'option_unavailable' }
                : { kind: 'ready', action: { pluginId: identity.pluginId, id: localId, occurrenceId }, schema: result.result.inputSchema };
}

/**
 * Describes the selected catalog's options role, pinned to its plugin occurrence and captured Home.
 * The catalog already owns the Action identity and occurrence; presentation section hydration
 * supplies form hints and translations, not authority to ask this exact schema question.
 */
export function useManagedProvisionerOptionsInput(input: Readonly<{
    binding: ServerCredentialAccountScopeBinding | null;
    controller?: ManagedControllerV1;
    provisioner?: MachineProvisionersListResultV1['provisioners'][number];
    /** Changes when the person asks to read again. */
    refreshKey?: number;
}>): ManagedProvisionerOptionsInput {
    const { binding, controller, provisioner, refreshKey } = input;
    const accountReader = usePluginAccountAvailabilityReader(binding?.scope ?? null, provisioner?.contribution.pluginId,
        { enabled: !controller });
    const localId = provisioner?.descriptor.actions.options;
    const identity = localId && provisioner ? { pluginId: provisioner.contribution.pluginId, localId } : null;
    const occurrenceId = provisioner?.occurrenceId;
    const key = JSON.stringify([binding?.scope, binding?.revision, controller, identity, occurrenceId]);
    const [state, setState] = React.useState<Readonly<{ key: string; value: ManagedProvisionerOptionsInput }>>({ key: '', value: { kind: 'loading' } });
    React.useEffect(() => {
        if (!binding?.isCurrent() || !identity || !occurrenceId || !provisioner) return;
        const abort = new AbortController();
        const retirement = binding.onRetire(() => { abort.abort(); setState({ key: '', value: { kind: 'loading' } }); });
        // Retry asks the same question again; it does not withdraw its settled answer.
        setState(current => current.key === key ? current : { key, value: loading });
        const publish = (value: ManagedProvisionerOptionsInput) => setState(current => retainShallow(current, {
            key, value: retainDeep(current.key === key ? current.value : undefined, value),
        }));
        void readManagedProvisionerOptionsInput({ binding, controller, provisioner, signal: abort.signal }).then(value => {
            if (abort.signal.aborted || !binding.isCurrent()) return;
            publish(value);
        }).catch(() => {
            if (!abort.signal.aborted && binding.isCurrent()) publish({ kind: 'unavailable', error: 'unavailable' });
        });
        return () => { abort.abort(); retirement.dispose(); };
    }, [binding, controller?.machineId, controller?.installationId, key, refreshKey, accountReader]);
    if (!localId) return none;
    if (!binding?.isCurrent()) return controllerUnavailable;
    return state.key === key ? state.value : loading;
}
