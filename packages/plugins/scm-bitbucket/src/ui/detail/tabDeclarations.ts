/**
 * The Bitbucket Cloud detail body's tab declarations.
 *
 * The shared tab primitive treats an omitted retention as `discard`, so a panel
 * that says nothing acquires a lifetime by accident. This module is the one
 * place that states each panel's lifetime, exactly what survives a leave, which
 * read owns its data, and which component owns its vertical scroll.
 *
 * There is exactly one entry kind on this forge — a pull request — so there is
 * one composition, and it declares NO Sessions plane. The Triage common header
 * is the one source-neutral owner of an entry's intent and of its Session
 * relationship (`core/SURFACE.md` §2.2); a forge's `Work Sessions` tab exists
 * only on an ISSUE composition, "because a PR's Session relationship is already
 * in the aggregate's common header and a second surface for it would be a
 * second owner" (`sources/SCM.md` §3.7.6). A source contributes capability and
 * provider Actions, never a second Session surface.
 *
 * `Diff` reads Bitbucket's redirected raw text and its JSON diffstat companion through one
 * source-owned Action. There is likewise no Issues affordance — Atlassian is
 * removing the Bitbucket Cloud issue tracker, so there is no durable product to
 * build a tab against.
 */

export type BitbucketDetailTabIdV1 =
  | 'overview'
  | 'activity'
  | 'diff'
  | 'builds'
  | 'comments';

/** Which read a panel's content comes from. */
export type BitbucketDetailTabReadPlaneV1 =
  /** The applied observation only; this panel issues no provider read. */
  | 'observation'
  /** The one endpoint carrying approvals, updates and comments together. */
  | 'activity'
  /** The raw-diff redirect and diffstat collection. */
  | 'diff'
  /** The pull request's own build-status collection. */
  | 'builds'
  /** The pull request's comment collection, in provider order. */
  | 'comments';

export type BitbucketDetailTabDeclarationV1 = Readonly<{
  id: BitbucketDetailTabIdV1;
  title: string;
  titleKey: string;
  /** Stated on every concrete tab; never inherited from the shared default. */
  retention: 'retain' | 'discard';
  /** Exactly what survives a tab leave, in this panel and nothing else. */
  retainedState: string;
  readPlane: BitbucketDetailTabReadPlaneV1;
  /** The single component that owns this panel's vertical scrolling. */
  scrollOwner: 'scrollArea' | 'list';
}>;

export const BITBUCKET_DETAIL_TABS_V1: readonly BitbucketDetailTabDeclarationV1[] = Object.freeze([
  Object.freeze({
    id: 'overview' as const,
    title: 'Overview',
    titleKey: 'plugins.bitbucket.ui.tabs.overview',
    retention: 'retain' as const,
    retainedState: 'its one reader scroll anchor only; it holds no provider read to keep',
    readPlane: 'observation' as const,
    scrollOwner: 'scrollArea' as const,
  }),
  Object.freeze({
    id: 'activity' as const,
    title: 'Activity',
    titleKey: 'plugins.bitbucket.ui.tabs.activity',
    retention: 'discard' as const,
    retainedState: 'nothing: activity rows, the opaque next link, scroll and expansion remount',
    readPlane: 'activity' as const,
    scrollOwner: 'list' as const,
  }),
  Object.freeze({
    id: 'diff' as const,
    title: 'Diff',
    titleKey: 'plugins.bitbucket.ui.tabs.diff',
    retention: 'retain' as const,
    retainedState: 'the bounded raw prefix, diffstat rows and reader scroll anchor',
    readPlane: 'diff' as const,
    scrollOwner: 'scrollArea' as const,
  }),
  Object.freeze({
    id: 'builds' as const,
    title: 'Builds',
    titleKey: 'plugins.bitbucket.ui.tabs.builds',
    retention: 'discard' as const,
    retainedState: 'nothing: status rows, the rollup, the opaque next link and scroll remount',
    readPlane: 'builds' as const,
    scrollOwner: 'list' as const,
  }),
  Object.freeze({
    id: 'comments' as const,
    title: 'Comments',
    titleKey: 'plugins.bitbucket.ui.tabs.comments',
    retention: 'discard' as const,
    retainedState: 'nothing: comment rows, the opaque next link, the 30-record window, scroll,'
      + ' reply expansion and any draft remount from defaults',
    readPlane: 'comments' as const,
    scrollOwner: 'list' as const,
  }),
] as const);

/** The tab a body opens on. */
export const BITBUCKET_DEFAULT_DETAIL_TAB_V1: BitbucketDetailTabIdV1 = 'overview';
