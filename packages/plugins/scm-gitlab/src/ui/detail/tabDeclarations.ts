import type { GitlabKindId } from '../../triage/types.js';

/**
 * The GitLab detail body's tab declarations.
 *
 * The shared tab primitive treats an omitted retention as `discard`, so a panel
 * that says nothing acquires a lifetime by accident. This module is the one
 * place that states each panel's lifetime, exactly what survives a leave, which
 * read owns its data, and which component owns its vertical scroll — the facts
 * the rendered surface follows rather than restating inline, and the facts a
 * test can check without mounting a device.
 *
 * Which tabs exist is a function of the entry KIND, not of a read. A merge
 * request has changes, pipelines and reviews; an issue has none of the three,
 * and an issue is not shown an empty Pipelines tab — an empty tab and an
 * inapplicable one must not look alike. `sources/SCM.md` §4.6 fixes both
 * compositions, and they are deliberately different tab sets rather than one
 * set with three disabled entries.
 */

export type GitlabDetailTabIdV1 =
  | 'overview'
  | 'activity'
  | 'changes'
  | 'pipelines'
  | 'reviews'
  | 'comments'
  | 'work-sessions';

/** Which read a panel's content comes from. */
export type GitlabDetailTabReadPlaneV1 =
  /** The applied observation only; this panel issues no provider read. */
  | 'observation'
  /** The notes walk plus the three independently cursored resource-event walks. */
  | 'activity'
  /** The panel's own `/diffs` changed-file walk. */
  | 'changes'
  /** The panel's own merge-request pipeline walk and its per-job rollup. */
  | 'pipelines'
  /** The panel's own discussions walk and its separate approvals read. */
  | 'reviews'
  /** The issue's own notes walk. */
  | 'comments'
  /** The bounded linked-Session projection the launch input carried. */
  | 'linkedSessions';

export type GitlabDetailTabDeclarationV1 = Readonly<{
  id: GitlabDetailTabIdV1;
  title: string;
  titleKey: string;
  /** Stated on every concrete tab; never inherited from the shared default. */
  retention: 'retain' | 'discard';
  /** Exactly what survives a tab leave, in this panel and nothing else. */
  retainedState: string;
  readPlane: GitlabDetailTabReadPlaneV1;
  /** The single component that owns this panel's vertical scrolling. */
  scrollOwner: 'scrollArea' | 'list';
  /** The entry kinds this tab is present for. */
  kinds: readonly GitlabKindId[];
}>;

const BOTH_KINDS: readonly GitlabKindId[] = Object.freeze(['merge-request', 'issue']);
const MERGE_REQUEST_ONLY: readonly GitlabKindId[] = Object.freeze(['merge-request']);
const ISSUE_ONLY: readonly GitlabKindId[] = Object.freeze(['issue']);

