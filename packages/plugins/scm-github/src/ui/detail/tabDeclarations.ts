import type { GithubTriageKindIdV1 } from '../../triage/types.js';

/**
 * The GitHub detail body's tab declarations.
 *
 * The shared tab primitive treats an omitted retention as `discard`, so a panel
 * that says nothing acquires a lifetime by accident. This module is the one
 * place that states each panel's lifetime, exactly what survives a leave, which
 * read owns its data, and which component owns its vertical scroll — the facts
 * the rendered surface follows rather than restating inline, and the facts a
 * test can check without mounting a device.
 *
 * `retainedState` is deliberately narrow, and it is the one thing a panel may
 * not overstate: `panelReaders.ts` reads this exact field's tab to decide what
 * survives a leave, so a tab that claims to keep something it drops is a defect
 * rather than prose. A `discard` panel keeps nothing at all and re-reads from
 * the first page. `retain` is spent only where restarting would re-charge a
 * reader's already-paid provider walk and lose their place in it — it is never
 * permission to hold provider content indefinitely, because the retained walk
 * lives and dies with the mounted detail body.
 *
 * Which tabs exist is a function of the entry KIND, not of a read. A pull
 * request has changed files and checks; an issue has neither, and an issue is
 * not shown an empty Files tab — an empty tab and an inapplicable one must not
 * look alike.
 */

export type GithubDetailTabIdV1 =
  | 'overview'
  | 'timeline'
  | 'files'
  | 'checks'
  | 'feedback'
  | 'comments'
  | 'work-sessions';

/** Which read a panel's content comes from. */
export type GithubDetailTabReadPlaneV1 =
  /** The applied observation only; this panel issues no provider read. */
  | 'observation'
  /** The panel's own cursor-paged event-timeline walk. */
  | 'timeline'
  /** The panel's own cursor-paged changed-file walk. */
  | 'changedFiles'
  /** The panel's own check-run and commit-status read at the current head. */
  | 'checks'
  /** The panel's own cursor-paged issue-level comment walk. */
  | 'comments'
  /**
   * The conversation and event walks this source already owns, composed with the
   * applied observation.
   *
   * This plane opens no provider route of its own. Every fact it presents —
   * what was said, who has reviewed, who is still being waited on, and what
   * GitHub reports as wrong — is already carried by a read this surface owns, so
   * a route of its own would spend GitHub's budget twice for facts already in
   * hand.
   */
  | 'feedback'
  /** The bounded linked-Session projection the launch input carried. */
  | 'linkedSessions';

export type GithubDetailTabDeclarationV1 = Readonly<{
  id: GithubDetailTabIdV1;
  /**
   * The English tab name, and the fallback for {@link GithubDetailTabDeclarationV1.titleKey}.
   *
   * `Tabs.Item` takes a plain string, so a title that reached it untranslated
   * would render English on the ten non-English locales this plugin ships while
   * nothing failed. Both halves are declared so the renderer resolves a key
   * rather than reading a word.
   */
  title: string;
  titleKey: string;
  /** Stated on every concrete tab; never inherited from the shared default. */
  retention: 'retain' | 'discard';
  /** Exactly what survives a tab leave, in this panel and nothing else. */
  retainedState: string;
  readPlane: GithubDetailTabReadPlaneV1;
  /** The single component that owns this panel's vertical scrolling. */
  scrollOwner: 'scrollArea' | 'list';
  /** The entry kinds this tab is present for. */
  kinds: readonly GithubTriageKindIdV1[];
}>;

const BOTH_KINDS: readonly GithubTriageKindIdV1[] = Object.freeze(['pull-request', 'issue']);
const PULL_REQUEST_ONLY: readonly GithubTriageKindIdV1[] = Object.freeze(['pull-request']);
const ISSUE_ONLY: readonly GithubTriageKindIdV1[] = Object.freeze(['issue']);

