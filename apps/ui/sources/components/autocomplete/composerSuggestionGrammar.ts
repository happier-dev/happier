/**
 * Composer suggestion TOKENS — trigger declarations, the kind -> trigger map
 * (INV-1), and the per-trigger token grammar.
 *
 * A composer suggestion token is `<trigger><value>` (optionally a quoted span).
 * This module is the single place that decides where such a token ends, how its
 * query is read back, and how a selected value is written into composer text.
 *
 * The detector (`findActiveWord`) and every token formatter share it, so a token
 * the picker inserts always re-parses to the same span (INV-3). Grammar is per
 * TRIGGER, never per kind: two kinds sharing `@` share one token shape.
 *
 * This module has NO React or sync dependencies on purpose: the detector and the
 * composer hosts must be able to resolve triggers without pulling the candidate
 * resolvers or row components in `composerSuggestionKinds.ts`.
 */

export const COMPOSER_SUGGESTION_TRIGGERS = ['@', '$', '/'] as const;

export type ComposerSuggestionTrigger = (typeof COMPOSER_SUGGESTION_TRIGGERS)[number];

type ComposerSuggestionTokenGrammar = Readonly<{
    /**
     * Whether `<trigger>"…"` spans are available for this trigger.
     *
     * Only `@` needs it: file paths, plugin refs and session refs can contain
     * spaces. Skill names and slash-command tokens cannot, so quoting there
     * would add a shape nothing produces or reads.
     */
    quoting: boolean;
}>;

const COMPOSER_SUGGESTION_TOKEN_GRAMMAR = {
    '@': { quoting: true },
    $: { quoting: false },
    '/': { quoting: false },
} as const satisfies Record<ComposerSuggestionTrigger, ComposerSuggestionTokenGrammar>;

/**
 * Characters that end an unquoted token, and that also open a fresh token
 * boundary in front of a trigger character.
 *
 * `.` `/` `\` `:` `-` `_` `~` `#` are deliberately ABSENT: they are ordinary
 * path, ref and command characters. `.` used to be a terminator, which is why a
 * single dot destroyed the suggestion list for `@README.md` and `/h.review`.
 */
const TOKEN_DELIMITERS: ReadonlySet<string> = new Set([
    ',', ';', '(', ')', '[', ']', '{', '}', '<', '>', '!', '?', '"',
]);

// Space, tab, CR/LF and NBSP. NBSP is included because mobile keyboards and pasted
// rich text produce it where the user typed a plain space.
const TOKEN_WHITESPACE: ReadonlySet<string> = new Set([' ', '\t', '\n', '\r', '\u00A0']);

export function isComposerSuggestionTrigger(value: string): value is ComposerSuggestionTrigger {
    return (COMPOSER_SUGGESTION_TRIGGERS as readonly string[]).includes(value);
}

/**
 * True when `char` ends an unquoted token. The same predicate answers "is a
 * trigger at this index at a word boundary?", which is what keeps `@` inside
 * `email@domain.com` from opening a mention while `(@user` still does.
 */
export function isComposerTokenBoundaryChar(char: string): boolean {
    return char.length === 0 || TOKEN_WHITESPACE.has(char) || TOKEN_DELIMITERS.has(char);
}

/**
 * Returns the exclusive end offset of the token that starts at `triggerIndex`.
 *
 * Used for BOTH the backward and the forward half of detection, so the two can
 * never disagree about where a token ends.
 */
export function parseComposerTokenEnd(content: string, triggerIndex: number, maxEnd: number): number {
    const trigger = content.charAt(triggerIndex);
    const grammar = isComposerSuggestionTrigger(trigger)
        ? COMPOSER_SUGGESTION_TOKEN_GRAMMAR[trigger]
        : null;
    let index = triggerIndex + 1;

    if (grammar?.quoting && content.charAt(index) === '"') {
        index += 1;
        while (index < maxEnd) {
            const char = content.charAt(index);
            // A token never crosses a line, even unterminated.
            if (char === '\n' || char === '\r') return index;
            if (char === '"') {
                // `""` is an escaped quote inside the span; a lone `"` closes it.
                if (content.charAt(index + 1) === '"') {
                    index += 2;
                    continue;
                }
                return index + 1;
            }
            index += 1;
        }
        return index;
    }

    while (index < maxEnd && !isComposerTokenBoundaryChar(content.charAt(index))) {
        index += 1;
    }
    return index;
}

