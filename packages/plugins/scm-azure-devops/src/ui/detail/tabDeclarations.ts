/**
 * The Azure DevOps detail body's tab declarations.
 *
 * The shared tab primitive treats an omitted retention as `discard`, so a panel
 * that says nothing acquires a lifetime by accident. This module is the one
 * place that states each panel's lifetime, exactly what survives a leave, which
 * read owns its data, and which component owns its vertical scroll.
 *
 * There is exactly one entry kind on this forge, so there is one composition.
 * Work Items are not pull requests and are deliberately not a tab here.
 *
 * The detail ROOT owns the iteration read that `Activity` and `Files` share.
 * Neither tab reads the iteration list itself, and that is not a convention: two
 * readers would answer from two snapshots, and the tab that lost the race would
 * compare against an iteration the other one has already moved past.
 */

export type AzureDetailTabIdV1 =
  | 'overview'
  | 'activity'
  | 'files'
  | 'policies'
  | 'threads';

/** Which read a panel's content comes from. */
export type AzureDetailTabReadPlaneV1 =
  /** The applied observation only; this panel issues no provider read. */
  | 'observation'
  /** The shared iteration projection plus the paged pull-request commits. */
  | 'activity'
  /** The shared iteration projection plus that iteration's changed files. */
  | 'files'
  /** The pull request's statuses and its project's policy evaluations. */
  | 'policies'
  /** The one all-returned review-thread response. */
  | 'threads';

export type AzureDetailTabDeclarationV1 = Readonly<{
  id: AzureDetailTabIdV1;
  title: string;
  titleKey: string;
  /** Stated on every concrete tab; never inherited from the shared default. */
  retention: 'retain' | 'discard';
  /** Exactly what survives a tab leave, in this panel and nothing else. */
  retainedState: string;
  readPlane: AzureDetailTabReadPlaneV1;
  /** The single component that owns this panel's vertical scrolling. */
  scrollOwner: 'scrollArea' | 'list';
}>;

export const AZURE_DETAIL_TABS_V1: readonly AzureDetailTabDeclarationV1[] = Object.freeze([
  Object.freeze({
    id: 'overview' as const,
    title: 'Overview',
    titleKey: 'plugins.azureDevops.ui.tab.overview',
    retention: 'retain' as const,
    retainedState: 'its one reader scroll anchor only; it holds no provider read to keep',
    readPlane: 'observation' as const,
    scrollOwner: 'scrollArea' as const,
  }),
  Object.freeze({
    id: 'activity' as const,
    title: 'Activity',
    titleKey: 'plugins.azureDevops.ui.tab.activity',
    retention: 'discard' as const,
    retainedState: 'nothing: commit pages, the provider continuation token, the chronology'
      + ' rows, scroll and expansions remount from defaults',
    readPlane: 'activity' as const,
    scrollOwner: 'list' as const,
  }),
  Object.freeze({
    id: 'files' as const,
    title: 'Files',
    titleKey: 'plugins.azureDevops.ui.tab.files',
    retention: 'retain' as const,
    retainedState: 'the parsed changed-file page model, provider-issued skip/top and its one'
      + ' visible-file scroll anchor; pending reads, file selection/copy/Action state and any'
      + ' hunk or body diff are discarded while B6 is held',
    readPlane: 'files' as const,
    scrollOwner: 'list' as const,
  }),
  Object.freeze({
    id: 'policies' as const,
    title: 'Policies',
    titleKey: 'plugins.azureDevops.ui.tab.policies',
    retention: 'discard' as const,
    retainedState: 'nothing: statuses, policy and build projections, scroll and expansion'
      + ' remount from defaults',
    readPlane: 'policies' as const,
    scrollOwner: 'list' as const,
  }),
  Object.freeze({
    id: 'threads' as const,
    title: 'Threads',
    titleKey: 'plugins.azureDevops.ui.tab.threads',
    retention: 'discard' as const,
    retainedState: 'nothing: the all-returned response, the 18-thread and 2-reply windows,'
      + ' scroll, expansions and any reply draft remount from defaults',
    readPlane: 'threads' as const,
    scrollOwner: 'list' as const,
  }),
] as const);

/** The tab a body opens on. */
export const AZURE_DEFAULT_DETAIL_TAB_V1: AzureDetailTabIdV1 = 'overview';

/**
 * The reader's thread window, and the replies each thread opens with.
 *
 * They are presentation windows over one already-loaded response, not
 * pagination: the documented thread endpoint publishes no cursor, so expanding
 * either one issues no request.
 */
export const AZURE_THREAD_WINDOW_V1 = 18;
export const AZURE_THREAD_REPLY_WINDOW_V1 = 2;
