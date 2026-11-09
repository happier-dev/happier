import * as React from 'react';
import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { ProviderConnectionPurposeBindingDefaultsV1Schema } from '@happier-dev/protocol/providers/connections/v1';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';
import type { QualifiedConnectedAccountPurposeBindingGroupTargetV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';

import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { ProviderConnectionAuthoringScreen } from '@/components/settings/providers/ProviderConnectionAuthoringScreen';
import { ProviderConnectionDetailScreen } from '@/components/settings/providers/ProviderConnectionDetailScreen';
import { ProviderGatewaySections } from '@/components/settings/providers/gateway/ProviderGatewaySections';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { buildConnectedAccountSettingsRoute } from '@/sync/domains/connectedServices/connectedAccountSettingsRoute';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { presentConnectSheet } from './setup/ConnectedServiceSetupModal';
import { buildConnectedServicesGatewayRoute } from './collection/connectedServicesCollectionRoutes';

type GatewaySlot = Readonly<{ purpose: string; target: QualifiedConnectedAccountPurposeBindingGroupTargetV1 }>;
type GatewayPageProps = Readonly<{
    contributionKey?: string;
    connectionId?: string;
    slot?: GatewaySlot;
    displayName?: string;
    onCreated?: (connectionId: string) => void;
    onDiscard?: () => void;
}>;

/** Navigation adapter only: Providers and Connected services consume the same live bodies/writers. */
export function ConnectedServiceGatewayPage(props: GatewayPageProps = {}) {
    const router = useRouter();
    const params = useLocalSearchParams<Record<string, string | string[] | undefined>>();
    const first = (name: string) => {
        const value = params[name];
        return (Array.isArray(value) ? value[0] : value)?.trim();
    };
    const rawConnectionId = props.connectionId ?? first('connectionId');
    const connectionId = ProviderConnectionIdSchema.safeParse(rawConnectionId);
    if (rawConnectionId) return connectionId.success ? <ProviderConnectionDetailScreen
        key={connectionId.data} connectionId={connectionId.data}
        onDeleted={() => router.replace('/(app)/settings/connected-services')}
        onDuplicated={id => router.replace(buildConnectedServicesGatewayRoute({ connectionId: id }) as never)}
    /> : <SurfaceStateCard kind="unavailable" title={t('common.unavailable')} />;
    const contributionKey = props.contributionKey ?? first('contributionKey');
    const contributionIdentity = parseQualifiedPluginContributionKey(contributionKey);
    if (!contributionKey || !contributionIdentity) {
        return <SurfaceStateCard kind="unavailable" title={t('common.unavailable')} />;
    }
    const poolService = parseQualifiedPluginContributionKey(first('poolService'));
    const purpose = first('purpose');
    const routeSlots = poolService && purpose ? ProviderConnectionPurposeBindingDefaultsV1Schema.safeParse({
        [purpose]: { kind: 'group', service: poolService, groupId: first('poolId') },
    }) : null;
    const routeTarget = routeSlots?.success && purpose ? routeSlots.data[purpose] : null;
    const slot = props.slot ?? (routeTarget?.kind === 'group' && purpose ? { purpose, target: routeTarget } : undefined);
    return <ProviderConnectionAuthoringScreen
        key={JSON.stringify([contributionKey, slot])}
        contributionKey={contributionKey}
        displayName={props.displayName ?? t('settingsProvidersCollection.gateway.mainGatewayName')}
        managedDeployment={{ kind: 'managedLocal', purposeBindingDefaults: slot ? { [slot.purpose]: slot.target } : {} }}
        onCreated={props.onCreated ?? (id => router.replace(buildConnectedServicesGatewayRoute({ connectionId: id }) as never))}
        onDiscard={props.onDiscard ?? (() => router.replace(slot
            ? buildConnectedAccountSettingsRoute(slot.target.service, { kind: 'group', groupId: slot.target.groupId }) ?? '/(app)/settings/connected-services'
            : '/(app)/settings/connected-services'))}
        renderManagedDeployment={({ scope, deployment, declarations, modelRoles, machines, onChange, disabled }) => <ProviderGatewaySections
            localizedTextPluginId={contributionIdentity.pluginId}
            declarations={declarations} slots={deployment.purposeBindingDefaults}
            onChangeSlot={(slotPurpose, target) => {
                const slots = { ...deployment.purposeBindingDefaults };
                if (target) slots[slotPurpose] = target; else delete slots[slotPurpose];
                onChange({ ...deployment, purposeBindingDefaults: slots });
            }}
            onConnectService={(serviceKey, anchor) => {
                const service = parseQualifiedPluginContributionKey(serviceKey) ?? undefined;
                fireAndForget(presentConnectSheet({ scope, service, ...(anchor ? { anchor } : {}) }), { tag: 'ConnectedServiceGatewayPage.connect' });
            }}
            placement={deployment.gatewayPlacement ?? undefined}
            machines={machines.map(row => ({ machineId: row.target.machineId, displayName: row.displayName, online: row.online }))}
            reachability="not_checked"
            onChangePlacement={gatewayPlacement => onChange({ ...deployment, gatewayPlacement })}
            helperModels={deployment.roleModels ?? undefined} modelRoles={modelRoles} models={null}
            onChangeHelperModels={roleModels => onChange({ ...deployment, roleModels })}
            disabled={disabled} nameRow={null} pickerRows={null}
        />}
    />;
}
