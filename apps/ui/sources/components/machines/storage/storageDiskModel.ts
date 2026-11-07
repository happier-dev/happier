import type { DiskNodeV1, StorageItemV1, StorageReasonV1 } from '@happier-dev/protocol/storage/storageV1';

import { HAPPIER_SUNBURST_SMALLER_SUFFIX, HAPPIER_TREEMAP_SMALLER_SUFFIX, type HappierChartPart } from '@happier-dev/plugin-ui/presentation';

import { t } from '@/text';

import {
  describeStorageCollect,
  type StorageCollectState,
  type StoragePileMembership,
} from './storagePileModel';
import { formatStorageSize } from './storageViewModel';

/**
 * The one view model of an opened folder in a whole-disk scan (plan 40 §4.11, lab `rs` M / MT / MU / MV):
 * List, Map and Rings draw the same nodes, in the same order, with the same pointed-at row and the same
 * pile state. The list is where people act; the charts are two pictures of it. Collecting only marks a
 * node, so a tick never relayouts a chart.
 */

export type StorageDiskSort = Readonly<{
  by: 'name' | 'size' | 'items' | 'changed' | 'since';
  direction: 'asc' | 'desc';
}>;

/** What a row's mark says: its kind, or the honest exception (lab M "rows that keep it exact"). */
export type StorageDiskMark =
  | 'folder'
  | 'file'
  | 'package'
  | 'happier'
  | 'protected'
  | 'cloud'
  | 'mount'
  | 'small'
  | 'hidden'
  | 'reserved';

export type StorageDiskRow = Readonly<{
  key: string;
  node: DiskNodeV1;
  collect: StorageCollectState;
  mark: StorageDiskMark;
  /** Opening it lists its children (a folder, a package, a protected folder you can look inside). */
  drillable: boolean;
}>;

export type StorageDiskChartNode = Readonly<{
  key: string;
  label: string;
  value: number;
  mark: StorageDiskMark;
  collected: boolean;
  /** The scan node it draws, so a tile or arc collects through the same row as the list. */
  node: DiskNodeV1;
  children: readonly StorageDiskChartNode[];
}>;

export type StorageDiskLevel = Readonly<{
  root: DiskNodeV1 | null;
  rows: readonly StorageDiskRow[];
  chart: readonly StorageDiskChartNode[];
}>;

/** Rows that are not things on the disk to act on read after the real ones, whatever the sort. */
const TRAILING: ReadonlySet<DiskNodeV1['kind']> = new Set([
  'small-items',
  'hidden-space',
  'reserved',
  'mount',
]);

/**
 * What a scan node is called on screen (row, tile, arc, tooltip, tick label): its name on the disk, except
 * the folded row, which says how many small items it holds (lab `rs` MU "1,204 small items").
 */
export function storageDiskNodeName(node: DiskNodeV1): string {
  return node.kind === 'small-items' ? t('machineStorage.disk.smallItems', { count: node.items }) : node.name;
}

export const STORAGE_DISK_FOLDED_CRUMB_KEY = 'folded';

export type StorageDiskCrumb = Readonly<{
  key: string;
  label: string;
  nodeId: string | undefined;
  /** The one crumb that stands for every ancestor between the disk and the open folder; it opens the parent. */
  folded?: true;
}>;

/**
 * A phone has no room for every ancestor, and shrinking each one to "ho…" says nothing. Past the disk, one
 * folder and the open one, the middle folds into a single crumb that goes up one level (it keeps the parent's
 * name as its accessible name); the disk and the open folder keep their words.
 */
export function foldStorageDiskCrumbs(crumbs: readonly StorageDiskCrumb[], phone: boolean): readonly StorageDiskCrumb[] {
  if (!phone || crumbs.length <= 3) return crumbs;
  const parent = crumbs[crumbs.length - 2]!;
  return [crumbs[0]!, { key: STORAGE_DISK_FOLDED_CRUMB_KEY, label: parent.label, nodeId: parent.nodeId, folded: true }, crumbs[crumbs.length - 1]!];
}