export const GITHUB_DETAIL_TABS_V1: readonly GithubDetailTabDeclarationV1[] = Object.freeze([
  Object.freeze({
    id: 'overview' as const,
    title: 'Overview',
    titleKey: 'plugins.github.ui.tab.overview',
    retention: 'retain' as const,
    retainedState: 'its one reader scroll anchor only; it holds no provider read to keep',
    readPlane: 'observation' as const,
    scrollOwner: 'scrollArea' as const,
    kinds: BOTH_KINDS,
  }),
  Object.freeze({
    id: 'timeline' as const,
    title: 'Timeline',
    titleKey: 'plugins.github.ui.tab.timeline',
    retention: 'discard' as const,
    retainedState: 'nothing: rows, page position, scroll and errors remount at the first page',
    readPlane: 'timeline' as const,
    scrollOwner: 'list' as const,
    kinds: BOTH_KINDS,
  }),
  Object.freeze({
    id: 'files' as const,
    title: 'Files',
    titleKey: 'plugins.github.ui.tab.files',
    retention: 'retain' as const,
    retainedState: 'the changed-file rows already walked, the position of the next'
      + ' page, and the list viewport and scroll anchor over them, so a reader who'
      + ' walked nine pages and glanced at Checks returns to the same nine pages in'
      + ' the same place rather than paying GitHub for them twice; a page in flight'
      + ' at the leave is re-asked once on return, and no rich diff body is'
      + ' retained while B6 is held',
    readPlane: 'changedFiles' as const,
    scrollOwner: 'list' as const,
    kinds: PULL_REQUEST_ONLY,
  }),
  Object.freeze({
    id: 'checks' as const,
    title: 'Checks',
    titleKey: 'plugins.github.ui.tab.checks',
    retention: 'discard' as const,
    retainedState: 'nothing: check rows and scroll remount from the source default',
    readPlane: 'checks' as const,
    scrollOwner: 'list' as const,
    kinds: PULL_REQUEST_ONLY,
  }),
  Object.freeze({
    id: 'feedback' as const,
    // Named `Feedback` and not `Reviews` because it unifies finding sources that
    // are not all reviews: what people said about the pull request, who has
    // signed off on it, who is still being waited on, and what GitHub itself
    // reports as wrong with it.
    title: 'Feedback',
    titleKey: 'plugins.github.ui.tab.feedback',
    retention: 'discard' as const,
    retainedState: 'nothing: the conversation, the review people and the findings all'
      + ' remount at their first page, and no comment or review draft survives a leave',
    readPlane: 'feedback' as const,
    scrollOwner: 'list' as const,
    kinds: PULL_REQUEST_ONLY,
  }),
  Object.freeze({
    id: 'comments' as const,
    title: 'Comments',
    titleKey: 'plugins.github.ui.tab.comments',
    retention: 'discard' as const,
    retainedState: 'nothing: rows, page position, scroll and errors remount at the first page',
    readPlane: 'comments' as const,
    scrollOwner: 'list' as const,
    // A pull request's conversation is one of the things `Feedback` unifies, so a
    // second Comments tab beside it would read the same GitHub resource twice and
    // split one conversation across two places a reviewer has to check. An issue
    // has no reviews, checks or merge conflicts to unify, so its conversation
    // keeps its own tab rather than acquiring a heading over a single stream.
    kinds: ISSUE_ONLY,
  }),
  Object.freeze({
    id: 'work-sessions' as const,
    title: 'Work Sessions',
    titleKey: 'plugins.github.ui.tab.workSessions',
    retention: 'discard' as const,
    retainedState: 'nothing; there is no provider or Session-store read to keep alive',
    readPlane: 'linkedSessions' as const,
    scrollOwner: 'list' as const,
    // A pull request's Session relationship is already a common-header fact, so
    // a second surface for it here would be a second owner of one fact.
    kinds: ISSUE_ONLY,
  }),
] as const);

const BY_ID: ReadonlyMap<GithubDetailTabIdV1, GithubDetailTabDeclarationV1> = new Map(
  GITHUB_DETAIL_TABS_V1.map((tab) => [tab.id, tab]),
);

export function githubDetailTabDeclaration(
  id: GithubDetailTabIdV1,
): GithubDetailTabDeclarationV1 {
  const declaration = BY_ID.get(id);
  if (declaration === undefined) {
    throw new Error(`GitHub detail tab '${id}' is not declared.`);
  }
  return declaration;
}

/**
 * The tabs one entry kind shows, in declaration order.
 *
 * A tab that does not apply to this kind is ABSENT rather than present and
 * empty: an issue has no changed files at all, and rendering it an empty Files
 * list would state that the issue changes nothing.
 */
export function githubVisibleDetailTabs(
  kindId: GithubTriageKindIdV1,
): readonly GithubDetailTabDeclarationV1[] {
  return GITHUB_DETAIL_TABS_V1.filter((tab) => tab.kinds.includes(kindId));
}

/** The tab a body opens on, and the one a removed selection falls back to. */
export const GITHUB_DEFAULT_DETAIL_TAB_V1: GithubDetailTabIdV1 = 'overview';

export function githubResolveSelectedTab(
  selected: GithubDetailTabIdV1,
  visible: readonly GithubDetailTabDeclarationV1[],
): GithubDetailTabIdV1 {
  return visible.some((tab) => tab.id === selected)
    ? selected
    : GITHUB_DEFAULT_DETAIL_TAB_V1;
}
