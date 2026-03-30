import * as React from 'react';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';

export const DesktopOnlySetupNotice = React.memo(function DesktopOnlySetupNotice(props: Readonly<{
    groupTitle: string;
    subtitle: string;
    testID: string;
    title: string;
}>) {
    return (
        <ItemGroup title={props.groupTitle}>
            <Item
                testID={props.testID}
                title={props.title}
                subtitle={props.subtitle}
                showChevron={false}
                mode="info"
            />
        </ItemGroup>
    );
});
