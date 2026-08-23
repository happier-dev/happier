/**
 * Where one detail-plane page walk stands after a page.
 *
 * Both source-native detail reads page a provider collection, and both had the same
 * hole: two different outcomes shared one `null`. The provider stating that this is the
 * last page, and the provider naming a next position this source will not use, are
 * opposite facts — and a panel that receives no continuation for either one tells its
 * reader "that was everything" in both cases.
 *
 * The two planes page differently. Activity is page-numbered and its next position comes
 * out of a provider-controlled `next` URL; sampled occurrences are offset-based and the
 * position is a number the provider states or the source derives. What is identical is
 * the three-way answer, so it is stated once here rather than twice with a drift between
 * them waiting to happen.
 *
 * `position` is provider-native and plane-specific: a one-based page for Activity, a
 * row offset for the sampled read. Neither is a watermark, and neither survives the
 * invocation that produced it.
 */
export type PosthogPageWalkV1 =
    /** The provider itself stated there is nothing after this page. */
    | Readonly<{ kind: 'exhausted' }>
    /** A next position this source verified and may request. */
    | Readonly<{ kind: 'continues'; position: number }>
    /**
     * The provider named more, and this source will not walk to it — the position does
     * not advance, does not address this exact route, or will not parse. The rows read
     * are real; the collection is not finished.
     */
    | Readonly<{ kind: 'stoppedShort' }>;

export const POSTHOG_WALK_EXHAUSTED: PosthogPageWalkV1 = Object.freeze({ kind: 'exhausted' });
export const POSTHOG_WALK_STOPPED_SHORT: PosthogPageWalkV1 = Object.freeze({
    kind: 'stoppedShort',
});
