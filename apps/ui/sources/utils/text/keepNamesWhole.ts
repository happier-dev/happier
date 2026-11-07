const INNER_HYPHEN = /(?<=[\p{L}\p{N}])-(?=[\p{L}\p{N}])/gu;

/**
 * A name shown inside running text ("NLDW3-5-36-33", "vps-2") wraps between words, never at its own hyphens
 * (lab rule K12-5): each hyphen between letters or digits becomes a non-breaking hyphen. Display only; the
 * value a caller stores, compares or copies stays the original.
 */
export function keepNamesWhole(text: string): string {
    return text.replace(INNER_HYPHEN, '‑');
}
