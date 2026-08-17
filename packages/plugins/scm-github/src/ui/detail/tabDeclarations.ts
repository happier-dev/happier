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
 * `retainedState` is deliberately narrow. Retention on this source buys the
 * already-measured reader state and nothing else: every panel's loaded
 * projection is discarded when its active interval ends, whether or not its
 * subtree stays mounted. Retention is a scroll-position concession, never
 * permission to keep provider content a reader is no longer looking at.
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
  /** The bounded linked-Session projection the launch input carried. */
  | 'linkedSessions';

export type GithubDetailTabDeclarationV1 = Readonly<{
  id: GithubDetailTabIdV1;
  title: string;
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
    retention: 'retain' as const,
    retainedState: 'its one reader scroll anchor only; it holds no provider read to keep',
    readPlane: 'observation' as const,
    scrollOwner: 'scrollArea' as const,
    kinds: BOTH_KINDS,
  }),
  Object.freeze({
    id: 'timeline' as const,
    title: 'Timeline',
    retention: 'discard' as const,
    retainedState: 'nothing: rows, page position, scroll and errors remount at the first page',
    readPlane: 'timeline' as const,
    scrollOwner: 'list' as const,
    kinds: BOTH_KINDS,
  }),
  Object.freeze({
    id: 'files' as const,
    title: 'Files',
    retention: 'retain' as const,
    retainedState: 'its one vertical list viewport and scroll anchor only; the loaded'
      + ' changed-file rows, page position and errors are discarded when the panel'
      + ' becomes inactive, and no rich diff body is retained while B6 is held',
    readPlane: 'changedFiles' as const,
    scrollOwner: 'list' as const,
    kinds: PULL_REQUEST_ONLY,
  }),
  Object.freeze({
    id: 'checks' as const,
    title: 'Checks',
    retention: 'discard' as const,
    retainedState: 'nothing: check rows and scroll remount from the source default',
    readPlane: 'checks' as const,
    scrollOwner: 'list' as const,
    kinds: PULL_REQUEST_ONLY,
  }),
  Object.freeze({
    id: 'comments' as const,
    title: 'Comments',
    retention: 'discard' as const,
    retainedState: 'nothing: rows, page position, scroll and errors remount at the first page',
    readPlane: 'comments' as const,
    scrollOwner: 'list' as const,
    kinds: BOTH_KINDS,
  }),
  Object.freeze({
    id: 'work-sessions' as const,
    title: 'Work Sessions',
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
