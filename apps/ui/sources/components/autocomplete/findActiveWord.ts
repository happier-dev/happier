import {
    isComposerTokenBoundaryChar,
    parseComposerTokenEnd,
    resolveComposerSuggestionTriggers,
    type ComposerSuggestionKindId,
} from './composerSuggestionGrammar';

const ACTIVE_WORD_SCAN_LIMIT = 4096;

/**
 * Bounded so a pathological run of trigger characters (`@@@@@@…`) cannot make
 * every keystroke quadratic. No real token is preceded by 32 candidate triggers
 * on the same line.
 */
const MAX_TRIGGER_CANDIDATES = 32;

interface Selection {
    start: number;
    end: number;
}

export interface ActiveWord {
    word: string;           // Full token from trigger to its end (e.g. "@README.md")
    activeWord: string;     // Part from trigger to the cursor (e.g. "@READ")
    offset: number;         // Start offset of the token
    length: number;         // Length of the complete token
    activeLength: number;   // Length from trigger to the cursor
    endOffset: number;      // Exclusive end offset of the token (offset + length)
}

/**
 * Finds the composer suggestion token containing the cursor.
 *
 * Candidate triggers are collected backwards from the cursor, then each is
 * parsed FORWARD with `parseComposerTokenEnd`. Using one parser for both
 * directions is what fixes the historical asymmetry where the forward scan
 * accepted `@README.md` but the backward scan stopped dead on the `.` and
 * closed the suggestion list.
 *
 * `kinds` is the host's eligible-kind subset; the trigger characters follow from
 * it (INV-1). A host never passes trigger characters.
 */
export function findActiveWord(
    content: string,
    selection: Selection,
    kinds: readonly ComposerSuggestionKindId[],
): ActiveWord | undefined {
    // Only detect at a collapsed cursor, and never at the very start of the text
    // (there is no trigger character before it).
    if (selection.start !== selection.end) return undefined;
    if (selection.start === 0) return undefined;

    const triggers = resolveComposerSuggestionTriggers(kinds);
    if (triggers.length === 0) return undefined;

    const cursor = selection.start;
    const minIndex = Math.max(0, cursor - ACTIVE_WORD_SCAN_LIMIT);
    const maxEnd = Math.min(content.length, cursor + ACTIVE_WORD_SCAN_LIMIT);

    let candidates = 0;
    for (let index = cursor - 1; index >= minIndex; index -= 1) {
        const char = content.charAt(index);
        // A token never crosses a line, so neither does the search for one.
        if (char === '\n' || char === '\r') break;
        if (!(triggers as readonly string[]).includes(char)) continue;
        // A trigger only opens a token at a boundary: start of text, whitespace,
        // or a delimiter. This is what keeps `email@domain.com` inert.
        if (index > 0 && !isComposerTokenBoundaryChar(content.charAt(index - 1))) continue;

        const endOffset = parseComposerTokenEnd(content, index, maxEnd);
        if (endOffset >= cursor) {
            const word = content.slice(index, endOffset);
            const activeWord = content.slice(index, cursor);
            return {
                word,
                activeWord,
                offset: index,
                length: word.length,
                activeLength: activeWord.length,
                endOffset,
            };
        }

        candidates += 1;
        if (candidates >= MAX_TRIGGER_CANDIDATES) break;
    }

    return undefined;
}
