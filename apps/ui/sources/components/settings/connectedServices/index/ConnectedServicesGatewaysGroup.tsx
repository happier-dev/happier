import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

import type { ProviderGatewayCollectionRow } from '../../providers/collection/providerCollectionModel';

/**
 * Gateways on the Connected services index (lab `rgateway` GW1p): the phone's way in, since the rail
 * that lists them on wide screens is not shown there. Each opens the gateway's one page.
 */
export const ConnectedServicesGatewaysGroup = React.memo(function ConnectedServicesGatewaysGroup(props: Readonly<{
    gateways: readonly ProviderGatewayCollectionRow[];
    onOpen: (gateway: ProviderGatewayCollectionRow) => void;
}>) {
    const { theme } = useUnistyles();
    if (props.gateways.length === 0) return null;
    return (
        <ItemGroup title={t('settingsProvidersCollection.gateway.railGroup')}>
            {props.gateways.map((gateway) => (
                <Item
                    key={gateway.connectionId}
                    testID={`connected-services-index:gateway:${gateway.connectionId}`}
                    title={gateway.title}
                    icon={<Icon name="path" size={18} color={theme.colors.text.secondary} />}
                    onPress={() => props.onOpen(gateway)}
                />
            ))}
        </ItemGroup>
    );
});
