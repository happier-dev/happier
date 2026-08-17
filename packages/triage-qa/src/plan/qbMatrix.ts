/** One deciding-behaviour row of the `qa/QA-PROTOCOL.md` section 2 matrix. */
export type QbMatrixRow = Readonly<{
    id: string;
    /** The `### 2.n` subsection heading the row was authored under. */
    section: string;
    /** Column 2 — setup and exact observable. */
    observable: string;
    /** Column 3 — the wrong implementation the row rejects. */
    rejects: string;
    /** Column 4 — the exact contract ids this row decides. */
    covers: readonly string[];
    /** 1-indexed line of the authored row, for pointing a reader at the byte. */
    line: number;
}>;

/** A line whose first cell is a `QB-nn` id but whose column count is not four. */
export type QbMalformedRow = Readonly<{ id: string; cellCount: number; line: number }>;

/** One explicit retirement, with the exact sentence line that retires the id. */
export type QbRetirement = Readonly<{ id: string; line: number }>;

/**
 * Every mention one part of the document makes of a deciding row id, outside
 * that row's own first cell and outside the retirement sentences.
 */
export type QbRowReference = Readonly<{
    id: string;
    lines: readonly number[];
    /**
     * True when every mention came from a `QB-x through QB-y` span. A span may
     * legitimately pass over a retired id; an individual mention may not.
     */
    spanOnly: boolean;
}>;

/** One section 4 sentence that composes deciding rows into a named recipe. */
export type QbRecipeDefinition = Readonly<{
    line: number;
    text: string;
    /** The rows the sentence resolves to, spans expanded, in id order. */
    rows: readonly string[];
}>;

/** One row the document marks as unrunnable until a named producer lands. */
export type QbProducerGate = Readonly<{ id: string; blockers: readonly string[] }>;

export type QbMatrix = Readonly<{
    rows: readonly QbMatrixRow[];
    /** Lines whose first cell is a QB id but that do not carry four columns. */
    malformedRows: readonly QbMalformedRow[];
    /** Ids the document explicitly retires and forbids reusing. */
    retired: readonly QbRetirement[];
    /**
     * The single contract id the document exempts from needing a runtime row,
     * together with the corpus-relative document it names as owning that id's
     * deciding check.
     */
    runtimeRowException: Readonly<{ contractId: string; decidingCheckDocument: string }> | undefined;
}>;