/** Opening it lists its children: a folder, a package or a cloud-only folder, never a file or another disk's mount. */
export function isStorageDiskNodeDrillable(node: DiskNodeV1): boolean {
  return node.kind === 'folder' || node.kind === 'package' || node.kind === 'cloud-only';
}

/**
 * What a chart activation opens, at any ring or tile depth: the activated folder itself, or, for a
 * smaller-items group (whose key is its parent's key plus the layout suffix), the folder that holds
 * those items. The level's top group has no deeper folder (the list already shows every item), and a
 * file or another disk opens nothing, exactly as in the list.
 */
export function resolveStorageDiskOpenTarget(
  key: string,
  rows: ReadonlyMap<string, StorageDiskRow>,
  chartNodes: ReadonlyMap<string, StorageDiskChartNode>,
): string | null {
  const suffix = [HAPPIER_SUNBURST_SMALLER_SUFFIX, HAPPIER_TREEMAP_SMALLER_SUFFIX].find((candidate) => key.endsWith(candidate));
  const target = suffix ? key.slice(0, -suffix.length) : key;
  if (target === '') return null;
  const node = rows.get(target)?.node ?? chartNodes.get(target)?.node;
  return node && isStorageDiskNodeDrillable(node) ? target : null;
}

/**
 * A scan node's size as every view says it: the row, the Map tile, the Rings arc and the tooltip. A folder
 * Happier could not fully open keeps its "≥" lower bound in all of them, as the page above promises.
 */
export function formatStorageDiskBytes(node: DiskNodeV1, bytes: number = node.size.allocatedBytes): string {
  return formatStorageSize(bytes, node.flags.atLeast);
}

/** A level's chart node as the public Map / Rings part: the same words as its row. */
export function toStorageDiskChartPart(node: StorageDiskChartNode): HappierChartPart {
  return {
    key: node.key,
    label: node.label,
    value: node.value,
    valueLabel: formatStorageDiskBytes(node.node, node.value),
    tone:
      node.mark === 'happier'
        ? 'accent'
        : node.mark === 'small' || node.mark === 'hidden' || node.mark === 'reserved'
          ? 'quiet'
          : 'ink',
    hatched: node.collected,
    dotted: node.mark === 'small' || node.mark === 'hidden' || node.mark === 'reserved' || node.mark === 'cloud',
    locked: node.mark === 'protected',
    children: node.children.map(toStorageDiskChartPart),
  };
}

export function describeStorageDiskMark(node: DiskNodeV1): StorageDiskMark {
  switch (node.kind) {
    case 'small-items':
      return 'small';
    case 'hidden-space':
      return 'hidden';
    case 'reserved':
      return 'reserved';
    case 'mount':
      return 'mount';
    case 'cloud-only':
      return 'cloud';
    default:
      if (node.flags.protection !== 'none') return 'protected';
      if (node.flags.happier) return 'happier';
      return node.kind === 'file'
        ? 'file'
        : node.kind === 'package'
          ? 'package'
          : 'folder';
  }
}

export type StorageDiskCollectRow = Readonly<{
  itemId: string;
  path: string;
  title: string;
  verdict: StorageItemV1['verdict'];
  collectable: boolean;
  reason: StorageReasonV1;
  loses?: readonly StorageReasonV1[];
  file?: true;
}>;

/**
 * A scan node as a collectable row (a scan node's id is its path on the machine). Folded, hidden and
 * mounted rows are not things to clear. Forbidden has no box; Keep carries the machine's canonical reason
 * and what is lost, which its confirmation names (R42.1).
 */
export function toStorageDiskCollectRow(node: DiskNodeV1): StorageDiskCollectRow {
  const virtual =
    TRAILING.has(node.kind) ||
    node.kind === 'cloud-only' ||
    node.size.allocatedBytes === 0;
  const verdict = node.flags.protection === 'forbidden' ? 'forbidden'
    : node.flags.protection === 'keep' || node.flags.inUse ? 'keep' : 'safe';
  const reason: StorageReasonV1 = node.reason ?? { code: node.flags.inUse ? 'in_use' : verdict === 'safe' ? 'old' : 'facts_unavailable' };
  return {
    itemId: node.nodeId,
    path: node.nodeId,
    title: storageDiskNodeName(node),
    verdict,
    collectable: !virtual && verdict !== 'forbidden',
    reason,
    ...(node.loses ? { loses: node.loses } : {}),
    ...(node.kind === 'file' ? { file: true as const } : {}),
  };
}

