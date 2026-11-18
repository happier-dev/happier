import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

import { fireAndForget } from '@/utils/system/fireAndForget';

import type { ConnectedServicesGatewayRow, useConnectedServicesIndex } from '../model/useConnectedServicesIndex';

/**
 * Gateways on the Credentials overview (lab `cr` crHome A, `rgateway` GW1p): a section like the others, and
 * the phone's way in. Each opens the gateway's one page. With none
 * yet, one quiet row adds the first (D19); while that waits on an approval, the approval takes the
 * row's place, where the user asked for it. When the gateways cannot be read the group stays and says
 * so, with Retry (D19: the place never disappears).
 */
export const ConnectedServicesGatewaysGroup = React.memo(function ConnectedServicesGatewaysGroup(props: Readonly<{
    gateways: readonly ConnectedServicesGatewayRow[];
    /** The Account catalog is still loading: one quiet row keeps the group's place. */
    loading?: boolean;
    onOpen: (gateway: ConnectedServicesGatewayRow) => void;
    onAdd?: () => void;
    adding?: boolean;
    addError?: string | null;
    approval?: React.ReactNode;
    /** The gateways cannot be read: the group says so in place of its rows, with Retry. */
    unavailable?: Readonly<{ diagnosticCode: string; onRetry: () => void }> | null;
}>) {
    const { theme } = useUnistyles();
    if (props.gateways.length === 0 && !props.onAdd && !props.approval && !props.loading && !props.unavailable) return null;
    return (
        <ItemGroup
            testID="connected-services-index:gateways"
            title={t('settingsProvidersCollection.gateway.railGroup')}
            description={t('connectedServicesCollection.gatewaysDescription')}
            surface="none"
            // With gateways listed, adding another is the section's action, like New pool; with none, the quiet row below.
            action={props.gateways.length > 0 && props.onAdd && !props.approval ? (
                <SectionActionButton
                    testID="connected-services-index:add-gateway-action"
                    icon="plus"
                    title={t('settingsProvidersCollection.gateway.addGateway')}
                    disabled={props.adding}
                    onPress={props.onAdd}
                />
            ) : undefined}
        >
            {props.approval ?? null}
            {props.loading && props.gateways.length === 0 && !props.approval ? (
                <Item
                    testID="connected-services-index:gateways-loading"
                    title={t('common.loading')}
                    titleStyle={{ color: theme.colors.text.tertiary }}
                    icon={<Icon name="path" size={18} color={theme.colors.text.tertiary} />}
                    showChevron={false}
                    disabled
                />
            ) : null}
            {props.unavailable && props.gateways.length === 0 && !props.approval ? (
                <ConnectedServicesGatewaysUnavailableLine testID="connected-services-index:gateways-unavailable"
                    unavailable={props.unavailable} />
            ) : null}
            {props.gateways.length === 0 && props.onAdd && !props.approval ? (
                <Item
                    testID="connected-services-index:add-gateway"
                    title={t('settingsProvidersCollection.gateway.addGateway')}
                    titleStyle={{ color: theme.colors.text.secondary }}
                    subtitle={props.addError ?? undefined}
                    subtitleStyle={props.addError ? { color: theme.colors.state.danger.textForeground } : undefined}
                    icon={<Icon name="plus" size={18} color={theme.colors.text.secondary} />}
                    showChevron={false}
                    loading={props.adding}
                    disabled={props.adding}
                    onPress={props.onAdd}
                />
            ) : null}
            {props.gateways.map((gateway) => (
                <Item
                    key={gateway.connectionId}
                    testID={`connected-services-index:gateway:${gateway.connectionId}`}
                    title={gateway.title}
                    subtitle={gateway.summary}
                    icon={<Icon name="path" size={18} color={theme.colors.text.secondary} />}
                    onPress={() => props.onOpen(gateway)}
                />
            ))}
        </ItemGroup>
    );
});

/** The Gateways place when its catalog cannot be read: one line and Retry, in the rail and on a phone. */
export function ConnectedServicesGatewaysUnavailableLine(props: Readonly<{
    testID: string;
    unavailable: Readonly<{ diagnosticCode: string; onRetry: () => void }>;
}>) {
    return (
        <SurfaceStateCard
            testID={props.testID}
            kind="unavailable"
            size="line"
            title={t('settingsProvidersCollection.gateway.unavailableTitle')}
            diagnosticCode={props.unavailable.diagnosticCode}
            action={{ testID: `${props.testID}.retry`, label: t('common.retry'), onPress: props.unavailable.onRetry }}
        />
    );
}

type GatewayUnavailable = ReturnType<typeof useConnectedServicesIndex>['gatewayUnavailable'];

/** The index's unavailable Gateways fact as the line's input: its reason code and the catalog Retry. */
export function useConnectedServicesGatewaysUnavailable(unavailable: GatewayUnavailable, retry: () => Promise<void>) {
    const diagnosticCode = unavailable === null ? null
        : unavailable.kind === 'declaration' ? 'gateway-declaration-unavailable'
            : unavailable.catalog.status === 'unavailable' ? unavailable.catalog.reason : `catalog-${unavailable.catalog.status}`;
    return React.useMemo(() => diagnosticCode === null ? null : {
        diagnosticCode,
        onRetry: () => fireAndForget(retry(), { tag: 'ConnectedServices.retryGateways' }),
    }, [diagnosticCode, retry]);
}
