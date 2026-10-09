import * as React from 'react';
import type { writeConnectedAccountPurposeDefault } from '@happier-dev/protocol/account/settings/connected-services';
import type { ConnectedAccountPurposeMutationIntentV1 } from '@happier-dev/protocol/connect/execute-configuration-action';
import { useActiveServerAccountScope, useSettingsSelector } from '@/sync/store/hooks';
import { useConnectedAccountCatalog } from '@/sync/store/settings/useConnectedAccountCatalog';
import { getConnectedAccountCatalogValue } from '@/sync/store/settings/connectedAccountCatalogSnapshot';
import { withConnectedAccountCatalogAccount, ConnectedAccountCatalogOperationError } from '@/sync/api/account/apiConnectedAccountCatalog';
import { mutateConnectedAccountPurposeDefaultsInContext } from '@/sync/ops/connectedAccounts/connectedAccountPurposeDefaults';

export type ConnectedAccountPurposeDefaultsIntent = (purposeBindings: Parameters<ConnectedAccountPurposeMutationIntentV1>[0],
    legacySettings: Parameters<ConnectedAccountPurposeMutationIntentV1>[1]) => ReturnType<typeof writeConnectedAccountPurposeDefault> | null;

/** One catalog source and acknowledged mutation port for all Agent default surfaces. */
export function useConnectedAccountPurposeDefaults() {
    const scope = useActiveServerAccountScope();
    const catalog = useConnectedAccountCatalog('purposes', scope);
    const legacySettings = useSettingsSelector(settings => ({
        connectedServicesDefaultAuthByAgentIdV1: settings.connectedServicesDefaultAuthByAgentIdV1,
        connectedServicesAdditionalDefaultAuthByAgentIdV1: settings.connectedServicesAdditionalDefaultAuthByAgentIdV1,
    }));
    const mutateDefaults = React.useCallback(async (mutate: ConnectedAccountPurposeDefaultsIntent): Promise<void> => {
        const current = getConnectedAccountCatalogValue(scope, 'purposes');
        if (!scope || current.status !== 'ready' || !current.value || current.stale) throw new ConnectedAccountCatalogOperationError('connected_account_purpose_catalog_unavailable');
        await withConnectedAccountCatalogAccount(scope, undefined, context => mutateConnectedAccountPurposeDefaultsInContext(context,
            (purposeBindings, settings) => {
                const next = mutate(purposeBindings, settings);
                if (!next) return null;
                const { connectedAccountPurposeBindingsV1, ...legacySettingsDelta } = next;
                return { purposeBindings: connectedAccountPurposeBindingsV1, legacySettingsDelta };
            }));
    }, [scope]);
    return React.useMemo(() => ({ catalog, legacySettings, mutateDefaults }), [catalog, legacySettings, mutateDefaults]);
}