export const GITLAB_DETAIL_TABS_V1: readonly GitlabDetailTabDeclarationV1[] = Object.freeze([
  Object.freeze({
    id: 'overview' as const,
    title: 'Overview',
    titleKey: 'plugins.gitlab.ui.tabs.overview',
    retention: 'retain' as const,
    retainedState: 'its one reader scroll anchor only; it holds no provider read to keep',
    readPlane: 'observation' as const,
    scrollOwner: 'scrollArea' as const,
    kinds: BOTH_KINDS,
  }),
  Object.freeze({
    id: 'activity' as const,
    title: 'Activity',
    titleKey: 'plugins.gitlab.ui.tabs.activity',
    retention: 'discard' as const,
    retainedState: 'nothing: notes, the three event sources, their four independent cursors,'
      + ' the union, scroll and expansion all remount at first page',
    readPlane: 'activity' as const,
    scrollOwner: 'list' as const,
    kinds: BOTH_KINDS,
  }),
  Object.freeze({
    id: 'changes' as const,
    title: 'Changes',
    titleKey: 'plugins.gitlab.ui.tabs.changes',
    retention: 'retain' as const,
    retainedState: 'its one vertical list viewport and file scroll anchor only; the loaded'
      + ' per-file page model, page position and errors are discarded when the panel'
      + ' becomes inactive, and no rich diff body is retained while B6 is held',
    readPlane: 'changes' as const,
    scrollOwner: 'list' as const,
    kinds: MERGE_REQUEST_ONLY,
  }),
  Object.freeze({
    id: 'pipelines' as const,
    title: 'Pipelines',
    titleKey: 'plugins.gitlab.ui.tabs.pipelines',
    retention: 'discard' as const,
    retainedState: 'nothing: pipeline rows, the rollup, cursors and scroll remount',
    readPlane: 'pipelines' as const,
    scrollOwner: 'list' as const,
    kinds: MERGE_REQUEST_ONLY,
  }),
  Object.freeze({
    id: 'reviews' as const,
    title: 'Reviews',
    titleKey: 'plugins.gitlab.ui.tabs.reviews',
    retention: 'discard' as const,
    retainedState: 'nothing: discussion rows, approval state, the root Link, reply windows,'
      + ' scroll and every draft remount from defaults',
    readPlane: 'reviews' as const,
    scrollOwner: 'list' as const,
    kinds: MERGE_REQUEST_ONLY,
  }),
  Object.freeze({
    id: 'comments' as const,
    title: 'Comments',
    titleKey: 'plugins.gitlab.ui.tabs.comments',
    retention: 'discard' as const,
    retainedState: 'nothing: notes, the Link, window, scroll and expansion remount',
    readPlane: 'comments' as const,
    scrollOwner: 'list' as const,
    // A merge request's person-authored notes are part of its Activity union;
    // an issue keeps them in a tab of their own, as §4.6 declares.
    kinds: ISSUE_ONLY,
  }),
  Object.freeze({
    id: 'work-sessions' as const,
    title: 'Work Sessions',
    titleKey: 'plugins.gitlab.ui.tabs.workSessions',
    retention: 'discard' as const,
    retainedState: 'nothing; there is no provider or Session-store read to keep alive',
    readPlane: 'linkedSessions' as const,
    scrollOwner: 'list' as const,
    // A merge request's Session relationship is already a common-header fact, so
    // a second surface for it here would be a second owner of one fact.
    kinds: ISSUE_ONLY,
  }),
] as const);

const BY_ID: ReadonlyMap<GitlabDetailTabIdV1, GitlabDetailTabDeclarationV1> = new Map(
  GITLAB_DETAIL_TABS_V1.map((tab) => [tab.id, tab]),
);

export function gitlabDetailTabDeclaration(
  id: GitlabDetailTabIdV1,
): GitlabDetailTabDeclarationV1 {
  const declaration = BY_ID.get(id);
  if (declaration === undefined) {
    throw new Error(`GitLab detail tab '${id}' is not declared.`);
  }
  return declaration;
}

/**
 * The tabs one entry kind shows, in declaration order.
 *
 * A tab that does not apply to this kind is ABSENT rather than present and
 * empty: an issue has no pipelines at all, and rendering it an empty Pipelines
 * list would state that nothing ran.
 */
export function gitlabVisibleDetailTabs(
  kindId: GitlabKindId,
): readonly GitlabDetailTabDeclarationV1[] {
  return GITLAB_DETAIL_TABS_V1.filter((tab) => tab.kinds.includes(kindId));
}

/** The tab a body opens on, and the one a removed selection falls back to. */
export const GITLAB_DEFAULT_DETAIL_TAB_V1: GitlabDetailTabIdV1 = 'overview';

export function gitlabResolveSelectedTab(
  selected: GitlabDetailTabIdV1,
  visible: readonly GitlabDetailTabDeclarationV1[],
): GitlabDetailTabIdV1 {
  return visible.some((tab) => tab.id === selected)
    ? selected
    : GITLAB_DEFAULT_DETAIL_TAB_V1;
}
