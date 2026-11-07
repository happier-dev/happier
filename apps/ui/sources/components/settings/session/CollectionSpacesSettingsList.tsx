import * as React from 'react';
import { View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { useSharedValue } from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { VirtualizedItemList } from '@/components/ui/lists/VirtualizedItemList';
import type { VirtualizedListRef } from '@/components/ui/lists/virtualized';
import { CollectionSpaceIcon } from '@/components/ui/lists/collection/CollectionSpaceIcon';
import { EntityFlatReorderList, EntityFlatReorderRow, type EntityFlatReorderBinding } from '@/components/ui/treeDragDrop/ui/EntityFlatReorder';
import { t } from '@/text';

type SpaceRow = Readonly<{ id: string; name: string; icon: React.ComponentProps<typeof CollectionSpaceIcon>['icon'] }>;

/** The Manage spaces page's list presentation; editing and persistence stay with their existing owners. */
export function CollectionSpacesSettingsList(props: Readonly<{
    spaces: readonly SpaceRow[];
    reorder: EntityFlatReorderBinding;
    header: React.ReactNode;
    editingId: string | null;
    anchorRef: React.RefObject<View | null>;
    onEdit(id: string): void;
    wrapSpaces(children: React.ReactElement): React.ReactElement;
    overlay?: React.ReactNode;
}>) {
    const { theme } = useUnistyles();
    const listRef = React.useRef<VirtualizedListRef | null>(null);
    const offsetY = useSharedValue(0);
    const contentHeight = useSharedValue(0);
    const scrollMetrics = React.useMemo(() => ({ offsetY, contentHeight }), [offsetY, contentHeight]);
    const onScroll = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        offsetY.value = event.nativeEvent.contentOffset.y;
        contentHeight.value = event.nativeEvent.contentSize.height;
    }, [offsetY, contentHeight]);
    const onContentSizeChange = React.useCallback((_width: number, height: number) => {
        contentHeight.value = height;
    }, [contentHeight]);
    const onScrollToOffset = React.useCallback((offset: number) => {
        void listRef.current?.scrollToOffset({ offset, animated: false });
    }, []);
    const spacesById = React.useMemo(() => new Map(props.spaces.map(space => [space.id, space])), [props.spaces]);
    return <View style={FILL_STYLE}>
        <EntityFlatReorderList binding={props.reorder} testID="collection-spaces-settings.reorder" fill
            scrollRef={listRef} scrollMetrics={scrollMetrics} onScrollToOffset={onScrollToOffset}>
            {({ order, retainedItemKeys, organizeControl }) => {
                const spaces = order.map(id => spacesById.get(id)!);
                // Legend keeps these existing row instances, including their gesture and form anchors, alive.
                const retained = props.editingId && spacesById.has(props.editingId) && !retainedItemKeys.includes(props.editingId)
                    ? [...retainedItemKeys, props.editingId] : retainedItemKeys;
                return <VirtualizedItemList ref={listRef} testID="collection-spaces-settings" style={{ paddingTop: 0 }}
                    data={spaces} keyExtractor={spaceKey} estimatedItemSize={56} extraData={props.editingId}
                    retainedItemKeys={retained} onScroll={onScroll} onContentSizeChange={onContentSizeChange}
                    ListHeaderComponent={<>{props.header}</>} ListFooterComponent={<>{organizeControl}</>}
                    ListEmptyComponent={props.wrapSpaces(<ItemGroup>{null}</ItemGroup>)}
                    renderItem={({ item: space, index }) => {
                        const row = <ItemGroup virtualizedSegment={{ first: index === 0, last: index === spaces.length - 1 }}>
                            <EntityFlatReorderRow id={space.id}>
                                {({ renderHandle }) => <View ref={space.id === props.editingId ? props.anchorRef : undefined} collapsable={false}>
                                    <Item testID={`collection-spaces-settings:${space.id}`} title={space.name}
                                        leftElement={<View style={LEADING_STYLE}>
                                            {renderHandle(`collection-spaces-settings.move:${space.id}`)}
                                            <CollectionSpaceIcon icon={space.icon} size={ICON_SIZE.md} color={theme.colors.text.secondary} />
                                        </View>}
                                        showChevron={false}
                                        rightElement={<IconButton testID={`collection-spaces-settings.edit:${space.id}`}
                                            accessibilityLabel={t('sessionsList.spacesEditNamed', { name: space.name })}
                                            tooltip={t('sessionsList.spacesEdit')} variant="plain" iconName="pencil-simple" iconSize={ICON_SIZE.sm}
                                            onPress={() => props.onEdit(space.id)} />}
                                    />
                                </View>}
                            </EntityFlatReorderRow>
                        </ItemGroup>;
                        return index === 0 ? props.wrapSpaces(row) : row;
                    }} />;
            }}
        </EntityFlatReorderList>
        {props.overlay}
    </View>;
}

const spaceKey = (space: SpaceRow) => space.id;
const FILL_STYLE = { flex: 1, minHeight: 0 } as const;
const LEADING_STYLE = { flexDirection: 'row', alignItems: 'center' } as const;
