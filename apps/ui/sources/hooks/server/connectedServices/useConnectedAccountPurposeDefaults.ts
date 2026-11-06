import * as React from 'react';
import type { QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import { CONNECTED_SERVICE_CONFIGURATION_ACTION_INPUT_SCHEMAS_V1 } from '@happier-dev/protocol/connect/configurationActionsV1';
import { useActiveServerAccountScope, useSettingsSelector } from '@/sync/store/hooks';
import { useConnectedAccountCatalog } from '@/sync/store/settings/useConnectedAccountCatalog';
import { getConnectedAccountCatalogValue } from '@/sync/store/settings/connectedAccountCatalogSnapshot';
import { ConnectedAccountCatalogOperationError } from '@/sync/api/account/apiConnectedAccountCatalog';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { refreshConnectedAccountCatalog } from '@/sync/engine/settings/connectedAccountCatalogEngine';

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
    const legacySettings = useSettingsSelector(settings => ({
        connectedServicesDefaultAuthByAgentIdV1: settings.connectedServicesDefaultAuthByAgentIdV1,
        connectedServicesAdditionalDefaultAuthByAgentIdV1: settings.connectedServicesAdditionalDefaultAuthByAgentIdV1,
    }), ["connectedServicesDefaultAuthByAgentIdV1","connectedServicesAdditionalDefaultAuthByAgentIdV1"]);
    const mutateDefaults = React.useCallback(async (intent: ConnectedAccountPurposeDefaultsIntent): Promise<boolean> => {
        let current = getConnectedAccountCatalogValue(scope, 'purposes');
        // An acknowledged default write invalidates this projection. A subsequent
        // user choice joins the existing refresh rather than failing on that stale view.
        if (scope && current.value && current.stale) {
            await refreshConnectedAccountCatalog(scope, 'purposes');
            if (!execution.isCurrent()) return false;
            current = getConnectedAccountCatalogValue(scope, 'purposes');
        }
        if (!scope || current.status !== 'ready' || !current.value || current.stale) throw new ConnectedAccountCatalogOperationError('connected_account_purpose_catalog_unavailable');
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
        if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode });
        // The Action keeps its durable receipt; a retired mounted presentation
        // must not dismiss or advance the successor Home on that receipt.
        if (!execution.isCurrent()) return false;
        return !(result.result && typeof result.result === 'object' && 'changed' in result.result && result.result.changed === false);
    }, [execution.execute, execution.isCurrent, scope]);
    return React.useMemo(() => ({ catalog, legacySettings, mutateDefaults, execution }), [catalog, legacySettings, mutateDefaults, execution]);
}