const MATRIX_ROW = /^\|\s*(QB-\d+)\s*\|/;
const SUBSECTION = /^###\s+(2\.\d+[^\n]*)$/;
const RETIREMENT_SENTENCE = /\b(?:is|are)\s+retired\b/;
const BACKTICKED_QB = /`(QB-\d+)`/g;
const QB_TOKEN = /\bQB-(\d+)\b/g;
const SPAN = /\bQB-(\d+)\b\s+through\s+\bQB-(\d+)\b/g;
const PRODUCER_GATE = /Producer-gated|owner-gated|remains? `?UNRUN`?|is unrun/iu;
const BLOCKER_TOKEN = /`([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)`/gu;
const RUNTIME_ROW_EXCEPTION =
    /`(REQ-\d+|INV-\d+)`\s+is\s+the\s+sole\s+runtime-row\s+exception[\s\S]*?`([^`]+\.md)`\s+owns\s+its\s+deciding\s+document\s+check/;

function splitRow(line: string): readonly string[] {
    const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    return trimmed.split('|').map((cell) => cell.trim());
}

function parseCovers(cell: string): readonly string[] {
    return Object.freeze(
        cell
            .split(',')
            .map((token) => token.trim().replace(/^`/, '').replace(/`$/, ''))
            .filter((token) => token.length > 0),
    );
}

/** Renders a row number in the document's authored two-digit form. */
export function qbId(rowNumber: number): string {
    return `QB-${String(rowNumber).padStart(2, '0')}`;
}

/**
 * Parses the section 2 deciding-behaviour matrix out of current
 * `qa/QA-PROTOCOL.md` bytes. `Covers` is the sole coverage authority, so this
 * reader takes column four verbatim and never expands, infers, or repairs an
 * id. A row whose column count is wrong is reported rather than guessed at:
 * reading whichever cell happens to be last would silently take prose as
 * coverage authority.
 */
export function parseQbMatrix(protocolMarkdown: string): QbMatrix {
    const lines = protocolMarkdown.split('\n');
    const rows: QbMatrixRow[] = [];
    const malformedRows: QbMalformedRow[] = [];
    const retired: QbRetirement[] = [];
    let section = '';
    for (const [index, line] of lines.entries()) {
        const subsection = SUBSECTION.exec(line);
        if (subsection?.[1] !== undefined) {
            section = subsection[1];
            continue;
        }
        const rowMatch = MATRIX_ROW.exec(line);
        if (rowMatch === null) {
            if (RETIREMENT_SENTENCE.test(line)) {
                for (const token of line.matchAll(BACKTICKED_QB)) {
                    if (token[1] !== undefined) retired.push(Object.freeze({ id: token[1], line: index + 1 }));
                }
            }
            continue;
        }
        const cells = splitRow(line);
        const [id, observable, rejects, covers] = cells;
        if (
            id === undefined || observable === undefined || rejects === undefined
            || covers === undefined || cells.length !== 4
        ) {
            malformedRows.push(Object.freeze({
                id: rowMatch[1] ?? '',
                cellCount: cells.length,
                line: index + 1,
            }));
            continue;
        }
        rows.push(Object.freeze({
            id,
            section,
            observable,
            rejects,
            covers: parseCovers(covers),
            line: index + 1,
        }));
    }
    const exception = RUNTIME_ROW_EXCEPTION.exec(protocolMarkdown);
    return Object.freeze({
        rows: Object.freeze(rows),
        malformedRows: Object.freeze(malformedRows),
        retired: Object.freeze(retired),
        runtimeRowException: exception?.[1] !== undefined && exception[2] !== undefined
            ? Object.freeze({ contractId: exception[1], decidingCheckDocument: exception[2] })
            : undefined,
    });
}

type ReferenceScope = Readonly<{ rowLines: ReadonlySet<number>; retirementLines: ReadonlySet<number> }>;

/**
 * Reads every reference one part of the document makes to a deciding row —
 * section 2's cross-references and section 4's evidence-vertical, live-recipe
 * and platform-lane definitions.
 *
 * A `QB-x through QB-y` span is expanded so deleting an interior row cannot
 * silently shrink a declared recipe. A span legitimately passes over a retired
 * id, so span members are recorded as span-sourced; an individual mention of a
 * retired id is a live reference.
 */
export function parseQbRowReferences(
    protocolMarkdown: string,
    scope: ReferenceScope,
): readonly QbRowReference[] {
    const collected = new Map<string, { lines: number[]; spanOnly: boolean }>();
    const record = (id: string, line: number, fromSpan: boolean): void => {
        const existing = collected.get(id) ?? { lines: [], spanOnly: true };
        existing.lines.push(line);
        if (!fromSpan) existing.spanOnly = false;
        collected.set(id, existing);
    };

    for (const [index, rawLine] of protocolMarkdown.split('\n').entries()) {
        const lineNumber = index + 1;
        if (scope.retirementLines.has(lineNumber)) continue;
        // A row declares its own id in its first cell; only the rest of that
        // line can reference another row.
        const line = scope.rowLines.has(lineNumber) ? rawLine.replace(MATRIX_ROW, '') : rawLine;

        const spans: [number, number][] = [];
        for (const span of line.matchAll(SPAN)) {
            const from = Number(span[1]);
            const to = Number(span[2]);
            spans.push([span.index, span.index + span[0].length]);
            for (let value = Math.min(from, to); value <= Math.max(from, to); value += 1) {
                record(qbId(value), lineNumber, true);
            }
        }

        for (const token of line.matchAll(QB_TOKEN)) {
            if (spans.some(([start, end]) => token.index >= start && token.index < end)) continue;
            record(qbId(Number(token[1])), lineNumber, false);
        }
    }

    return Object.freeze([...collected].map(([id, entry]) => Object.freeze({
        id,
        lines: Object.freeze(entry.lines),
        spanOnly: entry.spanOnly,
    })));
}

/**
 * Derives the recipe and evidence-vertical definitions section 4 states in
 * prose. Each is the sentence that owns it plus the exact rows it resolves to,
 * spans expanded. Nothing is copied into a second table, so a rewording changes
 * the sentence but not the derivation.
 */
export function deriveQbRecipeDefinitions(
    protocolMarkdown: string,
    scope: ReferenceScope,
): readonly QbRecipeDefinition[] {
    const definitions: QbRecipeDefinition[] = [];
    for (const [index, line] of protocolMarkdown.split('\n').entries()) {
        const lineNumber = index + 1;
        if (scope.rowLines.has(lineNumber) || scope.retirementLines.has(lineNumber)) continue;
        const references = parseQbRowReferences(line, {
            rowLines: new Set<number>(),
            retirementLines: new Set<number>(),
        });
        if (references.length === 0) continue;
        definitions.push(Object.freeze({
            line: lineNumber,
            text: line.trim(),
            rows: Object.freeze(references.map((reference) => reference.id).sort()),
        }));
    }
    return Object.freeze(definitions);
}

/** Reads the rows section 2 marks as gated on a named external producer. */
export function parseQbProducerGates(protocolMarkdown: string): readonly QbProducerGate[] {
    const gates: QbProducerGate[] = [];
    for (const line of protocolMarkdown.split('\n')) {
        const rowMatch = MATRIX_ROW.exec(line);
        if (rowMatch?.[1] === undefined || !PRODUCER_GATE.test(line)) continue;
        const blockers = [...line.matchAll(BLOCKER_TOKEN)].map((match) => match[1] ?? '');
        gates.push(Object.freeze({
            id: rowMatch[1],
            blockers: Object.freeze([...new Set(blockers)]),
        }));
    }
    return Object.freeze(gates);
}