export function describeStorageDiskCollect(
  node: DiskNodeV1,
  pile: StoragePileMembership,
): StorageCollectState {
  return describeStorageCollect(toStorageDiskCollectRow(node), pile);
}

function compare(sort: StorageDiskSort) {
  const sign = sort.direction === 'asc' ? 1 : -1;
  return (a: DiskNodeV1, b: DiskNodeV1): number => {
    const trailing =
      Number(TRAILING.has(a.kind)) - Number(TRAILING.has(b.kind));
    if (trailing !== 0) return trailing;
    let order = 0;
    switch (sort.by) {
      case 'name':
        order = a.name.localeCompare(b.name);
        break;
      case 'items':
        order = a.items - b.items;
        break;
      case 'changed':
        order = a.changedAt - b.changedAt;
        break;
      case 'since':
        order = (a.deltaSincePrevious ?? 0) - (b.deltaSincePrevious ?? 0);
        break;
      case 'size':
        order = a.size.allocatedBytes - b.size.allocatedBytes;
        break;
    }
    // Ties keep the larger first, then the name, so a streamed page never reshuffles equal rows.
    return order !== 0
      ? sign * order
      : b.size.allocatedBytes - a.size.allocatedBytes ||
          a.name.localeCompare(b.name);
  };
}

export function buildStorageDiskLevel(
  input: Readonly<{
    nodes: readonly DiskNodeV1[];
    rootId: string | null;
    pile: StoragePileMembership;
    sort: StorageDiskSort;
  }>,
): StorageDiskLevel {
  const byId = new Map(input.nodes.map((node) => [node.nodeId, node]));
  const children = new Map<string | null, DiskNodeV1[]>();
  for (const node of input.nodes) {
    if (node.nodeId === input.rootId) continue;
    const parent =
      node.parentId !== undefined && byId.has(node.parentId)
        ? node.parentId
        : null;
    const list = children.get(parent) ?? [];
    list.push(node);
    children.set(parent, list);
  }
  const root = input.rootId ? (byId.get(input.rootId) ?? null) : null;
  const levelKey = root ? root.nodeId : null;
  const top = [...(children.get(levelKey) ?? [])].sort(compare(input.sort));
  const rows = top.map((node): StorageDiskRow => {
    const mark = describeStorageDiskMark(node);
    return {
      key: node.nodeId,
      node,
      collect: describeStorageDiskCollect(node, input.pile),
      mark,
      drillable: isStorageDiskNodeDrillable(node),
    };
  });
  // Charts always draw biggest first: arc and tile order is by size, not by the list's column sort.
  const bySize = compare({ by: 'size', direction: 'desc' });
  const collected = (node: DiskNodeV1) =>
    describeStorageDiskCollect(node, input.pile) === 'collected';
  const chartNode = (
    node: DiskNodeV1,
    depth: number,
  ): StorageDiskChartNode => ({
    key: node.nodeId,
    label: storageDiskNodeName(node),
    value: node.size.allocatedBytes,
    mark: describeStorageDiskMark(node),
    collected: collected(node),
    node,
    children:
      depth >= 2
        ? []
        : [...(children.get(node.nodeId) ?? [])]
            .filter(
              (child) =>
                child.kind !== 'mount' && child.size.allocatedBytes > 0,
            )
            .sort(bySize)
            .map((child) => chartNode(child, depth + 1)),
  });
  const chart = [...top]
    .filter((node) => node.kind !== 'mount' && node.size.allocatedBytes > 0)
    .sort(bySize)
    .map((node) => chartNode(node, 0));
  return { root, rows, chart };
}
