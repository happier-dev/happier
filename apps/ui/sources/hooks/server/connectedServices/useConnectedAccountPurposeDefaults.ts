import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import * as React from 'react';
import type { QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import { CONNECTED_SERVICE_CONFIGURATION_ACTION_INPUT_SCHEMAS_V1 } from '@happier-dev/protocol/connect/configurationActionsV1';
import { useActiveServerAccountScope, useSetting } from '@/sync/store/hooks';
import { useConnectedAccountCatalog } from '@/sync/store/settings/useConnectedAccountCatalog';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';

export type ConnectedAccountPurposeDefaultsIntent =
    | Readonly<{ kind: 'target'; target: QualifiedConnectedAccountPurposeBindingTargetV1; agentId: string; makeDefault: boolean; machineId?: string }>
    | Readonly<{ kind: 'resource'; input: ReturnType<(typeof CONNECTED_SERVICE_CONFIGURATION_ACTION_INPUT_SCHEMAS_V1)['connectedServices.purposes.default.set']['parse']> }>
    | Readonly<{ kind: 'service'; input: ReturnType<(typeof CONNECTED_SERVICE_CONFIGURATION_ACTION_INPUT_SCHEMAS_V1)['connectedServices.accounts.purposeDefault.set']['parse']> }>;

/** One catalog source and acknowledged mutation port for all Agent default surfaces. */
export function useConnectedAccountPurposeDefaults(serverId?: string, options?: Readonly<{ enabled?: boolean }>) {
    const activeScope = useActiveServerAccountScope();
    const execution = useMountedActionExecution(serverId ?? activeScope);
    const scope = execution.binding?.scope ?? null;
    const catalog = useConnectedAccountCatalog('purposes', scope, options);
    const connectedServicesDefaultAuthByAgentIdV1 = useSetting('connectedServicesDefaultAuthByAgentIdV1');
    const connectedServicesAdditionalDefaultAuthByAgentIdV1 = useSetting('connectedServicesAdditionalDefaultAuthByAgentIdV1');
    const legacySettings = React.useMemo(() => ({
        connectedServicesDefaultAuthByAgentIdV1,
        connectedServicesAdditionalDefaultAuthByAgentIdV1,
    }), [connectedServicesDefaultAuthByAgentIdV1, connectedServicesAdditionalDefaultAuthByAgentIdV1]);
    const mutateDefaults = React.useCallback(async (intent: ConnectedAccountPurposeDefaultsIntent): Promise<boolean> => {
        const action = intent.kind === 'resource'
            ? { actionId: 'connectedServices.purposes.default.set' as const, input: intent.input }
            : intent.kind === 'service'
            ? { actionId: 'connectedServices.accounts.purposeDefault.set' as const, input: intent.input }
            : intent.target.kind === 'account'
                ? { actionId: 'connectedServices.accounts.default.set' as const,
                    input: { account: intent.target.account, agentId: intent.agentId, makeDefault: intent.makeDefault,
                        ...(intent.machineId ? { machineId: intent.machineId } : {}) } }
                : { actionId: 'connectedServices.pools.default.set' as const,
                    input: { group: { service: intent.target.service, groupId: intent.target.groupId }, agentId: intent.agentId, makeDefault: intent.makeDefault,
                        ...(intent.machineId ? { machineId: intent.machineId } : {}) } };
        const result = await execution.execute(action.actionId, action.input);
        if (!result.ok) throw createActionExecuteFailureError(result);
        // The Action keeps its durable receipt; a retired mounted presentation
        // must not dismiss or advance the successor Home on that receipt.
        if (!execution.isCurrent()) return false;
        return !(result.result && typeof result.result === 'object' && 'changed' in result.result && result.result.changed === false);
    }, [execution.execute, execution.isCurrent]);
    return React.useMemo(() => ({ catalog, legacySettings, mutateDefaults, execution }), [catalog, legacySettings, mutateDefaults, execution]);
}
