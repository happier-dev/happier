import type { TriageListRowV1 } from '../../projection/listWindow.js';
import { triageEntryRowKey } from '../../projection/listWindow.js';
import type { TriageListWindowChangeV1, TriageListWindowSnapshotV1 } from '../../projection/listWindowStore.js';
import { sameTriagePreviewAddressV1 } from './previewBadges.js';
import { readTriageTaskBlockerNameV1, type TriageListItemV1 } from './sections.js';

export type TriageListItemPlannerV1 = (
  rows: readonly TriageListRowV1[], previous: readonly TriageListItemV1[], incremental?: boolean,
) => readonly TriageListItemV1[];

/** The mounted list's display projection. Rows and Collection structure publish independently. */
export function createTriageListPublicationV1() {
  let snapshot: TriageListWindowSnapshotV1 | undefined;
  let planner: TriageListItemPlannerV1 | undefined;
  let items: readonly TriageListItemV1[] = [];
  let byKey = new Map<string, TriageListItemV1 | undefined>();
  let revision = 0;

  function rebuild() {
    items = planner?.(snapshot?.window?.rows ?? [], items) ?? [];
    byKey = new Map((snapshot?.window?.rows ?? []).map(row => [triageEntryRowKey(row.entryRef), undefined]));
    for (const item of items) byKey.set(item.key, item);
  }

  return {
    setPlanner(next: TriageListItemPlannerV1) {
      if (planner === next) return;
      planner = next;
      // The shell installs its presentation planner during render. Rebuilding
      // it is part of that render, not an external window publication: moving
      // the subscribed revision here feeds React's snapshot check back into
      // the render that replaced the planner.
      rebuild();
    },
    synchronize(next: TriageListWindowSnapshotV1, change?: TriageListWindowChangeV1) {
      if (snapshot === next) return;
      const previousWindow = snapshot?.window;
      snapshot = next;
      if (change === undefined) {
        if (previousWindow !== next.window) rebuild();
        revision += 1;
        return;
      }
      if (change.structureChanged) {
        rebuild();
        revision += 1;
        return;
      }
      let structureChanged = false;
      for (const row of change.changedRows) {
        const key = triageEntryRowKey(row.entryRef);
        const previous = byKey.get(key);
        // A retained row outside this lens cannot join the displayed Collection.
        if (!byKey.has(key)) continue;
        const item = planner?.([row], previous === undefined ? [] : [previous], true).find(value => value.key === key);
        if ((previous === undefined) !== (item === undefined)) {
          // View membership changed; the planner owns pins and personal ordering.
          rebuild();
          revision += 1;
          return;
        }
        if (previous === undefined || item === undefined) continue;
        if (previous.group !== item.group || previous.statusGroup !== item.statusGroup) {
          // Group changes can alter the canonical personal ordering within each group.
          rebuild();
          revision += 1;
          return;
        }
        byKey.set(key, item);
        structureChanged ||= !sameTriagePreviewAddressV1(previous.row.preview, item.row.preview)
          || previous.row.sourceInstanceId !== item.row.sourceInstanceId
          || previous.row.detailKind !== item.row.detailKind || previous.row.detail !== item.row.detail
          || (previous.signal === null) !== (item.signal === null)
          || (previous.agent === null) !== (item.agent === null);
      }
      if (structureChanged) items = Object.freeze(items.flatMap(item => {
        const current = byKey.get(item.key);
        return current === undefined ? [] : [current];
      }));
      if (structureChanged || change.metadataChanged) revision += 1;
    },
    getRevision: () => revision,
    getItems: () => items,
    getItem: (key: string) => byKey.get(key),
    getBlockerName: (ref: TriageListRowV1['entryRef']) => readTriageTaskBlockerNameV1(byKey.get(triageEntryRowKey(ref))),
  };
}

export type TriageListPublicationV1 = ReturnType<typeof createTriageListPublicationV1>;
