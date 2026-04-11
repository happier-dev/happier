import * as React from 'react';
import { View } from 'react-native';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SessionRetentionNotice } from '@/components/sessions/info/SessionRetentionNotice';
import { t } from '@/text';

export function SessionUsageDrilldownFrame(props: Readonly<{ sessionId: string }>): React.ReactElement {
    return (
        <View testID="usage-session-drilldown">
            <ItemGroup title={t('usage.sessionUsage')}>
                <Item
                    title={props.sessionId}
                    subtitle={t('usage.sessionUsage')}
                    showChevron={false}
                />
            </ItemGroup>
            <SessionRetentionNotice sessionId={props.sessionId} />
        </View>
    );
}
