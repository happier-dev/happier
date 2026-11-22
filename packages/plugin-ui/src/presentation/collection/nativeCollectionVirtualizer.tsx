import { Fragment, useCallback, useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import { FlatList, Platform, SectionList, type FlatListProps, type ListRenderItemInfo, type NativeScrollEvent, type NativeSyntheticEvent, type SectionListRenderItemInfo } from 'react-native';

import { useContainingHappierMaterialRole } from '../layout/Surface.js';
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
  const host = useOptionalPluginUiPresentationHost();
  const createTracker = host?.createScrollActivityTracker;
  const renderScrollRoot = host?.renderCollectionScrollRoot;
  const inheritedTracker = useOptionalPluginUiScrollActivityTracker();
  const scrollRef = useMemo<RefObject<unknown>>(() => ({
    get current() { return sectioned ? grouped.current?.getScrollResponder() : flat.current?.getScrollResponder(); },
  }), [sectioned]);
  // Collection already requests physical scroll metrics; a plain List need not add an event stream.
  const observesScroll = request.onScroll !== undefined;
  const tracker = useMemo(() => Platform.OS === 'web' || !observesScroll ? null : createTracker?.(scrollRef, false) ?? null,
    [createTracker, observesScroll, scrollRef]);
  const getScrollNode = useCallback(() => (sectioned ? grouped.current : flat.current)?.getScrollableNode() ?? null, [sectioned]);
  const pendingReveal = useRef<{
    key: string;
    failed: boolean;
  } | null>(null);
  const requestRef = useRef(request);
  requestRef.current = request;
  const handle = useMemo<CollectionVirtualizerHandle>(() => ({
    reveal: (location) => {
      const { index, sectionIndex } = location;
      const current = requestRef.current;
      const item = current.kind === 'sections' ? current.sections[sectionIndex ?? 0]?.data[index] : current.items[index];
      if (item === undefined) { pendingReveal.current = null; return; }
      const attempt = { key: current.keyForItem(item, index), failed: false };
      pendingReveal.current = attempt;
      if (sectioned) {
        grouped.current?.scrollToLocation({ sectionIndex: sectionIndex ?? 0, itemIndex: index, animated: false, viewPosition: 0.5 });
      } else {
        flat.current?.scrollToIndex({ index, animated: false, viewPosition: 0.5 });
      }
      // Both native virtualizers report an unmeasured index synchronously.
      if (!attempt.failed) pendingReveal.current = null;
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
  // RNW truncates the unmeasured tail spacer. Its list footer can therefore appear at the end
  // of the measured window and move while the reader is trying to press it. The last section's
  // footer is a real virtualized cell after all its rows.
  const lastWebSection = Platform.OS === 'web' ? sections?.at(-1) : undefined;
  const endContent = request.endContent;
  const renderSectionFooter = useCallback(({ section }: Readonly<{ section: Readonly<{ key: string }> }>) =>
    section === lastWebSection ? <>{endContent}</> : null, [endContent, lastWebSection]);
  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    tracker?.onScroll(event);
    request.onScroll?.(event.nativeEvent.contentOffset.y);
  }, [request.onScroll, tracker]);
  const onContentSizeChange = useCallback((width: number, height: number) => {
    tracker?.onContentSizeChange(width, height);
    request.onContentSizeChange?.(width, height);
    const pending = pendingReveal.current;
    if (!pending?.failed) return;
    // Measurement may arrive after filtering, sorting or regrouping. Retain the
    // row's identity, never the position it occupied in the previous window.
    const current = requestRef.current;
    if (current.kind === 'sections') {
      for (const [sectionIndex, section] of current.sections.entries()) {
        const index = section.data.findIndex((item, index) => current.keyForItem(item, index) === pending.key);
        if (index !== -1) { handle.reveal({ sectionIndex, index }); return; }
      }
    } else {
      const index = current.items.findIndex((item, index) => current.keyForItem(item, index) === pending.key);
      if (index !== -1) { handle.reveal({ index }); return; }
    }
    pendingReveal.current = null;
  }, [handle, request.onContentSizeChange, tracker]);
  const renderItem = request.renderItem;
  const renderFlatItem = useCallback(({ item, index }: ListRenderItemInfo<Item>) => (
    <>{renderItem(item, index, null)}</>
  ), [renderItem]);
  const renderGroupedItem = useCallback(({ item, index, section }: SectionListRenderItemInfo<Item, Readonly<{ key: string }>>) => (
    <>{renderItem(item, index, sectionIndices.get(section) ?? 0)}</>
  ), [renderItem, sectionIndices]);
  // A heading stays pinned only where it can paint its ground: a translucent material (a glass dialog) owns its
  // plane, so there the heading scrolls with its rows rather than letting them print through it.
  const stickyHeaders = useContainingHappierMaterialRole() === undefined;
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
    // Keep overscan below the platform default; mounted work is characterized
    // against collection size, including the platform's retained initial batch.
    windowSize: 3,
    ListFooterComponent: endContent === undefined || lastWebSection !== undefined ? undefined : <>{endContent}</>,
    maintainVisibleContentPosition: request.preserveVisibleContentPositionOnPrepend && Platform.OS !== 'web'
      ? { minIndexForVisible: 0 } : undefined,
    onScroll: request.onScroll === undefined ? undefined : onScroll,
    scrollEventThrottle: request.onScroll === undefined ? undefined : SCROLL_EVENT_THROTTLE_MS,
    onLayout: tracker?.onLayout,
    onContentSizeChange,
    // Approach an unmeasured cell using the platform's measured average. The
    // initial average can be zero, so content measurement finishes the reveal.
    // List still owns physical focus until that row publishes its target.
    onScrollToIndexFailed: (info: Readonly<{ averageItemLength: number; index: number }>) => {
      if (pendingReveal.current !== null) pendingReveal.current.failed = true;
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
      stickySectionHeadersEnabled={stickyHeaders}
      renderItem={renderGroupedItem}
      renderSectionHeader={renderSectionHeader}
      renderSectionFooter={lastWebSection === undefined || endContent === undefined ? undefined : renderSectionFooter}
    />
  ) : (
    <FlatList<Item> {...props} ref={flat} data={request.items}
      // @ts-expect-error RN's role union omits RNW's standard listbox role.
      role={request.role} renderItem={renderFlatItem} />
  );
  // Keep the row tree stable when scroll demand changes, preserving the inherited context where it already applied.
  const content = <PluginUiScrollActivityProvider tracker={tracker ?? inheritedTracker}>{list}</PluginUiScrollActivityProvider>;
  // This list is its rows' one vertical scroller: a disclosed diff windows against it (QB-81). A flat/grouped switch
  // mounts a new scroller, so the scope that binds it is keyed with it.
  return renderScrollRoot === undefined ? content
    : <Fragment key={request.kind}>{renderScrollRoot({ getScrollNode, children: content })}</Fragment>;
}

/** @internal The incumbent RN/RNW fallback, consumed through the same injected interface. */
export const NATIVE_COLLECTION_VIRTUALIZER: CollectionVirtualizer = {
  render: (request) => <NativeCollectionVirtualizer request={request} />,
};
