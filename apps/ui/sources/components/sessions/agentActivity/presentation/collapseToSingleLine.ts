/**
 * Flattens producer text into one line, or `null` when nothing is left.
 *
 * A row is one or two lines by construction, and `numberOfLines` clips at the line count, not at
 * the newline: a two-line activity preview arriving in a one-line slot would render its first line
 * and silently drop the rest. Collapsing the whitespace first keeps the whole sentence visible up
 * to the ellipsis, which is the honest truncation.
 */
export function collapseToSingleLine(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const collapsed = value.replace(/\s+/g, ' ').trim();
    return collapsed.length > 0 ? collapsed : null;
}
