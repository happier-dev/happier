/**
 * The Sentry detail body's tab declarations.
 *
 * The shared tab primitive treats an omitted retention as `discard`, so a panel
 * that says nothing acquires a lifetime by accident. `SENTRY.md` §7.2b forbids
 * that outright here: this module is the one place that states each panel's
 * lifetime, exactly what survives a leave, which read owns its data, and which
 * component owns its vertical scroll — the facts the rendered surface follows
 * rather than restating inline, and the facts a test can check without mounting
 * a device.
 *
 * `retainedState` is deliberately narrow. Retention on this source buys list
 * geometry and nothing else: every panel's loaded projection is discarded when
 * its active interval ends, whether or not its subtree stays mounted. That is
 * the §7.2b rule that keeps Tier-B event rows, tag values and activity records
 * out of an inactive panel — retention is a scroll-position concession, never
 * permission to keep sensitive results.
 *
 * `readPlane` is the ownership statement. Overview and Release association read
 * two different closed projections of the same issue resource on two different
 * lifetimes: the Tier-A summary belongs to the detail root, because the Release
 * tab's very presence depends on it, while the Tier-B tag distribution belongs
 * to the Overview panel alone so the detail root holds no tag value at all.
 *
 * Stack Trace is the third panel whose data it does not own. It renders the
 * detail-root selected-event controller's one projection — the same one Overview
 * summarizes and an explicitly revealed occurrence detail shows — and adds no read.
 * That is what lets it be a peer tab without costing a second event body, and it is
 * why the exact detail instance rather than a tab mount is the privacy boundary.
 */

export type SentryDetailTabIdV1 =
  | 'overview'
  | 'occurrences'
  | 'stack-trace'
  | 'release'
  | 'activity';

/** Which read a panel's content comes from. */
export type SentryDetailTabReadPlaneV1 =
  /** The applied observation, plus the detail root's Tier-A issue summary. */
  | 'issueSummary'
  /** The Overview panel's own Tier-B tag-distribution read and its drill-down. */
  | 'issueTags'
  /** The Occurrences panel's own cursor-paged retained-events walk. */
  | 'issueEvents'
  /** The detail root's one selected-event controller, which Stack Trace only reads. */
  | 'selectedEvent'
  /** The Activity panel's own Tier-B activity read. */
  | 'issueActivity';

export type SentryDetailTabDeclarationV1 = Readonly<{
  id: SentryDetailTabIdV1;
  /**
   * The English wording, and the fallback a locale with no entry falls back to.
   *
   * A tab title reaches the shared strip as a plain string, so a declaration
   * with no key renders English on ten of the eleven locales this plugin ships
   * and nothing fails — the silent half of a missing translation.
   */
  title: string;
  /** The catalog key that title is resolved through, in every shipped locale. */
  titleKey: string;
  /** Stated on every concrete tab; never inherited from the shared default. */
  retention: 'retain' | 'discard';
  /** Exactly what survives a tab leave, in this panel and nothing else. */
  retainedState: string;
  readPlane: SentryDetailTabReadPlaneV1;
  /** The single component that owns this panel's vertical scrolling. */
  scrollOwner: 'scrollArea' | 'list';
  /**
   * `true` when the tab is present only while its condition holds. A conditional
   * tab's condition is evaluated by the body before the strip renders, which is
   * why its data cannot be read inside its own panel.
   */
  conditional: boolean;
}>;

