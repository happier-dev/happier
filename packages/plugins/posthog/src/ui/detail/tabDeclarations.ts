/**
 * The PostHog detail body's tab declarations.
 *
 * The shared tab primitive treats an omitted retention as `discard`, so a panel that
 * says nothing acquires a lifetime by accident. This module is the one place that states
 * each panel's lifetime, what it keeps across a leave, which read owns its data, and
 * which component owns its vertical scroll — the facts the rendered surface then follows
 * rather than restating inline, and the facts a test can check without mounting a
 * device.
 *
 * `readPlane` is the ownership statement that matters most here. Occurrences, Stack
 * Trace and Affected Sessions are three views of one detail-instance sample: they are
 * consumers, never loaders. A second read plane among them would be a second owner of
 * the same sampled rows, which is how a duplicate fetch, a panel-local cache, or a
 * cancellation that kills a sibling's data gets introduced. Activity is the exception
 * that proves the rule: it reads a different provider route on a different lifetime, so
 * it declares its own plane rather than borrowing one it does not read from.
 */

export type PosthogDetailTabIdV1 =
    | 'overview'
    | 'occurrences'
    | 'stack-trace'
    | 'affected-sessions'
    | 'activity';

/** Which read a panel's content comes from. */
export type PosthogDetailTabReadPlaneV1 =
    /** The applied observation, replaced by the live entry materialization. */
    | 'entryMaterialization'
    /** The one detail-instance sampled-occurrence loader. */
    | 'detailInstanceSample'
    /** The Activity panel's own page-numbered read, owned by its active interval. */
    | 'activityPage';

export type PosthogDetailTabDeclarationV1 = Readonly<{
    id: PosthogDetailTabIdV1;
    title: string;
    /** Stated on every concrete tab; never inherited from the shared default. */
    retention: 'retain' | 'discard';
    /** Exactly what survives a tab leave, in this panel and nothing else. */
    retainedState: string;
    readPlane: PosthogDetailTabReadPlaneV1;
    /** The single component that owns this panel's vertical scrolling. */
    scrollOwner: 'scrollArea' | 'list';
}>;

export const POSTHOG_DETAIL_TABS_V1: readonly PosthogDetailTabDeclarationV1[] = Object.freeze([
    Object.freeze({
        id: 'overview' as const,
        title: 'Overview',
        retention: 'retain' as const,
        retainedState: 'its one vertical scroll offset and settled presentation state for'
            + ' the current exact detail instance',
        readPlane: 'entryMaterialization' as const,
        scrollOwner: 'scrollArea' as const,
    }),
    Object.freeze({
        id: 'occurrences' as const,
        title: 'Occurrences',
        retention: 'retain' as const,
        retainedState: 'its one vertical scroll anchor, list window and row focus; the'
            + ' selected occurrence and the sampled rows stay owned by the detail-root'
            + ' controller',
        readPlane: 'detailInstanceSample' as const,
        scrollOwner: 'list' as const,
    }),
    Object.freeze({
        id: 'stack-trace' as const,
        title: 'Stack trace',
        retention: 'retain' as const,
        retainedState: 'its one vertical scroll anchor, list window and non-sensitive'
            + ' frame disclosure state for the controller’s selected occurrence',
        readPlane: 'detailInstanceSample' as const,
        scrollOwner: 'list' as const,
    }),
    Object.freeze({
        id: 'affected-sessions' as const,
        title: 'Affected sessions',
        retention: 'retain' as const,
        retainedState: 'its one vertical scroll anchor and list window only; the'
            + ' session-to-row correlation is derived afresh on re-entry',
        readPlane: 'detailInstanceSample' as const,
        scrollOwner: 'list' as const,
    }),
    Object.freeze({
        id: 'activity' as const,
        title: 'Activity',
        // The only panel that keeps nothing. Its rows, page position, total and errors
        // belong to one active interval, so a leave discards them rather than showing a
        // reader a record set that is no longer being read.
        retention: 'discard' as const,
        retainedState: 'nothing across a tab leave',
        readPlane: 'activityPage' as const,
        scrollOwner: 'list' as const,
    }),
] as const);

const BY_ID: ReadonlyMap<PosthogDetailTabIdV1, PosthogDetailTabDeclarationV1> = new Map(
    POSTHOG_DETAIL_TABS_V1.map((tab) => [tab.id, tab]),
);

export function posthogDetailTabDeclaration(
    id: PosthogDetailTabIdV1,
): PosthogDetailTabDeclarationV1 {
    const declaration = BY_ID.get(id);
    if (declaration === undefined) {
        throw new Error(`PostHog detail tab '${id}' is not declared.`);
    }
    return declaration;
}
