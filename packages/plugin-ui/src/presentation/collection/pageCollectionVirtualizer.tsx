import { Fragment, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { View } from 'react-native';

import type { CollectionVirtualizerHandle, CollectionVirtualizerRequest } from './collectionVirtualizer.js';
import {
  HappierRetainedScrollAnchorContextInternal,
  HappierRetainedScrollContextInternal,
  type HappierRetainedScrollAnchorReaderInternal,
  type PluginUiScrollActivityTracker,
} from '../../presentationHost/scrollActivity.js';
import { useOptionalHappierTabPanelActivityInternal } from '../navigation/Tabs.js';
import type { HappierLayoutChangeEvent } from '../portableTypes.js';
import { CatalogDirectory } from './CatalogDirectory.js';

/**
 * `directory` is a catalog directory's row-major columns: rows window by line (a line is one cell of up to `columns` rows),
 * and a section with a single row spans its line, exactly as `CatalogDirectory` draws them without windowing.
 */
export type PageCollectionGeometry = Readonly<{
  rowHeight(key: string): number; headerHeight: number; width: number | null; defaultRowHeight: number;
  rowGapPx?: number;
  directory?: Readonly<{ columns: number; columnGapPx: number; lineTestID?: string }>;
}>;
/**
 * `unit`: the cells drawn together whenever any of them is near, around one sheet (a section's, a part's, or the flat
 * list's); null for a cell that windows alone. `inSheet`: the cell stands inside that sheet (its rows, a part's
 * sub-headings), not before it (its heading). `part`: the heading of a part's shared sheet.
 */
type Cell<Item> = Readonly<{
  key: string; offset: number; height: number; index: number; count: number; columns: number; sectionIndex: number | null;
  header: boolean; part: boolean; unit: string | null; inSheet: boolean; items: readonly Item[]; keys: readonly string[]; gap?: number;
}>;
const NO_MEASUREMENTS: ReadonlyMap<string, number> = new Map();
const subscribeWhileHidden = () => () => {};
function sameMeasuredGeometry(left: PageCollectionGeometry, right: PageCollectionGeometry) {
  return left.width === right.width && left.headerHeight === right.headerHeight && left.defaultRowHeight === right.defaultRowHeight
    && left.directory?.columns === right.directory?.columns && left.rowGapPx === right.rowGapPx;
}

/**
 * Where a windowed block stands in its owning physical page, and that page's window: the block's top is measured
 * again after every page layout change. Shared by the page List and the page grid, so both window the same way:
 * `near` says whether a part of the block (its offset and height in the block) is in the window. Before the page
 * has placed the block, it stands at the page's top, so the first window paints at once; without a window, every
 * part is near.
 */
export function usePageWindow(tracker: PluginUiScrollActivityTracker, presented = true) {
  const root = useRef<View | null>(null);
  const [span, setSpan] = useState<Readonly<{ top: number }> | null>(null);
  const lastWindow = useRef<ReturnType<PluginUiScrollActivityTracker['getWindow']>>(null);
  const active = useRef(presented);
  const readLastWindow = useCallback(() => lastWindow.current, []);
  const readHiddenRevision = useCallback(() => 0, []);
  const subscribe = presented ? tracker.subscribe : subscribeWhileHidden;
  const readWindow = presented ? tracker.getWindow : readLastWindow;
  const readRevision = presented ? tracker.getLayoutRevision : readHiddenRevision;
  const window = useSyncExternalStore(subscribe, readWindow, readWindow);
  const revision = useSyncExternalStore(subscribe, readRevision, readRevision);
  useLayoutEffect(() => {
    active.current = presented;
    if (presented) lastWindow.current = window;
  }, [presented, window]);
  const measure = useCallback(async () => {
    if (!active.current) return;
    const node = root.current;
    const measured = await tracker.measureSpan(node);
    if (!active.current || node !== root.current || measured === null) return;
    setSpan(current => current?.top === measured.top ? current : measured);
  }, [tracker]);
  useLayoutEffect(() => { if (presented) void measure(); }, [measure, presented, revision]);
  const top = span?.top ?? 0;
  const near = (offset: number, height: number) => window === null || (top + offset + height >= window.top && top + offset <= window.bottom);
  return { root, span, window, measure, near };
}

type PageRowAnchor = Readonly<{ key: string; inset: number }>;
type PageCollectionLayout<Item> = Readonly<{ top: number; cells: readonly Cell<Item>[] }>;

function readRowAnchor<Item>(layout: PageCollectionLayout<Item>, offset: number): PageRowAnchor | undefined {
  const { cells, top } = layout;
  const at = offset - top;
  if (at < 0) return undefined;
  // The first cell whose trailing edge is below the viewport's top.
  let start = 0;
  let end = cells.length;
  while (start < end) {
    const middle = (start + end) >>> 1;
    const cell = cells[middle]!;
    if (cell.offset + cell.height <= at) start = middle + 1;
    else end = middle;
  }
  const cell = cells[start];
  const key = cell?.keys[0];
  return cell === undefined || key === undefined ? undefined : { key, inset: at - cell.offset };
}

function resolveRowAnchor<Item>(layout: PageCollectionLayout<Item>, anchor: PageRowAnchor): number | undefined {
  const cell = layout.cells.find(cell => cell.keys.includes(anchor.key));
  return cell === undefined ? undefined : Math.max(0, layout.top + cell.offset + anchor.inset);
}

type PageCollectionVirtualizerProps<Item> = Readonly<{
  request: CollectionVirtualizerRequest<Item>;
  geometry: PageCollectionGeometry;
  tracker: PluginUiScrollActivityTracker;
  tabStopKey: string | null;
  /** Rows a live interaction anchors to (a deep link's popover); they stay mounted wherever the viewport is. */
  retainedKeys?: ReadonlySet<string>;
}>;

/** List's positioning adapter for rows inside an already-owned physical page, never another scroller. */
export function PageCollectionVirtualizer<Item>(props: PageCollectionVirtualizerProps<Item>) {
  const presented = useOptionalHappierTabPanelActivityInternal()?.active !== false;
  const lastPresented = useRef(props);
  useLayoutEffect(() => { if (presented) lastPresented.current = props; }, [presented, props]);
  const content = presented ? props : lastPresented.current;
  return useMemo(() => <PageCollectionWindow {...content} presented={presented} />, [content, presented]);
}

function PageCollectionWindow<Item>({ request, geometry, tracker, tabStopKey, retainedKeys, presented }:
  PageCollectionVirtualizerProps<Item> & Readonly<{ presented: boolean }>) {
  const { root, span, measure, near } = usePageWindow(tracker, presented);
  const scroller = useContext(HappierRetainedScrollContextInternal);
  const scroll = scroller?.tracker === tracker ? scroller : null;
  const anchors = useContext(HappierRetainedScrollAnchorContextInternal);
  const [measurements, setMeasurements] = useState<Readonly<{ geometry: PageCollectionGeometry; heights: ReadonlyMap<string, number> }>>(
    () => ({ geometry, heights: NO_MEASUREMENTS }),
  );
  // Recomposition and text scaling change the owning geometry; old cell measurements no longer describe it.
  const measuredHeights = sameMeasuredGeometry(measurements.geometry, geometry) ? measurements.heights : NO_MEASUREMENTS;
  const cells = useMemo(() => {
    const result: Cell<Item>[] = [];
    let offset = 0;
    const append = (cell: Omit<Cell<Item>, 'offset' | 'height'>, height: number) => {
      const measured = measuredHeights.get(cell.key) ?? height;
      result.push({ ...cell, offset, height: measured });
      offset += measured;
    };
    const heading = (key: string, sectionIndex: number, part: boolean, unit: string | null, inSheet: boolean) => ({
      key, index: -1, count: 0, columns: 1, sectionIndex, header: true, part, unit, inSheet, items: [], keys: [],
    });
    // A section's rows, one cell each, or one cell per line of the directory's columns.
    const appendRows = (data: readonly Item[], sectionIndex: number | null, qualify: (key: string) => string, unit: string | null) => {
      const lineSize = geometry.directory === undefined || data.length < 2 ? 1 : Math.max(1, geometry.directory.columns);
      for (let start = 0; start < data.length; start += lineSize) {
        const items = data.slice(start, start + lineSize);
        const keys = items.map((item, offsetInLine) => request.keyForItem(item, start + offsetInLine));
        const gap = start + lineSize < data.length ? geometry.rowGapPx ?? 0 : 0;
        append({ key: qualify(keys[0]!), index: start, count: items.length, columns: lineSize, sectionIndex, header: false, part: false,
          unit, inSheet: unit !== null, items, keys, gap }, Math.max(...keys.map(key => geometry.rowHeight(key))) + gap);
      }
    };
    if (request.kind === 'flat') {
      appendRows(request.items, null, key => key, request.renderRows === undefined ? null : 'sheet');
    } else {
      const sheets = request.renderSectionRows !== undefined;
      let partUnit: string | null = null;
      request.sections.forEach((section, sectionIndex) => {
        const part = sheets ? section.section : undefined;
        if (part === undefined) {
          partUnit = null;
        } else if (partUnit === null || request.sections[sectionIndex - 1]?.section?.key !== part.key) {
          // A part's run of sections: its heading, then each group's sub-heading and rows on its one sheet.
          partUnit = `part:${part.key}:${section.key}`;
          append(heading(partUnit, sectionIndex, true, partUnit, false), part.title === '' ? 0 : geometry.headerHeight);
        }
        const unit = partUnit ?? (sheets ? `section:${section.key}` : null);
        append(heading(`header:${section.key}`, sectionIndex, false, unit, partUnit !== null), section.title === '' ? 0 : geometry.headerHeight);
        appendRows(section.data, sectionIndex, key => `${section.key}:${key}`, unit);
      });
    }
    return result;
  }, [geometry, measuredHeights, request.kind, request.kind === 'flat' ? request.items : request.sections, request.keyForItem,
    request.kind === 'flat' ? request.renderRows === undefined : request.renderSectionRows === undefined]);
  const totalHeight = cells.length === 0 ? 0 : cells[cells.length - 1]!.offset + cells[cells.length - 1]!.height;
  const lastLayout = useRef<PageCollectionLayout<Item> | null>(null);
  const wasPresented = useRef(false);
  const captureAnchor = useCallback<HappierRetainedScrollAnchorReaderInternal>(offset => {
    const previous = lastLayout.current;
    const anchor = previous === null ? undefined : readRowAnchor(previous, offset);
    if (anchor === undefined) return undefined;
    return () => lastLayout.current === null ? undefined : resolveRowAnchor(lastLayout.current, anchor);
  }, []);
  useLayoutEffect(() => {
    if (anchors === null || anchors.scroll !== scroll) return;
    anchors.readers.add(captureAnchor);
    return () => {
      anchors.readers.delete(captureAnchor);
      lastLayout.current = null;
    };
  }, [anchors, captureAnchor, scroll]);
  const scrollToOffset = scroll?.scrollToOffset ?? tracker.scrollToOffset;
  const top = span?.top;
  useLayoutEffect(() => {
    const continuous = wasPresented.current;
    wasPresented.current = presented;
    if (!presented || top === undefined) return;
    const previous = lastLayout.current;
    const layout = { top, cells };
    lastLayout.current = layout;
    // A returning panel restores the anchor it saved on leave, independent of the outgoing tab's scroll.
    if (!continuous || previous === null || (previous.cells === cells && previous.top === top)) return;
    const offset = scroll?.readOffset() ?? tracker.getVisibleWindow?.()?.top;
    if (offset === undefined) return;
    const anchor = readRowAnchor(previous, offset);
    const target = anchor === undefined ? undefined : resolveRowAnchor(layout, anchor);
    if (target !== undefined && target !== offset) scrollToOffset?.(target);
  }, [cells, presented, scroll, scrollToOffset, top, tracker]);
  const position = useCallback((offset: number) => {
    if (presented && top !== undefined) scrollToOffset?.(Math.max(0, top + offset));
  }, [presented, scrollToOffset, top]);
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

  const inWindow = (cell: Cell<Item>) => near(cell.offset, cell.height);
  const pinned = (cell: Cell<Item>) => !cell.header && cell.keys.some(key => key === tabStopKey || (retainedKeys?.has(key) ?? false));
  const renderCell = (cell: Cell<Item>) => (
    <View key={cell.key} style={cell.gap ? { paddingBottom: cell.gap } : undefined} onLayout={(event: HappierLayoutChangeEvent) => {
      if (!presented) return;
      const height = event.nativeEvent.layout.height;
      if (height <= 0 || height === cell.height) return;
      setMeasurements(current => ({ geometry,
        heights: new Map(sameMeasuredGeometry(current.geometry, geometry) ? current.heights : NO_MEASUREMENTS).set(cell.key, height),
      }));
    }}>
      {cell.header && request.kind === 'sections'
        ? cell.part ? request.renderPartHeading?.(cell.sectionIndex!) ?? null : request.renderSectionHeader(cell.sectionIndex!)
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

  const drawn = (cell: Cell<Item>) => inWindow(cell) || pinned(cell);
  const content: ReactNode[] = [];
  let renderedEnd = 0;
  const gapTo = (key: string, offset: number) => {
    if (offset > renderedEnd) content.push(spacer(`gap:${key}`, offset - renderedEnd));
  };
  for (let at = 0; at < cells.length;) {
    const first = cells[at]!;
    if (first.unit === null) {
      at += 1;
      if (!drawn(first)) continue;
      gapTo(first.key, first.offset);
      content.push(renderCell(first));
      renderedEnd = first.offset + first.height;
      continue;
    }
    let end = at;
    while (end < cells.length && cells[end]!.unit === first.unit) end += 1;
    const unit = cells.slice(at, end);
    at = end;
    // A sheet is drawn whenever any of its cells is near: its heading before it, and inside it the windowed cells
    // and their spacers, so the sheet's edges stay at its full extent.
    // The ungrouped list's one sheet stays drawn: its bar and footer are not cells, so dropping it would move the page.
    if (request.kind === 'sections' && !unit.some(drawn)) continue;
    gapTo(first.unit, first.offset);
    const inSheet = unit.filter(cell => cell.inSheet);
    const sheetCells: ReactNode[] = [];
    let cursor = inSheet[0]?.offset ?? 0;
    for (const cell of inSheet) {
      if (!drawn(cell)) continue;
      if (cell.offset > cursor) sheetCells.push(spacer(`gap:${cell.key}`, cell.offset - cursor));
      sheetCells.push(renderCell(cell));
      cursor = cell.offset + cell.height;
    }
    const last = unit[unit.length - 1]!;
    const unitEnd = last.offset + last.height;
    if (inSheet.length > 0 && unitEnd > cursor) sheetCells.push(spacer('end', unitEnd - cursor));
    content.push(
      <Fragment key={first.unit}>
        {unit.filter(cell => !cell.inSheet).map(renderCell)}
        {inSheet.length === 0 ? null
          : request.kind === 'flat' ? request.renderRows?.(sheetCells)
          : request.renderSectionRows?.(inSheet[0]!.sectionIndex!, sheetCells)}
      </Fragment>,
    );
    renderedEnd = unitEnd;
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
