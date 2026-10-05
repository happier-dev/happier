import {
  TRIAGE_DETAIL_SHARED_TABS_V1,
  type TriageDetailSharedTabIdV1,
  type TriageSourceDetailTabV1,
  type TriageSourceWorkflowSubjectV1,
} from '@happier-dev/triage-protocol/v1';

/**
 * Which tabs the entry detail shows, and whose source renders each (r0.42).
 *
 * Triage owns the frame and the shared vocabulary — Overview · Activity ·
 * Files · Checks, always in that order — and a source declares, per entry
 * kind, which of them it renders as a `panel` plus any views only it has. The
 * plan is the one place that joins those declarations, so the tab strip, the
 * mounted panel and a test all read the same answer.
 *
 * - A kind that declares nothing keeps its source's whole detail (`whole`).
 * - An issue or error group has no changes of its own: its Files and Checks
 *   come from its linked fix PR, through that PR's source, and are absent —
 *   never empty — when there is no fix PR or its source does not render them.
 * - Overview always leads, because it also carries Triage's own agent step;
 *   when the source renders no overview panel it holds only that (`none`).
 */
export type TriageDetailTabFromV1 = 'entry' | 'fixPullRequest' | 'none';

export type TriageDetailTabV1 =
  | Readonly<{ kind: 'shared'; id: TriageDetailSharedTabIdV1; from: TriageDetailTabFromV1 }>
  | Readonly<{ kind: 'source'; id: string; title: string; titleKey?: string; from: 'entry' }>;

export type TriageDetailCompositionV1 =
  | Readonly<{ kind: 'whole' }>
  | Readonly<{ kind: 'tabs'; tabs: readonly TriageDetailTabV1[] }>;

/**
 * The linked fix PR as the plan needs it: the tabs its own source declares
 * for its kind. Resolved from the fix-PR link owner (U-TRIAGE-FIX-PR-LINK:
 * "given an entry, the linked fix PR entry ref, or none") and that PR's
 * admitted descriptor.
 */
export type TriageDetailFixPullRequestTabsV1 = Readonly<{
  detailTabs: readonly TriageSourceDetailTabV1[] | undefined;
}>;

const WHOLE: TriageDetailCompositionV1 = Object.freeze({ kind: 'whole' });
const FROM_FIX_PULL_REQUEST: ReadonlySet<TriageDetailSharedTabIdV1> = new Set(['files', 'checks']);

function declaresShared(
  tabs: readonly TriageSourceDetailTabV1[] | undefined,
  id: TriageDetailSharedTabIdV1,
): boolean {
  return tabs?.some((tab) => tab.kind === 'shared' && tab.id === id) ?? false;
}

export function planTriageDetailTabsV1(input: Readonly<{
  workflowSubject: TriageSourceWorkflowSubjectV1 | null;
  entryTabs: readonly TriageSourceDetailTabV1[] | undefined;
  fixPullRequest: TriageDetailFixPullRequestTabsV1 | null;
}>): TriageDetailCompositionV1 {
  if (input.entryTabs === undefined || input.entryTabs.length === 0) return WHOLE;
  const changesFromFixPullRequest = input.workflowSubject === 'issue'
    || input.workflowSubject === 'errorIssue';

  const tabs: TriageDetailTabV1[] = [];
  for (const id of TRIAGE_DETAIL_SHARED_TABS_V1) {
    if (changesFromFixPullRequest && FROM_FIX_PULL_REQUEST.has(id)) {
      if (declaresShared(input.fixPullRequest?.detailTabs, id)) {
        tabs.push(Object.freeze({ kind: 'shared', id, from: 'fixPullRequest' }));
      }
      continue;
    }
    if (declaresShared(input.entryTabs, id)) {
      tabs.push(Object.freeze({ kind: 'shared', id, from: 'entry' }));
    } else if (id === 'overview') {
      tabs.push(Object.freeze({ kind: 'shared', id, from: 'none' }));
    }
  }
  for (const tab of input.entryTabs) {
    if (tab.kind === 'source') {
      tabs.push(Object.freeze({
        kind: 'source',
        id: tab.id,
        title: tab.title,
        ...(tab.titleKey ? { titleKey: tab.titleKey } : {}),
        from: 'entry',
      }));
    }
  }
  return Object.freeze({ kind: 'tabs', tabs: Object.freeze(tabs) });
}
