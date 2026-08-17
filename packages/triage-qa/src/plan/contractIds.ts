/**
 * The requirement and invariant ids `PLAN.md` declares. Parsed from the authored
 * table rows in sections 2 and 3 so a mention anywhere else in the document —
 * prose, a lane row, a blocker table — cannot invent a contract id.
 */
export type ContractIdInventory = Readonly<{
    requirements: readonly string[];
    invariants: readonly string[];
    /** Every declared id, requirements first, each in authored order. */
    all: readonly string[];
}>;

const REQUIREMENTS_HEADING = /^##\s+2\.\s/;
const INVARIANTS_HEADING = /^##\s+3\.\s/;
const NEXT_SECTION = /^##\s/;

function sectionLines(markdown: string, heading: RegExp): readonly string[] {
    const lines = markdown.split('\n');
    const start = lines.findIndex((line) => heading.test(line));
    if (start < 0) return [];
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => NEXT_SECTION.test(line));
    return end < 0 ? rest : rest.slice(0, end);
}

function declaredIds(lines: readonly string[], prefix: string): readonly string[] {
    const rowPattern = new RegExp(`^\\|\\s*\`(${prefix}-\\d+)\`\\s*\\|`);
    const ids: string[] = [];
    for (const line of lines) {
        const match = rowPattern.exec(line);
        if (match?.[1] !== undefined) ids.push(match[1]);
    }
    return Object.freeze(ids);
}

/** Parses the declared `REQ-*` and `INV-*` ids out of current `PLAN.md` bytes. */
export function parseContractIds(planMarkdown: string): ContractIdInventory {
    const requirements = declaredIds(sectionLines(planMarkdown, REQUIREMENTS_HEADING), 'REQ');
    const invariants = declaredIds(sectionLines(planMarkdown, INVARIANTS_HEADING), 'INV');
    return Object.freeze({
        requirements,
        invariants,
        all: Object.freeze([...requirements, ...invariants]),
    });
}