export const SENTRY_DETAIL_TABS_V1: readonly SentryDetailTabDeclarationV1[] = Object.freeze([
  Object.freeze({
    id: 'overview' as const,
    title: 'Overview',
    titleKey: 'plugins.sentry.ui.tab.overview',
    // The panel that carries the tag distribution and its drill-down keeps
    // nothing: leaving discards every tag value and reveal it held.
    retention: 'discard' as const,
    retainedState: 'nothing across a tab leave',
    readPlane: 'issueTags' as const,
    scrollOwner: 'scrollArea' as const,
    conditional: false,
  }),
  Object.freeze({
    id: 'occurrences' as const,
    title: 'Occurrences',
    titleKey: 'plugins.sentry.ui.tab.occurrences',
    retention: 'retain' as const,
    retainedState: 'its one vertical list viewport and scroll anchor only; the loaded'
      + ' event rows, page position and errors are discarded when the panel'
      + ' becomes inactive',
    readPlane: 'issueEvents' as const,
    scrollOwner: 'list' as const,
    conditional: false,
  }),
  Object.freeze({
    id: 'stack-trace' as const,
    title: 'Stack Trace',
    titleKey: 'plugins.sentry.ui.tab.stackTrace',
    retention: 'retain' as const,
    retainedState: 'its frame window, scroll anchor and system-frame expansion only; the'
      + ' event projection stays in the detail-root controller and every expansion'
      + ' derivative is discarded when the panel becomes inactive',
    readPlane: 'selectedEvent' as const,
    scrollOwner: 'list' as const,
    // Present only while the current selected projection carries an exception or
    // stacktrace section. A performance or feedback issue with no trace is not
    // given an empty error-specific tab.
    conditional: true,
  }),
  Object.freeze({
    id: 'release' as const,
    title: 'Release association',
    titleKey: 'plugins.sentry.ui.tab.release',
    retention: 'discard' as const,
    retainedState: 'nothing; its Tier-A fields are cheap derivatives of the detail'
      + ' root’s current issue summary',
    readPlane: 'issueSummary' as const,
    scrollOwner: 'scrollArea' as const,
    // Present only when the summary yielded at least one parseable release
    // version. An issue with no release association is not given an empty tab.
    conditional: true,
  }),
  Object.freeze({
    id: 'activity' as const,
    title: 'Activity',
    titleKey: 'plugins.sentry.ui.tab.activity',
    retention: 'discard' as const,
    retainedState: 'nothing across a tab leave',
    readPlane: 'issueActivity' as const,
    scrollOwner: 'list' as const,
    conditional: false,
  }),
] as const);

const BY_ID: ReadonlyMap<SentryDetailTabIdV1, SentryDetailTabDeclarationV1> = new Map(
  SENTRY_DETAIL_TABS_V1.map((tab) => [tab.id, tab]),
);

export function sentryDetailTabDeclaration(
  id: SentryDetailTabIdV1,
): SentryDetailTabDeclarationV1 {
  const declaration = BY_ID.get(id);
  if (declaration === undefined) {
    throw new Error(`Sentry detail tab '${id}' is not declared.`);
  }
  return declaration;
}

/**
 * The tabs a body with this evidence may show, in declaration order.
 *
 * A conditional tab whose condition is false is absent from the strip rather
 * than present and empty, and a selection that lands on an absent tab falls back
 * once to the default (`SENTRY.md` §7.5a).
 */
export type SentryDetailTabEvidenceV1 = Readonly<{
  hasReleaseAssociation: boolean;
  /** The current selected-event projection carries an exception or stacktrace. */
  hasTraceEvidence: boolean;
}>;

const CONDITION: Readonly<Record<string, (evidence: SentryDetailTabEvidenceV1) => boolean>> = {
  release: (evidence) => evidence.hasReleaseAssociation,
  'stack-trace': (evidence) => evidence.hasTraceEvidence,
};

export function sentryVisibleDetailTabs(
  evidence: SentryDetailTabEvidenceV1,
): readonly SentryDetailTabDeclarationV1[] {
  return SENTRY_DETAIL_TABS_V1.filter(
    (tab) => !tab.conditional || (CONDITION[tab.id]?.(evidence) ?? false),
  );
}

/** The tab a body opens on, and the one a removed selection falls back to. */
export const SENTRY_DEFAULT_DETAIL_TAB_V1: SentryDetailTabIdV1 = 'overview';

export function sentryResolveSelectedTab(
  selected: SentryDetailTabIdV1,
  visible: readonly SentryDetailTabDeclarationV1[],
): SentryDetailTabIdV1 {
  return visible.some((tab) => tab.id === selected)
    ? selected
    : SENTRY_DEFAULT_DETAIL_TAB_V1;
}
