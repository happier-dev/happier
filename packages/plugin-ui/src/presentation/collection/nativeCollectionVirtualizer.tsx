import { useCallback, useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import { FlatList, Platform, SectionList, type FlatListProps, type ListRenderItemInfo, type NativeScrollEvent, type NativeSyntheticEvent, type SectionListRenderItemInfo } from 'react-native';

import { useOptionalPluginUiPresentationHost } from '../../presentationHost/context.js';
import { PluginUiScrollActivityProvider, useOptionalPluginUiScrollActivityTracker } from '../../presentationHost/scrollActivity.js';
import type { CollectionVirtualizer, CollectionVirtualizerHandle, CollectionVirtualizerRequest } from './collectionVirtualizer.js';

// RN treats <=16 as unthrottled. The viewport owner needs the latest offset
// before a content-size transition; this is a platform adapter fact.
const SCROLL_EVENT_THROTTLE_MS = 16;

function NativeCollectionVirtualizer<Item>({ request }: Readonly<{ request: CollectionVirtualizerRequest<Item> }>) {
  const flat = useRef<FlatList<Item> | null>(null);
  const grouped = useRef<SectionList<Item, Readonly<{ key: string }>> | null>(null);
  const sectioned = request.kind === 'sections';
  const createTracker = useOptionalPluginUiPresentationHost()?.createScrollActivityTracker;
  const inheritedTracker = useOptionalPluginUiScrollActivityTracker();
  const scrollRef = useMemo<RefObject<unknown>>(() => ({
    get current() { return sectioned ? grouped.current?.getScrollResponder() : flat.current?.getScrollResponder(); },
  }), [sectioned]);
  // Collection already requests physical scroll metrics; a plain List need not add an event stream.
  const observesScroll = request.onScroll !== undefined;
  const tracker = useMemo(() => Platform.OS === 'web' || !observesScroll ? null : createTracker?.(scrollRef, false) ?? null,
    [createTracker, observesScroll, scrollRef]);
  const handle = useMemo<CollectionVirtualizerHandle>(() => ({
    reveal: ({ index, sectionIndex }) => {
      if (sectioned) {
        grouped.current?.scrollToLocation({ sectionIndex: sectionIndex ?? 0, itemIndex: index, animated: false, viewPosition: 0.5 });
      } else {
        flat.current?.scrollToIndex({ index, animated: false, viewPosition: 0.5 });
      }
    },
    scrollToOffset: (offset) => {
      if (sectioned) grouped.current?.getScrollResponder()?.scrollTo({ y: offset, animated: false });
      else flat.current?.scrollToOffset({ offset, animated: false });
    },
    scrollToEnd: () => { flat.current?.scrollToEnd({ animated: false }); },
  }), [sectioned]);
  useLayoutEffect(() => {
    request.onHandle(handle);
    return () => request.onHandle(null);
  }, [handle, request.onHandle]);
  const sections = request.kind === 'sections' ? request.sections : undefined;
  const sectionIndices = useMemo(() => new Map(sections?.map((section, index) => [section, index])), [sections]);
  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    tracker?.onScroll(event);
    request.onScroll?.(event.nativeEvent.contentOffset.y);
  }, [request.onScroll, tracker]);
  const onContentSizeChange = useCallback((width: number, height: number) => {
    tracker?.onContentSizeChange(width, height);
    request.onContentSizeChange?.(width, height);
  }, [request.onContentSizeChange, tracker]);
  const renderItem = request.renderItem;
  const renderFlatItem = useCallback(({ item, index }: ListRenderItemInfo<Item>) => (
    <>{renderItem(item, index, null)}</>
  ), [renderItem]);
  const renderGroupedItem = useCallback(({ item, index, section }: SectionListRenderItemInfo<Item, Readonly<{ key: string }>>) => (
    <>{renderItem(item, index, sectionIndices.get(section) ?? 0)}</>
  ), [renderItem, sectionIndices]);
  const renderHeader = request.kind === 'sections' ? request.renderSectionHeader : undefined;
  const renderSectionHeader = useCallback(({ section }: Readonly<{ section: Readonly<{ key: string; data: readonly Item[] }> }>) => (
    <>{renderHeader?.(sectionIndices.get(section) ?? 0)}</>
  ), [renderHeader, sectionIndices]);
  const props = {
    accessibilityRole: request.accessibilityRole,
    'aria-rowcount': request.role === 'grid' || request.role === 'treegrid' ? request.rowCount : undefined,
    'aria-multiselectable': request.multiSelectable,
    accessibilityCollection: request.nativeCollection,
    accessibilityLabel: request.accessibilityLabel,
    testID: request.testID,
    style: request.style,
    contentContainerStyle: request.contentContainerStyle,
    keyboardShouldPersistTaps: 'handled' as const,
    extraData: request.extraData,
    ListFooterComponent: request.endContent === undefined ? undefined : <>{request.endContent}</>,
    maintainVisibleContentPosition: request.preserveVisibleContentPositionOnPrepend && Platform.OS !== 'web'
      ? { minIndexForVisible: 0 } : undefined,
    onScroll: request.onScroll === undefined ? undefined : onScroll,
    scrollEventThrottle: request.onScroll === undefined ? undefined : SCROLL_EVENT_THROTTLE_MS,
    onLayout: tracker?.onLayout,
    onContentSizeChange: tracker || request.onContentSizeChange ? onContentSizeChange : undefined,
    // Approach an unmeasured cell using the platform's measured average. List
    // retains its focus request until that row publishes its physical target.
    onScrollToIndexFailed: (info: Readonly<{ averageItemLength: number; index: number }>) => {
      handle.scrollToOffset(info.averageItemLength * info.index);
    },
    keyExtractor: request.keyForItem,
  } satisfies Omit<FlatListProps<Item>, 'role' | 'data' | 'renderItem'> & Readonly<{
    'aria-rowcount'?: number;
    'aria-multiselectable'?: boolean;
    accessibilityCollection?: Readonly<{ rowCount: number; columnCount: number }>;
  }>;
  const list = request.kind === 'sections' ? (
    <SectionList<Item, Readonly<{ key: string }>>
      {...props}
      // @ts-expect-error RN's role union omits RNW's standard listbox role.
      role={request.role}
      ref={grouped}
      sections={request.sections}
      stickySectionHeadersEnabled
      renderItem={renderGroupedItem}
      renderSectionHeader={renderSectionHeader}
    />
  ) : (
    <FlatList<Item> {...props} ref={flat} data={request.items}
      // @ts-expect-error RN's role union omits RNW's standard listbox role.
      role={request.role} renderItem={renderFlatItem} />
  );
  // Keep the row tree stable when scroll demand changes, preserving the inherited context where it already applied.
  return <PluginUiScrollActivityProvider tracker={tracker ?? inheritedTracker}>{list}</PluginUiScrollActivityProvider>;
}

/** @internal The incumbent RN/RNW fallback, consumed through the same injected interface. */
export const NATIVE_COLLECTION_VIRTUALIZER: CollectionVirtualizer = {
  render: (request) => <NativeCollectionVirtualizer request={request} />,
};
