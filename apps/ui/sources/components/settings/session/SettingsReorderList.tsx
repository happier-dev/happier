import * as React from 'react';
import {
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSharedValue } from 'react-native-reanimated';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { VirtualizedItemList } from '@/components/ui/lists/VirtualizedItemList';
import type { VirtualizedListRef } from '@/components/ui/lists/virtualized';
import {
  EntityFlatReorderList,
  EntityFlatReorderRow,
  type EntityFlatReorderBinding,
} from '@/components/ui/treeDragDrop/ui/EntityFlatReorder';

/**
 * A Settings page whose rows are a person's ordered collection (Manage spaces, Sections): the page header
 * scrolls with a virtualized, drag/keyboard/chooser-reorderable list. Rows and their actions belong to the page.
 */
export function SettingsReorderList<TItem extends Readonly<{ id: string }>>(
  props: Readonly<{
    testID: string;
    items: readonly TItem[];
    reorder: EntityFlatReorderBinding;
    header: React.ReactNode;
    /** Rendered after the organize control. */
    footer?: React.ReactNode;
    /** A row whose open form or menu anchors to it stays mounted while scrolled away. */
    retainedId?: string | null;
    renderRow(
      item: TItem,
      renderHandle: (testID: string) => React.ReactNode,
    ): React.ReactElement;
    /** Wraps the first row (or the empty list) in the page's search anchor. */
    wrapItems(children: React.ReactElement): React.ReactElement;
    overlay?: React.ReactNode;
  }>,
) {
  const listRef = React.useRef<VirtualizedListRef | null>(null);
  const offsetY = useSharedValue(0);
  const contentHeight = useSharedValue(0);
  const scrollMetrics = React.useMemo(
    () => ({ offsetY, contentHeight }),
    [offsetY, contentHeight],
  );
  const onScroll = React.useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      offsetY.value = event.nativeEvent.contentOffset.y;
      contentHeight.value = event.nativeEvent.contentSize.height;
    },
    [offsetY, contentHeight],
  );
  const onContentSizeChange = React.useCallback(
    (_width: number, height: number) => {
      contentHeight.value = height;
    },
    [contentHeight],
  );
  const onScrollToOffset = React.useCallback((offset: number) => {
    void listRef.current?.scrollToOffset({ offset, animated: false });
  }, []);
  const itemsById = React.useMemo(
    () => new Map(props.items.map((item) => [item.id, item])),
    [props.items],
  );
  return (
    <View style={FILL_STYLE}>
      <EntityFlatReorderList
        binding={props.reorder}
        testID={`${props.testID}.reorder`}
        fill
        scrollRef={listRef}
        scrollMetrics={scrollMetrics}
        onScrollToOffset={onScrollToOffset}
      >
        {({ order, retainedItemKeys, organizeControl }) => {
          const items = order.flatMap((id) => itemsById.get(id) ?? []);
          // Legend keeps these existing row instances, including their gesture and form anchors, alive.
          const retained =
            props.retainedId &&
            itemsById.has(props.retainedId) &&
            !retainedItemKeys.includes(props.retainedId)
              ? [...retainedItemKeys, props.retainedId]
              : retainedItemKeys;
          return (
            <VirtualizedItemList
              ref={listRef}
              testID={props.testID}
              style={{ paddingTop: 0 }}
              data={items}
              keyExtractor={itemKey}
              estimatedItemSize={56}
              extraData={props.retainedId}
              retainedItemKeys={retained}
              onScroll={onScroll}
              onContentSizeChange={onContentSizeChange}
              ListHeaderComponent={<>{props.header}</>}
              ListFooterComponent={
                <>
                  {organizeControl}
                  {props.footer}
                </>
              }
              ListEmptyComponent={props.wrapItems(
                <ItemGroup>{null}</ItemGroup>,
              )}
              renderItem={({ item, index }) => {
                const row = (
                  <ItemGroup
                    virtualizedSegment={{
                      first: index === 0,
                      last: index === items.length - 1,
                    }}
                  >
                    <EntityFlatReorderRow id={item.id}>
                      {({ renderHandle }) =>
                        props.renderRow(item, renderHandle)
                      }
                    </EntityFlatReorderRow>
                  </ItemGroup>
                );
                return index === 0 ? props.wrapItems(row) : row;
              }}
            />
          );
        }}
      </EntityFlatReorderList>
      {props.overlay}
    </View>
  );
}

const itemKey = (item: Readonly<{ id: string }>) => item.id;
const FILL_STYLE = { flex: 1, minHeight: 0 } as const;
