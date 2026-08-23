import type { TriageSourceWorkflowSubjectV1 } from '@happier-dev/triage-protocol/v1';

import type { TriageWorkspaceModeV1 } from '../sessions/entrySessionWorkspace.js';

/**
 * One configured Triage action: the small composition record of `PLAN.md`
 * §0a A1.
 *
 * It is not a workflow engine and must not become one — no condition graphs,
 * steps, retries, variables, branching, hooks or post-action pipelines. It
 * answers which subjects it offers on and what it needs on disk, and delegates
 * everything else to an owner that already exists.
 *
 * **Ask, Fix and Review are configuration, not protocol literals.** What used
 * to be an `ask | fix` union hard-coded in three places is now a record: the
 * subject decides which actions are OFFERED (`appliesTo`), and the action itself
 * declares what it NEEDS (`workspaceMode`). Nothing derives one from the other
 * any more, which is what let the offered control and the gate that admits its
 * press disagree.
 *
 * **Seam — `U-ACTIONS-CATALOG` owns this record.** That unit adds the remaining
 * §0a A1 members to THIS type rather than introducing a second one: `profileId`
 * (which Launch Profile supplies Session defaults), `promptRef` (which Prompt
 * Library invocation supplies the task instruction) and `delivery`
 * (`'compose' | 'send'`), plus the Settings editor that lets a user add, remove,
 * rename, reorder, disable and configure actions, and the `Review` seed with its
 * two explicit arms. Only the members this unit consumes are declared here, so
 * nothing unconsumed is shipped ahead of its producer.
 */
export type TriageEntryActionV1 = Readonly<{
  /** Stable within the configured catalog; it is a React key and a press identity. */
  id: string;
  titleKey: string;
  /** The words on the control. It is a label the user may change, never a gate input. */
  title: string;
  /**
   * The workflow subjects this action offers on.
   *
   * A pull request and a code issue are offered different repair actions
   * because a pull request already has a branch to prepare and an issue does
   * not — so the two Fix arms are two records with two subject sets, rather than
   * one control whose meaning changes with the row underneath it.
   */
  appliesTo: readonly TriageSourceWorkflowSubjectV1[];
  /** What the press asks the Session-start gate for. It IS the request. */
  workspaceMode: TriageWorkspaceModeV1;
}>;

const ASK_ACTION: TriageEntryActionV1 = Object.freeze({
  id: 'ask',
  titleKey: 'plugins.triage.surface.session.ask',
  title: 'Ask',
  appliesTo: Object.freeze(['pullRequest', 'issue', 'errorIssue', 'other'] as const),
  workspaceMode: 'reference_only',
});

const FIX_ACTION: TriageEntryActionV1 = Object.freeze({
  id: 'fix',
  titleKey: 'plugins.triage.surface.session.fix',
  title: 'Fix',
  appliesTo: Object.freeze(['issue', 'errorIssue', 'other'] as const),
  workspaceMode: 'repository',
});

/**
 * A pull request is repaired through the source-prepared review workspace, and
 * says so. It is the same repair as **Fix** with a different declared workspace,
 * which is exactly why it is a separate record instead of a label the control
 * swapped in while sending the same request.
 */
const FIX_REVIEW_ACTION: TriageEntryActionV1 = Object.freeze({
  id: 'fixReview',
  titleKey: 'plugins.triage.surface.session.fixReview',
  title: 'Fix / review',
  appliesTo: Object.freeze(['pullRequest'] as const),
  workspaceMode: 'pull_request',
});

/** The default seed. A user's own catalog replaces it; it is never merged into one. */
export const TRIAGE_DEFAULT_ENTRY_ACTIONS_V1: readonly TriageEntryActionV1[] = Object.freeze([
  ASK_ACTION,
  FIX_ACTION,
  FIX_REVIEW_ACTION,
]);

/**
 * The ONE offered-action decision.
 *
 * It takes no layout, no mount, no platform and no source body — which is why
 * the same set renders in the wide split composition and the compact stacked
 * one, and why a source's own detail body can never add or remove a control.
 * Declared order is preserved: reordering is a user's configuration, not a rule
 * this function reapplies.
 */
export function planTriageEntryActionsV1(
  actions: readonly TriageEntryActionV1[],
  workflowSubject: TriageSourceWorkflowSubjectV1,
): readonly TriageEntryActionV1[] {
  return actions.filter((action) => action.appliesTo.includes(workflowSubject));
}
