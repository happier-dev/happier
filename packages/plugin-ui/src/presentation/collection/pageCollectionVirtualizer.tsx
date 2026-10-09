import { Fragment, useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { View } from 'react-native';

import type { CollectionVirtualizerHandle, CollectionVirtualizerRequest } from './collectionVirtualizer.js';
import type { PluginUiScrollActivityTracker } from '../../presentationHost/scrollActivity.js';
import type { HappierLayoutChangeEvent } from '../portableTypes.js';

type PageGeometry = Readonly<{ rowHeight(key: string): number; headerHeight: number; width: number | null; defaultRowHeight: number }>;
const NO_MEASUREMENTS: ReadonlyMap<string, number> = new Map();
function sameMeasuredGeometry(left: PageGeometry, right: PageGeometry) {
  return left.width === right.width && left.headerHeight === right.headerHeight && left.defaultRowHeight === right.defaultRowHeight;
}

/** List's positioning adapter for rows inside an already-owned physical page, never another scroller. */
export function PageCollectionVirtualizer<Item>({ request, geometry, tracker, tabStopKey }: Readonly<{
  request: CollectionVirtualizerRequest<Item>;
  geometry: PageGeometry;
  tracker: PluginUiScrollActivityTracker;
  tabStopKey: string | null;
}>) {
  const root = useRef<View | null>(null);
  const [span, setSpan] = useState<Readonly<{ top: number }> | null>(null);
  const [measurements, setMeasurements] = useState<Readonly<{ geometry: PageGeometry; heights: ReadonlyMap<string, number> }>>(
    () => ({ geometry, heights: NO_MEASUREMENTS }),
  );
  // Recomposition and text scaling change the owning geometry; old cell measurements no longer describe it.
  const measuredHeights = sameMeasuredGeometry(measurements.geometry, geometry) ? measurements.heights : NO_MEASUREMENTS;
  const window = useSyncExternalStore(tracker.subscribe, tracker.getWindow, tracker.getWindow);
  const revision = useSyncExternalStore(tracker.subscribe, tracker.getLayoutRevision, tracker.getLayoutRevision);
  const measure = useCallback(async () => {
    const node = root.current;
    const measured = await tracker.measureSpan(node);
    if (node !== root.current || measured === null) return;
    setSpan(current => current?.top === measured.top ? current : measured);
  }, [tracker]);
  useLayoutEffect(() => { void measure(); }, [measure, revision]);
  const cells = useMemo(() => {
    const result: Array<Readonly<{ key: string; offset: number; height: number; index: number; sectionIndex: number | null; header: boolean; item?: Item }>> = [];
    let offset = 0;
    const append = (key: string, height: number, index: number, sectionIndex: number | null, header: boolean, item?: Item) => {
      const measured = measuredHeights.get(key) ?? height;
      result.push({ key, offset, height: measured, index, sectionIndex, header, item });
      offset += measured;
    };
    if (request.kind === 'flat') {
      request.items.forEach((item, index) => {
        const key = request.keyForItem(item, index);
        append(key, geometry.rowHeight(key), index, null, false, item);
      });
    } else {
      request.sections.forEach((section, sectionIndex) => {
        append(`header:${section.key}`, geometry.headerHeight, -1, sectionIndex, true);
        section.data.forEach((item, index) => {
          const key = request.keyForItem(item, index);
          append(`${section.key}:${key}`, geometry.rowHeight(key), index, sectionIndex, false, item);
        });
      });
    }
    return result;
  }, [geometry, measuredHeights, request.kind, request.kind === 'flat' ? request.items : request.sections, request.keyForItem]);
  const totalHeight = cells.length === 0 ? 0 : cells[cells.length - 1]!.offset + cells[cells.length - 1]!.height;
  const position = useCallback((offset: number) => {
    if (span !== null) tracker.scrollToOffset?.(Math.max(0, span.top + offset));
  }, [span, tracker]);
  const handle = useMemo<CollectionVirtualizerHandle>(() => ({
    reveal: location => {
      const cell = cells.find(cell => !cell.header && cell.index === location.index
        && cell.sectionIndex === (location.sectionIndex ?? null));
      if (cell !== undefined) position(cell.offset);
    },
    scrollToOffset: position,
    scrollToEnd: () => position([...cells].reverse().find(cell => !cell.header)?.offset ?? 0),
  }), [cells, position]);
  useLayoutEffect(() => {
    request.onHandle(handle);
    return () => request.onHandle(null);
  }, [handle, request.onHandle]);

  const content: ReactNode[] = [];
  let renderedEnd = 0;
  for (const cell of cells) {
    const pinned = !cell.header && cell.item !== undefined && request.keyForItem(cell.item, cell.index) === tabStopKey;
    const inWindow = span !== null && window !== null
      && span.top + cell.offset + cell.height >= window.top && span.top + cell.offset <= window.bottom;
    if (!pinned && !inWindow) continue;
    const gap = cell.offset - renderedEnd;
    content.push(
      <Fragment key={cell.key}>
        {gap <= 0 ? null : <View aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ height: gap }} />}
        <View onLayout={(event: HappierLayoutChangeEvent) => {
          const height = event.nativeEvent.layout.height;
          if (height <= 0 || height === cell.height) return;
          setMeasurements(current => ({ geometry,
            heights: new Map(sameMeasuredGeometry(current.geometry, geometry) ? current.heights : NO_MEASUREMENTS).set(cell.key, height),
          }));
        }}>
          {cell.header && request.kind === 'sections' ? request.renderSectionHeader(cell.sectionIndex!)
            : cell.item === undefined ? null : request.renderItem(cell.item, cell.index, cell.sectionIndex)}
        </View>
      </Fragment>,
    );
    renderedEnd = cell.offset + cell.height;
  }
  return (
    <View ref={root} onLayout={() => { void measure(); }}
      accessibilityRole={request.accessibilityRole}
      // @ts-expect-error RN's role union omits RNW's standard listbox role.
      role={request.role}
      aria-rowcount={request.rowCount} aria-multiselectable={request.multiSelectable}
      accessibilityCollection={request.nativeCollection} accessibilityLabel={request.accessibilityLabel}
      testID={request.testID} style={[request.style, request.contentContainerStyle]}>
      {content}
      {totalHeight <= renderedEnd ? null : <View aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ height: totalHeight - renderedEnd }} />}
      {request.endContent}
    </View>
  );
}
