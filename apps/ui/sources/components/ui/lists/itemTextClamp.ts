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

/** `Item` gives a title with a subtitle beneath it a single line. */
export const ITEM_TITLE_MAX_LINES_WITH_SUBTITLE = 1;

/** With no subtitle the title may take a second line before it truncates. */
export const ITEM_TITLE_MAX_LINES_WITHOUT_SUBTITLE = 2;

/**
 * The title clamp. `hasSubtitle` is the truthiness of the `subtitle` prop, i.e. whether `Item`
 * paints anything beneath the title — a non-string subtitle node counts, because it occupies the
 * same space.
 */
export function resolveItemTitleMaxLines(hasSubtitle: boolean): number {
    return hasSubtitle ? ITEM_TITLE_MAX_LINES_WITH_SUBTITLE : ITEM_TITLE_MAX_LINES_WITHOUT_SUBTITLE;
}

/**
 * The clamp for one painted subtitle string. `null` means the box grows with its content.
 *
 * An explicit `subtitleLines` wins, with `0` (or less) meaning "auto/multiline". Otherwise a
 * subtitle carrying a hard line break paints unbounded and one without is a single line.
 */
export function resolveItemSubtitleMaxLines(
    params: Readonly<{ text: string; subtitleLines: number | undefined }>,
): number | null {
    if (params.subtitleLines !== undefined) {
        return params.subtitleLines <= 0 ? null : params.subtitleLines;
    }
    return params.text.indexOf('\n') === -1 ? 1 : null;
}
