import type { ProjectedObservationV1 } from '../corpus/fold/projectedObservation.js';

/**
 * The one answer to "does this entry match what the reader typed".
 *
 * The shell list and the Composer picker search the same device-local
 * projection, and they had two implementations of this one rule: different case
 * folding, different tokenization, and different fields. That is three ways for
 * the same query over the same rows to give two answers, and the reader who
 * cannot find in the picker what they just found in the list has no way to tell
 * which surface is wrong. So the rule lives here and both surfaces consume it.
 *
 * The searchable text is projected once, already folded, so a consumer cannot
 * hold unfolded text and compare it by hand: the only way to match is to pass
 * this owner's own terms against this owner's own text.
 */

/** One entry's searchable values, already folded. */
export type TriageEntrySearchTextV1 = readonly string[];

/** A reader's query, split and folded. Empty means "no query". */
export type TriageSearchTermsV1 = readonly string[];

/**
 * Case is folded with the locale-independent mapping on purpose.
 *
 * `toLocaleLowerCase` reads the device's own locale, so the same query over the
 * same rows would match on one user's machine and not on another's — a Turkish
 * locale maps `I` to `ı`, and a search for `Issue` would then miss every entry
 * titled `ISSUE`. The projection is source-neutral and device-local; its
 * matching must not depend on where the device is set up.
 */
export function foldTriageSearchValue(value: string): string {
    return value.toLowerCase();
}

/**
 * Every field a reader can search one entry by.
 *
 * All of them come from present observations, because an entry nothing reports
 * has no text to search. The set is deliberately wider than any one surface
 * displays: a reader who remembers the repository path or a phrase from the
 * summary is searching for the entry, not for the row's visible line.
 */
export function projectTriageEntrySearchText(
    observations: readonly ProjectedObservationV1[],
): TriageEntrySearchTextV1 {
    const text: string[] = [];
    for (const observation of observations) {
        if (observation.outcome.kind !== 'present') continue;
        const { snapshot, locator } = observation.outcome;
        for (const value of [snapshot.title, snapshot.summary, snapshot.scopeLabel, locator.displayPath]) {
            if (value === undefined || value === '') continue;
            text.push(foldTriageSearchValue(value));
        }
    }
    return Object.freeze(text);
}

/**
 * Whitespace separates terms, and every term must appear somewhere.
 *
 * Per-term matching rather than one contiguous needle, because the two facts a
 * reader combines are usually in different fields — a repository and a word
 * from the title — and requiring them to be adjacent in one field would refuse
 * the entry they are describing. Terms are unordered for the same reason.
 */
export function parseTriageSearchQuery(query: string): TriageSearchTermsV1 {
    const terms = foldTriageSearchValue(query).trim().split(/\s+/u).filter((term) => term !== '');
    return Object.freeze(terms);
}

export function triageEntryMatchesSearch(
    text: TriageEntrySearchTextV1,
    terms: TriageSearchTermsV1,
): boolean {
    if (terms.length === 0) return true;
    return terms.every((term) => text.some((value) => value.includes(term)));
}
