import * as React from 'react';

import { Item } from '@/components/ui/lists/Item';
import {
    buildAccessChannelCopyKeys,
    buildAccessChannelRecommendedUseCopyKey,
    buildAccessEndpointRemediationActionCopyKey,
} from '@/sync/domains/accessEndpoints/channels/copy';
import type { AccessChannel } from '@/sync/domains/accessEndpoints/channels/model';
import type { AccessEndpointRemediationAction } from '@/sync/domains/accessEndpoints/model';
import { t, tLoose } from '@/text';

import { AccessEndpointTradeoffList } from './AccessEndpointTradeoffList';

export type AccessEndpointRemediationPressPayload = Readonly<{
    action: AccessEndpointRemediationAction;
    channel: AccessChannel;
}>;

export type AccessChannelChoiceCardProps = Readonly<{
    channel: AccessChannel;
    remediationActions?: readonly AccessEndpointRemediationAction[];
    onRemediationActionPress?: (payload: AccessEndpointRemediationPressPayload) => void;
    testID: string;
}>;

function resolveChannelSubtitle(channel: AccessChannel): string {
    if (!channel.label) {
        return t(buildAccessChannelCopyKeys(channel).subtitleKey);
    }
    return tLoose(channel.label);
}

export const AccessChannelChoiceCard = React.memo(function AccessChannelChoiceCard(props: AccessChannelChoiceCardProps) {
    const copyKeys = buildAccessChannelCopyKeys(props.channel);
    const actionsById = React.useMemo(() => new Map(
        (props.remediationActions ?? []).map((action) => [action.id, action] as const),
    ), [props.remediationActions]);
    const channelActions = React.useMemo(() => (
        props.channel.remediationActionIds.flatMap((actionId) => {
            const action = actionsById.get(actionId);
            return action ? [action] : [];
        })
    ), [actionsById, props.channel.remediationActionIds]);

    return (
        <>
            <Item
                testID={props.testID}
                title={t(copyKeys.titleKey)}
                subtitle={resolveChannelSubtitle(props.channel)}
                showChevron={false}
                mode="info"
            />
            <Item
                testID={`${props.testID}.recommendedUse`}
                title={t(buildAccessChannelRecommendedUseCopyKey(props.channel))}
                subtitle={t(copyKeys.subtitleKey)}
                showChevron={false}
                mode="info"
                density="compact"
            />
            <AccessEndpointTradeoffList channel={props.channel} testID={props.testID} />
            {channelActions.map((action) => (
                <Item
                    key={action.id}
                    testID={`${props.testID}.action:${action.id}`}
                    title={t(buildAccessEndpointRemediationActionCopyKey(action))}
                    onPress={() => {
                        props.onRemediationActionPress?.({
                            action,
                            channel: props.channel,
                        });
                    }}
                />
            ))}
        </>
    );
});
