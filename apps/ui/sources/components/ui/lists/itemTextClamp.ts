/**
 * `Item`'s own text clamps, as DATA.
 *
 * `Item` paints its title and its string subtitle through `numberOfLines`, and those two clamps
 * decide how tall the row can get. They used to live only inside `Item.tsx`'s JSX, which meant a
 * consumer that needed to know the clamp — the transcript row's height-bearing paint descriptor —
 * had to hand-copy it (F-2, 2026-08-11). A hand-copied clamp is a second decision-maker: it can
 * drift from the render silently, and the guard that was supposed to catch the drift asserted the
 * copy against a literal rather than against the paint.
 *
 * So the rule lives here, `Item` renders from it, and any consumer that must reason about the
 * painted height reads the SAME function. This module is deliberately dependency-free so the
 * measurement path can import it without pulling the component in.
 */

/** A grouped `Item` gives a title with a subtitle or inline mark a single line. */
export const ITEM_TITLE_MAX_LINES_WITH_SUBTITLE = 1;

/** With no subtitle or inline mark a grouped title may take a second line before it truncates. */
export const ITEM_TITLE_MAX_LINES_WITHOUT_SUBTITLE = 2;

/**
 * The title clamp. `hasSubtitle` is the truthiness of the `subtitle` prop, i.e. whether `Item`
 * paints anything beneath the title — a non-string subtitle node counts, because it occupies the
 * same space. Page labels grow with their content; compact grouped rows retain their allowance.
 * An inline title mark also keeps a grouped title to one line.
 */
export function resolveItemTitleMaxLines(
    hasSubtitle: boolean,
    params: Readonly<{ page?: boolean; hasAccessory?: boolean }> = {},
): number | null {
    if (params.page === true) return null;
    return hasSubtitle || params.hasAccessory === true
        ? ITEM_TITLE_MAX_LINES_WITH_SUBTITLE
        : ITEM_TITLE_MAX_LINES_WITHOUT_SUBTITLE;
}

/**
 * A status subtitle — one led by a status mark (`subtitleLeading`: a presence or trouble dot) — says
 * something the reader must be able to read whole ("Happier 0.2.10 on this machine · 0.2.12
 * available"), so it wraps to this many lines instead of being cut in grouped rows. A plain grouped
 * description stays on one line, which keeps long index lists compact. Page descriptions grow with
 * their content so the consequence of a preference remains visible.
 */
export const ITEM_STATUS_SUBTITLE_MAX_LINES = 2;

/**
 * The clamp for one painted subtitle string. `null` means the box grows with its content.
 *
 * An explicit `subtitleLines` wins, with `0` (or less) meaning "auto/multiline". Otherwise page
 * descriptions paint unbounded. In grouped rows, a status subtitle takes up to
 * {@link ITEM_STATUS_SUBTITLE_MAX_LINES}, a subtitle carrying a hard line break paints unbounded,
 * and any other is a single line.
 */
export function resolveItemSubtitleMaxLines(
    params: Readonly<{ text: string; subtitleLines: number | undefined; status?: boolean; page?: boolean }>,
): number | null {
    if (params.subtitleLines !== undefined) {
        return params.subtitleLines <= 0 ? null : params.subtitleLines;
    }
    if (params.page === true) return null;
    if (params.status === true) return ITEM_STATUS_SUBTITLE_MAX_LINES;
    return params.text.indexOf('\n') === -1 ? 1 : null;
}
