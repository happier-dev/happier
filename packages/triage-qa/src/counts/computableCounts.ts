/**
 * `PLAN.md` §7.3 / `D-7`: no document states a number a command can compute.
 *
 * The rule exists because a hand-typed number has no mechanism to become wrong
 * out loud. This check therefore refuses to be a second hand-maintained list of
 * forbidden numbers: a caller supplies the populations it can actually compute
 * from current bytes, and the check reports every place a document spells one
 * of them out. A stated count is a finding whether or not it currently agrees —
 * §7.3 says such counts appear as the command that produces them, or not at all
 * — and the computed value travels with the finding so a reviewer sees drift
 * immediately.
 */

/** One population whose size a command computes from current corpus bytes. */
export type ComputablePopulation = Readonly<{
    /** How a reviewer names the population, e.g. `deciding rows`. */
    label: string;
    /** The exact authored noun phrases that name this population in prose. */
    nouns: readonly string[];
    /** The size the harness computes from current bytes. */
    computed: number;
}>;

/** One authored document, as read by a caller that owns the filesystem. */
export type AuthoredDocument = Readonly<{ path: string; markdown: string }>;

export type StatedCountFinding = Readonly<{
    documentPath: string;
    line: number;
    population: string;
    /** The number the document states. */
    stated: number;
    /** The number the harness computes for that population right now. */
    computed: number;
    /** The exact authored phrase, for pointing a reader at the byte. */
    phrase: string;
}>;

const NUMBER_WORDS: ReadonlyMap<string, number> = new Map([
    ['two', 2], ['three', 3], ['four', 4], ['five', 5], ['six', 6], ['seven', 7],
    ['eight', 8], ['nine', 9], ['ten', 10], ['eleven', 11], ['twelve', 12],
    ['thirteen', 13], ['fourteen', 14], ['fifteen', 15], ['sixteen', 16],
    ['seventeen', 17], ['eighteen', 18], ['nineteen', 19], ['twenty', 20],
]);

const NUMBER_ALTERNATION = [...NUMBER_WORDS.keys(), '\\d[\\d,]*'].join('|');

function escapeNoun(noun: string): string {
    return noun.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function readNumber(token: string): number | undefined {
    const word = NUMBER_WORDS.get(token.toLowerCase());
    if (word !== undefined) return word;
    const digits = Number(token.replace(/,/gu, ''));
    return Number.isFinite(digits) ? digits : undefined;
}

/**
 * Reports every stated count of a computable population in the supplied
 * documents. Only plural noun phrases are matched: a population of one is not
 * the drift this rule exists to catch, and "one row" is ordinary prose.
 */
export function findStatedComputableCounts(input: Readonly<{
    documents: readonly AuthoredDocument[];
    populations: readonly ComputablePopulation[];
}>): readonly StatedCountFinding[] {
    const findings: StatedCountFinding[] = [];
    for (const population of input.populations) {
        const nouns = population.nouns.map(escapeNoun).join('|');
        const pattern = new RegExp(`\\b(${NUMBER_ALTERNATION})[ \\u2010-\\u2015-]+(${nouns})\\b`, 'giu');
        for (const document of input.documents) {
            for (const [index, line] of document.markdown.split('\n').entries()) {
                for (const match of line.matchAll(pattern)) {
                    const stated = readNumber(match[1] ?? '');
                    if (stated === undefined) continue;
                    findings.push(Object.freeze({
                        documentPath: document.path,
                        line: index + 1,
                        population: population.label,
                        stated,
                        computed: population.computed,
                        phrase: match[0],
                    }));
                }
            }
        }
    }
    return Object.freeze(findings);
}

/** Renders the stated-count findings for a reviewer. */
export function formatStatedCountFindings(findings: readonly StatedCountFinding[]): string {
    if (findings.length === 0) return 'No document states a count this harness can compute.';
    return findings
        .map((finding) => {
            const agreement = finding.stated === finding.computed
                ? 'agrees today'
                : `DISAGREES — the command computes ${finding.computed}`;
            return `${finding.documentPath}:${finding.line}: "${finding.phrase}"`
                + ` states the ${finding.population} count; ${agreement}.`;
        })
        .join('\n');
}
