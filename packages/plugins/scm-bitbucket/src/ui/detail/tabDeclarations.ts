/**
 * The Bitbucket Cloud detail body's tab declarations.
 *
 * The shared tab primitive treats an omitted retention as `discard`, so a panel
 * that says nothing acquires a lifetime by accident. This module is the one
 * place that states each panel's lifetime, exactly what survives a leave, which
 * read owns its data, and which component owns its vertical scroll.
 *
 * There is exactly one entry kind on this forge, so there is one composition.
 * `Diff` is deliberately ABSENT rather than present and empty: Bitbucket serves
 * a diff as a redirected raw text stream rather than a JSON file array, and its
 * reader is a separate unit. An empty tab and an unbuilt tab must not look
 * alike, and a `Diff` tab that rendered nothing would read as "this pull request
 * changes nothing". There is likewise no Issues affordance — Atlassian is
 * removing the Bitbucket Cloud issue tracker, so there is no durable product to
 * build a tab against.
 */

export type BitbucketDetailTabIdV1 =
  | 'overview'
  | 'activity'
  | 'builds'
  | 'comments'
  | 'sessions';

/** Which read a panel's content comes from. */
export type BitbucketDetailTabReadPlaneV1 =
  /** The applied observation only; this panel issues no provider read. */
  | 'observation'
  /** The one endpoint carrying approvals, updates and comments together. */
  | 'activity'
  /** The pull request's own build-status collection. */
  | 'builds'
  /** The pull request's comment collection, in provider order. */
  | 'comments'
  /** The bounded linked-Session projection the launch input carried. */
  | 'linkedSessions';

export type BitbucketDetailTabDeclarationV1 = Readonly<{
  id: BitbucketDetailTabIdV1;
  title: string;
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
    retention: 'retain' as const,
    retainedState: 'its one reader scroll anchor only; it holds no provider read to keep',
    readPlane: 'observation' as const,
    scrollOwner: 'scrollArea' as const,
  }),
  Object.freeze({
    id: 'activity' as const,
    title: 'Activity',
    retention: 'discard' as const,
    retainedState: 'nothing: activity rows, the opaque next link, scroll and expansion remount',
    readPlane: 'activity' as const,
    scrollOwner: 'list' as const,
  }),
  Object.freeze({
    id: 'builds' as const,
    title: 'Builds',
    retention: 'discard' as const,
    retainedState: 'nothing: status rows, the rollup, the opaque next link and scroll remount',
    readPlane: 'builds' as const,
    scrollOwner: 'list' as const,
  }),
  Object.freeze({
    id: 'comments' as const,
    title: 'Comments',
    retention: 'discard' as const,
    retainedState: 'nothing: comment rows, the opaque next link, the 30-record window, scroll,'
      + ' reply expansion and any draft remount from defaults',
    readPlane: 'comments' as const,
    scrollOwner: 'list' as const,
  }),
  Object.freeze({
    id: 'sessions' as const,
    title: 'Sessions',
    retention: 'discard' as const,
    retainedState: 'nothing; there is no provider or Session-store read to keep alive',
    readPlane: 'linkedSessions' as const,
    scrollOwner: 'list' as const,
  }),
] as const);

/** The tab a body opens on. */
export const BITBUCKET_DEFAULT_DETAIL_TAB_V1: BitbucketDetailTabIdV1 = 'overview';
