import * as React from 'react';
import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { parseQualifiedPluginContributionKey, buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { ModalProvider } from '@/modal';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { readConnectedAccountPurposeSetupRequest } from '@/sync/domains/connectedServices/connectedAccountPurposeSetup';
import { readMachineAdministrationTargetRouteParams } from '@/sync/domains/machines/administration/targetSelection';
import { t } from '@/text';
import { ConnectedServicesSettingsView } from '../ConnectedServicesSettingsView';
import { presentConnectSheet } from './ConnectedServiceSetupModal';

/** Legacy route ingress translates into the same sheet over its Credentials destination. */
export function ConnectedServiceConnectRoute() {
    const router = useRouter();
    const viewer = useActiveServerAccountScope();
    const params = useLocalSearchParams<{ service?: string; accountId?: string; purpose?: string;
        machineId?: string; serverIdentityId?: string; expectedAccountId?: string;
        purposeConsumerPlugin?: string; purposeConsumerId?: string; purposeServerId?: string; purposeAccountId?: string; purposeMachineId?: string }>();
    const routeKey = JSON.stringify([params.service, params.accountId, params.purpose, params.machineId, params.serverIdentityId,
        params.expectedAccountId, params.purposeConsumerPlugin, params.purposeConsumerId, params.purposeServerId,
        params.purposeAccountId, params.purposeMachineId, viewer]);
    const service = parseQualifiedPluginContributionKey(params.service);
    const purposeRequest = readConnectedAccountPurposeSetupRequest(params);
    const unavailable = params.expectedAccountId !== undefined && params.expectedAccountId !== viewer?.accountId
        || params.service !== undefined && !service || params.accountId !== undefined && (!service || !params.accountId)
        || params.purpose !== undefined && !purposeRequest;
    React.useEffect(() => {
        if (unavailable) return;
        const lifetime = captureActiveServerAccountScopeLifetime();
        let active = true;
        void presentConnectSheet({
            scope: lifetime?.scope ?? null,
            ...(service ? { service } : {}),
            ...(service && params.accountId ? { account: { service, accountId: params.accountId }, intent: 'reconnect' as const } : {}),
            ...(purposeRequest ? { purposeRequest, purpose: purposeRequest.purpose, purposeSettlement: 'resourceDefault' as const } : {}),
            ...(params.machineId !== undefined || params.serverIdentityId !== undefined
                ? { initialMachineTarget: readMachineAdministrationTargetRouteParams(params) } : {}),
        }).then(result => {
            if (!active || lifetime?.isCurrent() !== true) return;
            if (result.kind === 'dismissed' || purposeRequest) router.back();
            else router.dismissTo({ pathname: '/(app)/settings/connected-services', params: {
                connectedService: buildQualifiedPluginContributionKey(result.account.service), connectedAccount: result.account.accountId,
            } });
        });
        return () => { active = false; };
    }, [routeKey]);
    if (unavailable) return <ItemList pageColumn="wide">
        <PageHeader title={t('settings.connectedServices')} alwaysShowTitle />
        <ItemGroup surface="none">
            <SurfaceStateCard testID="connected-account-purpose-unavailable" size="line" kind="unavailable"
                title={t('common.unavailable')} diagnosticCode="connected_account_purpose_unavailable" accessibilitySemantics="status" />
        </ItemGroup>
    </ItemList>;
    return <ModalProvider key={routeKey}><ConnectedServicesSettingsView /></ModalProvider>;
}