/**
 * Splits an active word into its trigger and its search query, unquoting a
 * quoted span. `@"my file.ts"` searches for `my file.ts`, not `"my file.ts"`.
 */
export function parseComposerSuggestionQuery(activeWord: string): Readonly<{
    trigger: ComposerSuggestionTrigger;
    query: string;
}> | null {
    const trigger = activeWord.charAt(0);
    if (!isComposerSuggestionTrigger(trigger)) return null;

    const rest = activeWord.slice(1);
    if (!COMPOSER_SUGGESTION_TOKEN_GRAMMAR[trigger].quoting || !rest.startsWith('"')) {
        return { trigger, query: rest };
    }

    const body = rest.length >= 2 && rest.endsWith('"') ? rest.slice(1, -1) : rest.slice(1);
    return { trigger, query: body.replace(/""/g, '"') };
}

/**
 * Writes `value` as a token for `trigger`, quoting when the raw value would not
 * re-parse to itself. This is the inverse of `parseComposerTokenEnd` +
 * `parseComposerSuggestionQuery`, which is what INV-3 depends on.
 */
export function formatComposerSuggestionToken(trigger: ComposerSuggestionTrigger, value: string): string {
    if (!COMPOSER_SUGGESTION_TOKEN_GRAMMAR[trigger].quoting) return `${trigger}${value}`;

    let needsQuoting = value.length === 0;
    for (const char of value) {
        if (isComposerTokenBoundaryChar(char)) {
            needsQuoting = true;
            break;
        }
    }
    if (!needsQuoting) return `${trigger}${value}`;

    return `${trigger}"${value.replace(/"/g, '""')}"`;
}

export const COMPOSER_SUGGESTION_KIND_IDS = ['file', 'vendorPlugin', 'session', 'skill', 'slashCommand'] as const;

export type ComposerSuggestionKindId = (typeof COMPOSER_SUGGESTION_KIND_IDS)[number];

/**
 * The single trigger -> kind mapping (INV-1). Hosts declare an eligible-kind
 * subset; nothing outside this module turns a kind into a trigger character.
 */
const COMPOSER_SUGGESTION_KIND_TRIGGERS = {
    file: '@',
    vendorPlugin: '@',
    session: '@',
    skill: '$',
    slashCommand: '/',
} as const satisfies Record<ComposerSuggestionKindId, ComposerSuggestionTrigger>;

export function resolveComposerSuggestionTrigger(kind: ComposerSuggestionKindId): ComposerSuggestionTrigger {
    return COMPOSER_SUGGESTION_KIND_TRIGGERS[kind];
}

/** The trigger characters a host offering `kinds` detects, in declaration order. */
export function resolveComposerSuggestionTriggers(
    kinds: readonly ComposerSuggestionKindId[],
): readonly ComposerSuggestionTrigger[] {
    return COMPOSER_SUGGESTION_TRIGGERS.filter(
        (trigger) => kinds.some((kind) => COMPOSER_SUGGESTION_KIND_TRIGGERS[kind] === trigger),
    );
}

/** The eligible kind ids a host offers for one trigger, in declaration order. */
export function resolveComposerSuggestionKindIdsForTrigger(
    kinds: readonly ComposerSuggestionKindId[],
    trigger: ComposerSuggestionTrigger,
): readonly ComposerSuggestionKindId[] {
    return COMPOSER_SUGGESTION_KIND_IDS.filter(
        (kind) => kinds.includes(kind) && COMPOSER_SUGGESTION_KIND_TRIGGERS[kind] === trigger,
    );
}
