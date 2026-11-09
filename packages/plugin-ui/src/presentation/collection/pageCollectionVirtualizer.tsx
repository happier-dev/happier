import { Fragment, useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { View } from 'react-native';

import type { CollectionVirtualizerHandle, CollectionVirtualizerRequest } from './collectionVirtualizer.js';
import type { PluginUiScrollActivityTracker } from '../../presentationHost/scrollActivity.js';
import type { HappierLayoutChangeEvent } from '../portableTypes.js';
import { CatalogDirectory } from './CatalogDirectory.js';

/**
 * `directory` is a catalog directory's row-major columns: rows window by line (a line is one cell of up to `columns` rows),
 * and a section with a single row spans its line, exactly as `CatalogDirectory` draws them without windowing.
 */
type PageGeometry = Readonly<{
  rowHeight(key: string): number; headerHeight: number; width: number | null; defaultRowHeight: number;
  directory?: Readonly<{ columns: number; columnGapPx: number; lineTestID?: string }>;
}>;
type Cell<Item> = Readonly<{ key: string; offset: number; height: number; index: number; count: number; columns: number; sectionIndex: number | null; header: boolean; items: readonly Item[]; keys: readonly string[] }>;
const NO_MEASUREMENTS: ReadonlyMap<string, number> = new Map();
function sameMeasuredGeometry(left: PageGeometry, right: PageGeometry) {
  return left.width === right.width && left.headerHeight === right.headerHeight && left.defaultRowHeight === right.defaultRowHeight
    && left.directory?.columns === right.directory?.columns;
}

/** List's positioning adapter for rows inside an already-owned physical page, never another scroller. */
export function PageCollectionVirtualizer<Item>({ request, geometry, tracker, tabStopKey, retainedKeys }: Readonly<{
  request: CollectionVirtualizerRequest<Item>;
  geometry: PageGeometry;
  tracker: PluginUiScrollActivityTracker;
  tabStopKey: string | null;
  /** Rows a live interaction anchors to (a deep link's popover); they stay mounted wherever the viewport is. */
  retainedKeys?: ReadonlySet<string>;
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
    const result: Cell<Item>[] = [];
    let offset = 0;
    const append = (key: string, height: number, index: number, count: number, columns: number, sectionIndex: number | null, header: boolean,
      items: readonly Item[] = [], keys: readonly string[] = []) => {
      const measured = measuredHeights.get(key) ?? height;
      result.push({ key, offset, height: measured, index, count, columns, sectionIndex, header, items, keys });
      offset += measured;
    };
    // A section's rows, one cell each, or one cell per line of the directory's columns.
    const appendRows = (data: readonly Item[], sectionIndex: number | null, qualify: (key: string) => string) => {
      const lineSize = geometry.directory === undefined || data.length < 2 ? 1 : Math.max(1, geometry.directory.columns);
      for (let start = 0; start < data.length; start += lineSize) {
        const items = data.slice(start, start + lineSize);
        const keys = items.map((item, offsetInLine) => request.keyForItem(item, start + offsetInLine));
        append(qualify(keys[0]!), Math.max(...keys.map(key => geometry.rowHeight(key))), start, items.length, lineSize, sectionIndex, false, items, keys);
      }
    };
    if (request.kind === 'flat') {
      appendRows(request.items, null, key => key);
    } else {
      request.sections.forEach((section, sectionIndex) => {
        append(`header:${section.key}`, section.title === '' ? 0 : geometry.headerHeight, -1, 0, 1, sectionIndex, true);
        appendRows(section.data, sectionIndex, key => `${section.key}:${key}`);
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
      const cell = cells.find(cell => !cell.header && location.index >= cell.index && location.index < cell.index + cell.count
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

  const inWindow = (cell: Cell<Item>) => span !== null && window !== null
    && span.top + cell.offset + cell.height >= window.top && span.top + cell.offset <= window.bottom;
  const pinned = (cell: Cell<Item>) => span !== null && window !== null && !cell.header
    && cell.keys.some(key => key === tabStopKey || (retainedKeys?.has(key) ?? false));
  const renderCell = (cell: Cell<Item>) => (
    <View key={cell.key} onLayout={(event: HappierLayoutChangeEvent) => {
      const height = event.nativeEvent.layout.height;
      if (height <= 0 || height === cell.height) return;
      setMeasurements(current => ({ geometry,
        heights: new Map(sameMeasuredGeometry(current.geometry, geometry) ? current.heights : NO_MEASUREMENTS).set(cell.key, height),
      }));
    }}>
      {cell.header && request.kind === 'sections' ? request.renderSectionHeader(cell.sectionIndex!)
        : geometry.directory === undefined ? (cell.items[0] === undefined ? null : request.renderItem(cell.items[0], cell.index, cell.sectionIndex))
        : <CatalogDirectory columns={cell.columns}
            columnGapPx={geometry.directory.columnGapPx} spanLoneRow={false}
            {...(geometry.directory.lineTestID === undefined ? {} : { lineTestID: geometry.directory.lineTestID })}
            rows={cell.items.map((item, at) => <Fragment key={cell.keys[at]}>{request.renderItem(item, cell.index + at, cell.sectionIndex)}</Fragment>)} />}
    </View>
  );
  const spacer = (key: string, height: number) => (
    <View key={key} aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ height }} />
  );

  const content: ReactNode[] = [];
  let renderedEnd = 0;
  const renderSectionRows = request.kind === 'sections' ? request.renderSectionRows : undefined;
  if (renderSectionRows !== undefined) {
    // Each section's sheet is drawn whenever any of its cells is near: the windowed rows and their
    // spacers stand inside it, so the sheet's edges stay at the section's full extent.
    for (const header of cells.filter(cell => cell.header)) {
      const section = cells.filter(cell => cell.sectionIndex === header.sectionIndex);
      const rows = section.filter(cell => !cell.header);
      if (!section.some(cell => inWindow(cell) || pinned(cell))) continue;
      const gap = header.offset - renderedEnd;
      if (gap > 0) content.push(spacer(`gap:${header.key}`, gap));
      const sectionRows: ReactNode[] = [];
      let cursor = rows[0]?.offset ?? header.offset + header.height;
      for (const row of rows) {
        if (!inWindow(row) && !pinned(row)) continue;
        if (row.offset > cursor) sectionRows.push(spacer(`gap:${row.key}`, row.offset - cursor));
        sectionRows.push(renderCell(row));
        cursor = row.offset + row.height;
      }
      const sectionEnd = rows.length === 0 ? cursor : rows[rows.length - 1]!.offset + rows[rows.length - 1]!.height;
      if (sectionEnd > cursor) sectionRows.push(spacer('end', sectionEnd - cursor));
      content.push(
        <Fragment key={header.key}>
          {renderCell(header)}
          {rows.length === 0 ? null : renderSectionRows(header.sectionIndex!, sectionRows)}
        </Fragment>,
      );
      renderedEnd = sectionEnd;
    }
  } else {
    for (const cell of cells) {
      if (!pinned(cell) && !inWindow(cell)) continue;
      const gap = cell.offset - renderedEnd;
      content.push(
        <Fragment key={cell.key}>
          {gap <= 0 ? null : spacer(`gap:${cell.key}`, gap)}
          {renderCell(cell)}
        </Fragment>,
      );
      renderedEnd = cell.offset + cell.height;
    }
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
