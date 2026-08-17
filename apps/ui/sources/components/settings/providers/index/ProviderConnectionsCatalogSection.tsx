import * as React from 'react';

import { EmptyState } from '@/components/ui/empty/EmptyState';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemGroupColumn, ItemGroupColumns } from '@/components/ui/lists/ItemGroupColumns';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { Switch } from '@/components/ui/forms/Switch';
import { ProviderIcon } from '@/providers/connection/ProviderIcon';
import {
    PROVIDER_CONNECTION_STATUS_KEY,
    PROVIDER_CONNECTION_STATUS_VARIANT,
} from '@/providers/connection/presentation';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

type ConnectionStatus = keyof typeof PROVIDER_CONNECTION_STATUS_KEY;

export type ProviderConfiguredConnectionRow = Readonly<{
    connectionId: string;
    title: string;
    subtitle: string;
    icon: string | null;
    status: ConnectionStatus;
    enabled: boolean;
    pending: boolean;
}>;

export type ProviderAvailableConnectionRow = Readonly<{
    contributionKey: string;
    name: string;
    kind: 'frontier' | 'aggregator' | 'cloud' | 'local';
    provenance: 'first_party' | 'external';
    icon: string | null;
}>;

export function ProviderConnectionsCatalogSection(props: Readonly<{
    machineAvailable: boolean;
    hasData: boolean;
    searchEmpty: boolean;
    configured: readonly ProviderConfiguredConnectionRow[];
    available: readonly ProviderAvailableConnectionRow[];
    availableTruncated: boolean;
    textColor: string;
    onSetConnectionEnabled: (connectionId: string, enabled: boolean) => void;
    onOpenConnection: (connectionId: string) => void;
    onOpenAvailable: (contributionKey: string) => void;
}>): React.ReactElement | null {
    if (!props.hasData || !props.machineAvailable) return null;
    if (props.searchEmpty) {
        return (
            <ItemGroup title={t('settingsProviders.title')}>
                <EmptyState
                    icon={<Icon name="magnifying-glass" size={29} color={props.textColor} />}
                    title={t('settingsProviders.searchEmptyTitle')}
                    subtitle={t('settingsProviders.searchEmptyDescription')}
                />
            </ItemGroup>
        );
    }
    return (
        <ItemGroupColumns columns={2} paddingHorizontal={0} paddingVertical={0}>
            <ItemGroupColumn>
                {props.configured.length > 0 ? (
                    <ItemGroup title={`${t('settingsProviders.configuredTitle')} · ${props.configured.length}`} footer={t('settingsProviders.configuredFooter')}>
                        {props.configured.map((connection) => (
                            <Item
                                key={connection.connectionId}
                                testID={`settings-provider-connection:${connection.connectionId}`}
                                title={connection.title}
                                subtitle={connection.subtitle}
                                icon={<ProviderIcon icon={connection.icon} size={29} color={props.textColor} />}
                                rightElement={connection.pending
                                    ? <ActivitySpinner size="small" />
                                    : <Switch
                                        accessibilityLabel={connection.title}
                                        testID={`settings-provider-connection-enabled:${connection.connectionId}`}
                                        value={connection.enabled}
                                        onValueChange={(enabled) => props.onSetConnectionEnabled(connection.connectionId, enabled)}
                                    />}
                                rightElementOutsidePressable
                                keepChevronWithRightElement
                                subtitleAccessory={<StatusPill
                                    chrome="plain"
                                    variant={PROVIDER_CONNECTION_STATUS_VARIANT[connection.status]}
                                    label={t(PROVIDER_CONNECTION_STATUS_KEY[connection.status])}
                                />}
                                onPress={() => props.onOpenConnection(connection.connectionId)}
                            />
                        ))}
                    </ItemGroup>
                ) : (
                    <ItemGroup title={t('settingsProviders.configuredTitle')}>
                        <EmptyState
                            icon={<Icon name="cloud" size={29} color={props.textColor} />}
                            title={t('settingsProviders.emptyTitle')}
                            subtitle={t('settingsProviders.emptyDescription')}
                        />
                    </ItemGroup>
                )}
            </ItemGroupColumn>
            {props.available.length > 0 ? (
                <ItemGroupColumn>
                    <ItemGroup title={`${t('settingsProviders.availableTitle')} · ${props.available.length}${props.availableTruncated ? '+' : ''}`} footer={t('settingsProviders.availableFooter')}>
                        {props.available.map((provider) => (
                            <Item
                                key={provider.contributionKey}
                                testID={`settings-provider-available:${provider.contributionKey}`}
                                title={provider.name}
                                subtitle={t(`settingsProviders.kind.${provider.kind}`)}
                                subtitleAccessory={provider.provenance === 'external' ? <StatusPill chrome="plain" variant="warning" label={t('settingsProviders.compatibility.experimental')} /> : undefined}
                                icon={<ProviderIcon icon={provider.icon} size={29} color={props.textColor} />}
                                onPress={() => props.onOpenAvailable(provider.contributionKey)}
                            />
                        ))}
                    </ItemGroup>
                </ItemGroupColumn>
            ) : null}
        </ItemGroupColumns>
    );
}
