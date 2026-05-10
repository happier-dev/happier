import * as React from 'react';

import { Item } from '@/components/ui/lists/Item';
import { buildAccessChannelLimitationCopyKey } from '@/sync/domains/accessEndpoints/channels/copy';
import type { AccessChannel } from '@/sync/domains/accessEndpoints/channels/model';
import { t } from '@/text';

export type AccessEndpointTradeoffListProps = Readonly<{
    channel: AccessChannel;
    testID: string;
}>;

export const AccessEndpointTradeoffList = React.memo(function AccessEndpointTradeoffList(props: AccessEndpointTradeoffListProps) {
    return (
        <>
            {props.channel.limitations.map((limitation) => (
                <Item
                    key={limitation.id}
                    testID={`${props.testID}.limitation.${limitation.reason}`}
                    title={t(buildAccessChannelLimitationCopyKey(limitation))}
                    showChevron={false}
                    mode="info"
                    density="compact"
                />
            ))}
        </>
    );
});
