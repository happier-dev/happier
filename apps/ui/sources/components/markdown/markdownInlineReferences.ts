/**
 * Inline references: a Markdown link whose destination is `<scheme>:<target>` names something the
 * caller owns (a review finding cited in a walkthrough stop). The caller resolves the target to the
 * label and colours drawn where the author placed it, and receives its press; an unresolved or
 * unowned reference renders as its plain text. A reference is never an openable URL.
 */
export type MarkdownInlineReference = Readonly<{ label: string; foreground: string; background: string }>;

export type MarkdownInlineReferences = Readonly<{
    scheme: string;
    resolve: (target: string) => MarkdownInlineReference | null;
    onPress?: (target: string) => void;
}>;

/** The internal destination a resolved reference renders with; the link handling owner never opens it. */
export const MARKDOWN_INLINE_REFERENCE_HREF_PREFIX = 'happier-ref:';

export function buildMarkdownInlineReferenceHref(scheme: string, target: string): string {
    return `${MARKDOWN_INLINE_REFERENCE_HREF_PREFIX}${scheme}:${target}`;
}

/** The owner's target of a rendered reference link, or null when the link is not this owner's reference. */
export function readMarkdownInlineReferenceTarget(href: string, scheme: string): string | null {
    const prefix = buildMarkdownInlineReferenceHref(scheme, '');
    return href.startsWith(prefix) && href.length > prefix.length ? href.slice(prefix.length) : null;
}
