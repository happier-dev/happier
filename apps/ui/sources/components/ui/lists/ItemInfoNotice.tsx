import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Icon } from '@/components/ui/icons/Icon';

type ItemInfoNoticeProps = Readonly<{
    testID?: string;
    title: string;
    body: string;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        backgroundColor: theme.colors.surface.elevated,
    },
}));

export function ItemInfoNotice(props: ItemInfoNoticeProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    return (
        <ItemGroup containerStyle={styles.container}>
            <Item
                testID={props.testID}
                title={props.title}
                subtitle={props.body}
                subtitleLines={0}
                icon={(
                    <React.Fragment>
                        <Icon name="info" size={20} color={theme.colors.text.secondary} />
                    </React.Fragment>
                )}
                mode="info"
                showChevron={false}
            />
        </ItemGroup>
    );
}
