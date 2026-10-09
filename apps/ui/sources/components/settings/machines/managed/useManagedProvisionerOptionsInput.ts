import * as React from 'react';
import type { ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { MachineProvisionersListResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import type { PluginJsonSchemaV2 } from '@happier-dev/protocol/plugins/contributions/publicTypes';
import type { PluginProjectedActionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { createPluginUiProjectedActionResolver, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { machinePluginActionSchemasRead } from '@/sync/ops/machineContributionRegistryProjection';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';

export type ManagedProvisionerOptionsInput = Readonly<{ kind: 'none' | 'loading' }>
    | Readonly<{ kind: 'unavailable'; error: string }>
    | Readonly<{ kind: 'ready'; schema: PluginJsonSchemaV2; action: PluginProjectedActionV2 }>;
const none = { kind: 'none' } as const;
const loading = { kind: 'loading' } as const;
const controllerUnavailable = { kind: 'unavailable', error: 'controller_unavailable' } as const;
const actionUnavailable = { kind: 'unavailable', error: 'action_not_found' } as const;

/** Describes the actual options role, pinned to its projected occurrence and captured Home. */
export function useManagedProvisionerOptionsInput(input: Readonly<{
    binding: ServerCredentialAccountScopeBinding | null;
    controller?: ManagedControllerV1;
    provisioner?: MachineProvisionersListResultV1['provisioners'][number];
    projection: PluginUiProjectionModel;
    projectionReady: boolean;
}>): ManagedProvisionerOptionsInput {
    const { binding, controller, provisioner, projection, projectionReady } = input;
    const localId = provisioner?.descriptor.actions.options;
    const identity = localId && provisioner ? { pluginId: provisioner.contribution.pluginId, localId } : null;
    const action = identity && projectionReady ? createPluginUiProjectedActionResolver(projection.actionsById)(identity) : null;
    const key = JSON.stringify([binding?.scope, binding?.revision, controller, identity, action?.occurrenceId]);
    const [state, setState] = React.useState<Readonly<{ key: string; value: ManagedProvisionerOptionsInput }>>({ key: '', value: { kind: 'loading' } });
    React.useEffect(() => {
        if (!binding?.isCurrent() || !controller || !identity || !projectionReady || !action) return;
        const abort = new AbortController();
        const retirement = binding.onRetire(() => { abort.abort(); setState({ key: '', value: { kind: 'loading' } }); });
        setState({ key, value: { kind: 'loading' } });
        void machinePluginActionSchemasRead(controller.machineId, {
            serverId: binding.serverId, expectedOccurrenceId: action.occurrenceId,
            qualifiedActionId: buildQualifiedPluginContributionKey(identity), signal: abort.signal,
        }).then(result => {
            if (abort.signal.aborted || !binding.isCurrent()) return;
            const value: ManagedProvisionerOptionsInput = !result.supported ? { kind: 'unavailable', error: result.reason }
                : !result.result.ok ? { kind: 'unavailable', error: result.result.code }
                    : { kind: 'ready', action, schema: result.result.inputSchema };
            setState({ key, value });
        }).catch(() => {
            if (!abort.signal.aborted && binding.isCurrent()) setState({ key, value: { kind: 'unavailable', error: 'unavailable' } });
        });
        return () => { abort.abort(); retirement.dispose(); };
    }, [binding, controller?.machineId, controller?.installationId, projectionReady, action, key]);
    if (!localId) return none;
    if (!binding?.isCurrent() || !controller) return controllerUnavailable;
    if (!projectionReady) return loading;
    if (!action) return actionUnavailable;
    return state.key === key ? state.value : loading;
}
