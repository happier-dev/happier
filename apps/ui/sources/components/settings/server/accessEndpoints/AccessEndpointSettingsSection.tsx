import * as React from 'react';
import { View } from 'react-native';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import {
    buildAccessChannelDirectionCopyKey,
    buildAccessChannelScopeCopyKey,
} from '@/sync/domains/accessEndpoints/channels/copy';
import type {
    AccessChannel,
    AccessChannelDirection,
} from '@/sync/domains/accessEndpoints/channels/model';
import type { AccessEndpointRemediationAction } from '@/sync/domains/accessEndpoints/model';
import { t } from '@/text';

import {
    AccessChannelChoiceCard,
    type AccessEndpointRemediationPressPayload,
} from './AccessChannelChoiceCard';

const accessChannelDirections = [
    'make-current-server-reachable',
    'reach-remote-server-from-this-device',
] as const satisfies readonly AccessChannelDirection[];

export type AccessEndpointSettingsSectionProps = Readonly<{
    channels: readonly AccessChannel[];
    remediationActions?: readonly AccessEndpointRemediationAction[];
    isRefreshing?: boolean;
    onRemediationActionPress?: (payload: AccessEndpointRemediationPressPayload) => void;
    testID?: string;
}>;

function filterChannelsByDirection(
    channels: readonly AccessChannel[],
    direction: AccessChannelDirection,
): readonly AccessChannel[] {
    return channels.filter((channel) => channel.direction === direction);
}

function scopeTestId(direction: AccessChannelDirection): string {
    return direction === 'make-current-server-reachable'
        ? 'settings.server.accessEndpoints.outwardScope'
        : 'settings.server.accessEndpoints.inwardScope';
}

export const AccessEndpointSettingsSection = React.memo(function AccessEndpointSettingsSection(props: AccessEndpointSettingsSectionProps) {
    if (props.channels.length === 0 && !props.isRefreshing) {
        return null;
    }

    return (
        <View testID={props.testID ?? 'settings.server.accessEndpoints'}>
            {props.isRefreshing ? (
                <Item
                    testID="settings.server.accessEndpoints.refreshing"
                    title={t('settings.accessEndpoints.status.refreshing')}
                    showChevron={false}
                    mode="info"
                />
            ) : null}
            {accessChannelDirections.map((direction) => {
                const directionChannels = filterChannelsByDirection(props.channels, direction);
                if (directionChannels.length === 0) {
                    return null;
                }

                const title = t(buildAccessChannelDirectionCopyKey(direction));
                return (
                    <View
                        key={direction}
                        testID={`settings.server.accessEndpoints.group.${direction}`}
                        accessibilityLabel={title}
                    >
                        <ItemGroup title={title}>
                            <Item
                                testID={scopeTestId(direction)}
                                title={t(buildAccessChannelScopeCopyKey(directionChannels[0]))}
                                subtitle={title}
                                showChevron={false}
                                mode="info"
                            />
                            {directionChannels.map((channel) => (
                                <AccessChannelChoiceCard
                                    key={channel.id}
                                    testID={`settings.server.accessEndpoints.channel:${channel.id}`}
                                    channel={channel}
                                    remediationActions={props.remediationActions}
                                    onRemediationActionPress={props.onRemediationActionPress}
                                />
                            ))}
                        </ItemGroup>
                    </View>
                );
            })}
        </View>
    );
});
