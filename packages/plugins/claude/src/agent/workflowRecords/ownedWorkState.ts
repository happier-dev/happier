import type { SessionWorkStateV1 } from '@happier-dev/plugin-sdk/experimental/sessions/workState';

/**
 * CWF4 work-state coherence filter.
 *
 * A canonical `Workflow` run's agents live in the durable `activity/workflow_run.v1` record and the
 * workflow UI surfaces. They must NOT ALSO appear as top-level `SessionWorkStateV1` task/todo rows,
 * or the UI double-renders them and shows competing progress sources. This pure filter drops
 * work-state items the Claude workflow normalizer marked workflow-owned (by their tool-use
 * `vendorRef` or owning `parentId`) at the plugin boundary — never in the UI, which must not branch
 * on Claude-native ids.
 *
 * Non-workflow Claude Task API items keep their existing task/todo derivation; only ids in the
 * workflow-owned set are removed. `primaryItemId` is cleared if it pointed at a filtered item so a
 * removed row cannot keep pinning the compact badge.
 */
export function filterWorkflowOwnedWorkStateItems(
  snapshot: SessionWorkStateV1,
  workflowOwnedToolUseIds: ReadonlySet<string>,
): SessionWorkStateV1 {
  if (workflowOwnedToolUseIds.size === 0) return snapshot;

  const isOwned = (value: string | undefined): boolean =>
    value !== undefined && workflowOwnedToolUseIds.has(value);

  const items = snapshot.items.filter((item) => !isOwned(item.vendorRef) && !isOwned(item.parentId));
  if (items.length === snapshot.items.length) return snapshot;

  const survivingIds = new Set(items.map((item) => item.id));
  const primaryItemId =
    snapshot.primaryItemId && survivingIds.has(snapshot.primaryItemId)
      ? snapshot.primaryItemId
      : null;

  return { ...snapshot, items, primaryItemId };
}
