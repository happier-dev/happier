import type { ParsedSearchQuery } from '@happier-dev/protocol';

/** Matches literal terms across a session, keeping phrases within one text field/message. */
export function createSessionSearchMatcher(query: ParsedSearchQuery, initialText = '') {
    const missing = new Set(query.terms);
    let excluded = false;
    const addText = (text: string) => {
        const haystack = text.toLocaleLowerCase();
        if (query.excludedTerms.some((term) => haystack.includes(term))) excluded = true;
        for (const term of missing) {
            if (haystack.includes(term)) missing.delete(term);
        }
    };
    addText(initialText);
    return {
        addText,
        get matched() { return !excluded && missing.size === 0; },
        get excluded() { return excluded; },
        get remainingTerms(): readonly string[] { return [...missing]; },
        // Exclusions require scanning the entire transcript, even after every positive term matched.
        get settled() { return excluded || (missing.size === 0 && query.excludedTerms.length === 0); },
    };
}
