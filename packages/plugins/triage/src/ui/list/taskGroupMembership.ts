import type { HappierCollectionGroup } from '@happier-dev/plugin-ui';
import type { TriageTransitionTaskActionInputV1Schema } from '../../actions/tasksProtocol.js';
import { TRIAGE_TASK_STATUS_DROP_TARGET_ID_V1 } from './entryDragDropProtocol.js';
import type { TriageListItemV1, TriageListTaskFactsV1 } from './sections.js';
import { triageEntryRowKey } from '../../projection/listWindow.js';

/** Status categories stay presentation facts; the selected source offers the actual native transition. */
export function assignTriageTaskStatusGroup(
  group: HappierCollectionGroup & Readonly<{ key: NonNullable<TriageListTaskFactsV1['category']> }>,
  items: readonly TriageListItemV1[],
  vocabulary: Readonly<{ verb: string; unavailableReason: string }>,
): HappierCollectionGroup & Readonly<{ key: NonNullable<TriageListTaskFactsV1['category']> }> {
  const candidatesByEntry = Object.fromEntries(items.flatMap(item => {
    const { row, task } = item;
    if (!row.materialized || row.sourceInstanceId === null || task == null || task.category === group.key) return [];
    const transitions = task.transitions?.filter(transition => transition.category === group.key) ?? [];
    // Several native statuses can share a category, or ask for fields. The existing status menu owns that choice.
    if (transitions.length !== 1 || (transitions[0]!.requiredFields?.length ?? 0) > 0) return [];
    return [[triageEntryRowKey(row.entryRef), {
      v: 1, entryRef: row.entryRef, sourceInstanceId: row.sourceInstanceId,
      transitionId: transitions[0]!.id,
      ...(item.locator == null ? {} : { lastKnownLocator: item.locator }),
    } satisfies ReturnType<typeof TriageTransitionTaskActionInputV1Schema.parse>] as const];
  }));
  return { ...group, membership: { kind: 'assignable', target: {
    targetId: TRIAGE_TASK_STATUS_DROP_TARGET_ID_V1,
    input: { candidatesByEntry, preview: { verb: vocabulary.verb, target: group.title }, unavailableReason: vocabulary.unavailableReason },
  } } };
}
