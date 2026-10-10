import {
  resolveTriageRowFactStatusToneV1,
  TRIAGE_DETAIL_SHARED_TABS_V1,
  type TriageDetailSharedTabIdV1,
  type TriageRowFactStatusPresentationToneV1,
  type TriageRowFactV1,
  type TriageRowFactValueV1,
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

/**
 * `summary` is the value of the row fact the declaring source named for this
 * tab, read from the entry that source renders it for (the linked fix PR's own
 * facts for a fix-PR tab). Absent when nothing was declared or the snapshot
 * does not carry that fact: a tab never shows an invented count.
 */
export type TriageDetailTabV1 =
  | Readonly<{ kind: 'shared'; id: TriageDetailSharedTabIdV1; from: TriageDetailTabFromV1; summary?: TriageRowFactValueV1 }>
  | Readonly<{ kind: 'source'; id: string; title: string; titleKey?: string; from: 'entry'; summary?: TriageRowFactValueV1 }>;

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
  /** The fix PR's own snapshot facts, when the projection holds it. */
  facts?: readonly TriageRowFactV1[];
}>;

const WHOLE: TriageDetailCompositionV1 = Object.freeze({ kind: 'whole' });
const FROM_FIX_PULL_REQUEST: ReadonlySet<TriageDetailSharedTabIdV1> = new Set(['files', 'checks']);

function declaredShared(
  tabs: readonly TriageSourceDetailTabV1[] | undefined,
  id: TriageDetailSharedTabIdV1,
): TriageSourceDetailTabV1 | undefined {
  return tabs?.find((tab) => tab.kind === 'shared' && tab.id === id);
}

/** The named fact's value from the facts of the entry that renders the tab, as `{ summary }` to spread. */
function summaryOf(
  tab: TriageSourceDetailTabV1,
  facts: readonly TriageRowFactV1[] | undefined,
): Readonly<{ summary?: TriageRowFactValueV1 }> {
  if (tab.summaryFact === undefined) return {};
  const fact = facts?.find((candidate) => candidate.id === tab.summaryFact);
  return fact === undefined ? {} : { summary: fact.value };
}

export function planTriageDetailTabsV1(input: Readonly<{
  workflowSubject: TriageSourceWorkflowSubjectV1 | null;
  entryTabs: readonly TriageSourceDetailTabV1[] | undefined;
  /** The entry's own snapshot facts, which its source's tab summaries name. */
  entryFacts?: readonly TriageRowFactV1[];
  fixPullRequest: TriageDetailFixPullRequestTabsV1 | null;
}>): TriageDetailCompositionV1 {
  if (input.entryTabs === undefined || input.entryTabs.length === 0) return WHOLE;
  const changesFromFixPullRequest = input.workflowSubject === 'issue'
    || input.workflowSubject === 'errorIssue';

  const tabs: TriageDetailTabV1[] = [];
  for (const id of TRIAGE_DETAIL_SHARED_TABS_V1) {
    if (changesFromFixPullRequest && FROM_FIX_PULL_REQUEST.has(id)) {
      const declared = declaredShared(input.fixPullRequest?.detailTabs, id);
      if (declared !== undefined) {
        tabs.push(Object.freeze({
          kind: 'shared', id, from: 'fixPullRequest', ...summaryOf(declared, input.fixPullRequest?.facts),
        }));
      }
      continue;
    }
    const declared = declaredShared(input.entryTabs, id);
    if (declared !== undefined) {
      tabs.push(Object.freeze({ kind: 'shared', id, from: 'entry', ...summaryOf(declared, input.entryFacts) }));
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
        ...summaryOf(tab, input.entryFacts),
      }));
    }
  }
  return Object.freeze({ kind: 'tabs', tabs: Object.freeze(tabs) });
}

/**
 * How a tab says its summary beside its title: a count in the reader's
 * locale (an approximate one keeps its `~`), a status in its words. A failure
 * takes the shared status tone; a healthy fact or a plain count stays quiet.
 * Facts that are not a count or a state (a time, a person, a detail-only
 * marker) say nothing in a tab strip.
 */
export function readTriageDetailTabSummaryV1(
  value: TriageRowFactValueV1,
  locale: string,
): Readonly<{ value: string; tone: TriageRowFactStatusPresentationToneV1 }> | null {
  switch (value.kind) {
    case 'number': {
      const formatted = new Intl.NumberFormat(locale, value.format === 'compact' ? { notation: 'compact' } : {})
        .format(value.value);
      return { value: value.approximate === true ? `~${formatted}` : formatted, tone: 'secondary' };
    }
    case 'status':
      return { value: value.value, tone: resolveTriageRowFactStatusToneV1(value.tone) };
    case 'text':
      return { value: value.value, tone: 'secondary' };
    case 'timestamp':
    case 'actor':
    case 'detailOnly':
      return null;
  }
}
