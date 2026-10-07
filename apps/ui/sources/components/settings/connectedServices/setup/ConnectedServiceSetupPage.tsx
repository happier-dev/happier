import * as React from 'react';
import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';

import { ItemList } from '@/components/ui/lists/ItemList';
import { useConnectedServicesIndex } from '../model/useConnectedServicesIndex';
import { buildConnectedServiceSetupCatalog } from './buildConnectedServiceSetupCatalog';
import { ConnectedServiceSetupPanel, type ConnectedServiceSetupTarget } from './ConnectedServiceSetupPanel';
import { ConnectedAccountPurposeTargetChooser } from '../account/ConnectedAccountPurposeTargetChooser';
import { useScopedPluginUiProjection } from '@/components/plugins/projection/useScopedPluginUiProjection';
import { useActiveServerAccountScope, useProfile, useSetting } from '@/sync/store/hooks';
import { useApplyConnectedAccountPurposeTarget } from '@/sync/store/settingsWriters';
import { getStorage } from '@/sync/domains/state/storageStore';
import { captureActiveServerAccountScopeLifetime, getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { readConnectedAccountPurposeSetupRequest, readConnectedAccountPurposeSetupDeclaration,
    isConnectedAccountPurposeSetupTargetCurrent } from '@/sync/domains/connectedServices/connectedAccountPurposeSetup';
import { qualifiedPurposeKey, type QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Modal } from '@/modal';
import { t } from '@/text';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';

/** Phone push presentation of the same catalog and authentication owner as the inline block. */
export function ConnectedServiceSetupPage() {
    const router = useRouter();
    const params = useLocalSearchParams<{ service?: string; accountId?: string; purpose?: string;
        purposeConsumerPlugin?: string; purposeConsumerId?: string; purposeServerId?: string; purposeAccountId?: string; purposeMachineId?: string }>();
    const request = React.useMemo(() => readConnectedAccountPurposeSetupRequest(params), [params.purpose,
        params.purposeConsumerPlugin, params.purposeConsumerId, params.purposeServerId, params.purposeAccountId, params.purposeMachineId]);
    const viewer = useActiveServerAccountScope();
    const profile = useProfile();
    const bindings = useSetting('connectedAccountPurposeBindingsV1');
    const lifetime = React.useMemo(() => captureActiveServerAccountScopeLifetime(), [viewer]);
    const purposeRuntime = useScopedPluginUiProjection({ machineId: request?.machineId, serverId: request?.scope.serverId, enabled: Boolean(request) });
    const latestRuntime = React.useRef(purposeRuntime);
    latestRuntime.current = purposeRuntime;
    const declaration = readConnectedAccountPurposeSetupDeclaration(request, viewer, purposeRuntime);
    const applyTarget = useApplyConnectedAccountPurposeTarget();
    const { indexModel } = useConnectedServicesIndex({ agents: 'load' });
    const catalog = React.useMemo(() => buildConnectedServiceSetupCatalog(indexModel).filter(entry => !request ||
        declaration?.serviceRefs.some(service => service.pluginId === entry.service.pluginId && service.localId === entry.service.localId)), [indexModel, request, declaration]);
    const [target, setTarget] = React.useState<ConnectedServiceSetupTarget>(() => typeof params.service !== 'string' ? { kind: 'catalog' }
        : typeof params.accountId === 'string' && params.accountId ? { kind: 'reconnect', serviceKey: params.service, accountId: params.accountId }
            : { kind: 'service', serviceKey: params.service });
    const select = async (next: QualifiedConnectedAccountPurposeBindingTargetV1 | null) => {
        if (!request) return;
        try {
            await applyTarget({ purpose: request.purpose, target: next, isCurrent: () => lifetime?.isCurrent() === true
                && isConnectedAccountPurposeSetupTargetCurrent({ request, viewer: getActiveServerAccountScope(), runtime: latestRuntime.current,
                    profile: getStorage().getState().profile, target: next }) });
            if (lifetime?.isCurrent()) router.back();
        } catch {
            Modal.alert(t('common.error'), t('widgetAdd.inputsUnavailable'));
        }
    };
    if (params.purpose !== undefined && (!request || !declaration || profile.id !== request.scope.accountId)) return <ItemList>
        <SurfaceStateCard testID="connected-account-purpose-unavailable" kind={purposeRuntime.phase === 'establishing' ? 'loading' : 'unavailable'}
            title={t('settings.connectedServices')} diagnosticCode="connected_account_purpose_unavailable" accessibilitySemantics="status" />
    </ItemList>;
    const selected = request ? bindings.bindings.find(binding => qualifiedPurposeKey(binding.purpose) === qualifiedPurposeKey(request.purpose))?.target ?? null : null;
    return <ItemList>
        {request && declaration?.serviceRefs.map(service => <ConnectedAccountPurposeTargetChooser
            key={`${service.pluginId}/${service.localId}`} testID={`connected-account-purpose:${service.pluginId}/${service.localId}`}
            localizedTextPluginId={request.purpose.consumer.pluginId} declaration={{ purpose: request.purpose.purpose, service, required: true }}
            value={selected} onChange={next => { void select(next); }} />)}
        <ConnectedServiceSetupPanel chrome="page" target={target} catalog={catalog}
        onTargetChange={setTarget} onClose={() => router.back()}
        onConnected={(account, serviceKey) => {
            if (request) {
                // Authentication settling is distinct from selecting the Resource purpose.
                // Refresh the canonical Account inventory before admitting the returned ref.
                void (async () => {
                    try {
                        if (!lifetime?.isCurrent()) return;
                        await getSyncSingleton().refreshProfile();
                        if (lifetime.isCurrent()) await select({ kind: 'account', account });
                    } catch { Modal.alert(t('common.error'), t('widgetAdd.inputsUnavailable')); }
                })();
                return;
            }
            router.dismissTo({ pathname: '/(app)/settings/connected-services',
                params: { connectedService: serviceKey, connectedAccount: account.accountId } });
        }} />
    </ItemList>;
}
