import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { HappierCollectionListMark } from '@happier-dev/plugin-ui/presentation';

import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';

import { collectionListStyles } from './CollectionList';

/**
 * A rail's first row: the collection's Overview, one name in every collection. It is selected at the
 * collection's root route, where the Overview stands beside the list, and opens that root from any item.
 * One drawing for every settings collection, so each index row has the same mark, inset and selection.
 */
export const CollectionIndexRow = React.memo(function CollectionIndexRow(props: Readonly<{
    testID: string;
    /** A quiet fact at the row's end (what needs a look). */
    detail?: string;
    selected: boolean;
    onPress: () => void;
} & (
    | { icon?: undefined; title?: undefined }
    /** A pinned destination beside the Overview (Skills: Updates) has its own name and glyph. */
    | { icon: IconName; title: string }
)>) {
    const { theme } = useUnistyles();
    return (
        <Item
            testID={props.testID}
            title={props.icon ? props.title : t('settings.overview')}
            detail={props.detail}
            icon={(
                <HappierCollectionListMark>
                    <Icon name={props.icon ?? 'squares-four'} size={20} color={theme.colors.text.secondary} />
                </HappierCollectionListMark>
            )}
            selected={props.selected}
            density="compact"
            showChevron={false}
            pressableStyle={collectionListStyles.row}
            onPress={props.onPress}
        />
    );
});
