import { parseContractIds } from '../plan/contractIds.ts';
import {
    deriveQbRecipeDefinitions,
    parseQbMatrix,
    parseQbProducerGates,
    parseQbRowReferences,
    type QbMatrixRow,
    type QbProducerGate,
    type QbRecipeDefinition,
} from '../plan/qbMatrix.ts';
import { findUnrunCaseFiles, type EnumeratedCaseRunner } from './caseExecution.ts';
import { linkRunnableCases, type CaseSource, type RunnableCase } from './runnableCases.ts';

export type QbCoverageFindingCode =
    | 'uncovered-contract-id'
    | 'unknown-covers-id'
    | 'empty-covers-cell'
    | 'malformed-matrix-row'
    | 'duplicate-qb-id'
    | 'retired-qb-id-reused'
    | 'undeclared-row-reference'
    | 'retired-row-reference'
    | 'case-names-undeclared-row'
    | 'case-file-no-runner'
    | 'undeclared-exception-id'
    | 'exempt-id-also-covered'
    | 'unearned-runtime-row-exception';

export type QbCoverageFinding = Readonly<{
    code: QbCoverageFindingCode;
    /** The contract or QB id the finding is about. */
    id: string;
    message: string;
}>;

export type QbCoverageEntry = Readonly<{
    contractId: string;
    decidedBy: readonly string[];
    /** True when the id is covered by the declared runtime-row exception instead of a row. */
    exempt: boolean;
}>;

export type QbCoverageReport = Readonly<{
    /** True when no hard finding holds. Advisories do not close the gate. */
    ok: boolean;
    entries: readonly QbCoverageEntry[];
    /** Every failure mode this check can falsify, in discovery order. */
    findings: readonly QbCoverageFinding[];
    /**
     * Reported, not gating. The runtime-row exception is a document-authoring
     * disposition `qa/QA-PROTOCOL.md` section 3 hands to a named coherence
     * document, so an unearned one is surfaced for a reviewer instead of
     * holding a permanently red gate that lanes learn to ignore.
     */
    advisories: readonly QbCoverageFinding[];
    rowCount: number;
    retiredIds: readonly string[];
    /** Section 4's derived recipe and evidence-vertical compositions. */
    recipes: readonly QbRecipeDefinition[];
    /** Rows the document itself marks unrunnable until a named producer lands. */
    producerGates: readonly QbProducerGate[];
    /** Runnable cases that name a deciding row, derived from case titles. */
    runnableCases: readonly RunnableCase[];
    /** Case files that exist under a declared root and that no runner executes. */
    unrunCaseFiles: readonly string[];
    /** Declared rows that no scanned case names yet. Reported, never gating. */
    rowsAwaitingCase: readonly string[];
}>;

export type QbCoverageInput = Readonly<{
    planMarkdown: string;
    protocolMarkdown: string;
    /**
     * Resolves whether the document `qa/QA-PROTOCOL.md` section 3 names as owning
     * the runtime-row exception's deciding check actually carries an executable
     * check for it. A named document with no executable check is exactly the
     * `D-3` failure "a document-only exception with no executable check".
     */
    resolveDecidingCheck: (documentPath: string) => boolean;
    /**
     * Current bytes of the test files that may carry deciding cases. The caller
     * owns the filesystem; an absent root contributes nothing rather than
     * failing, so a lane that has not started cannot hold this gate red.
     */
    caseSources?: readonly CaseSource[];
    /**
     * The repository commands that select case files by naming each one. A
     * case file such a command omits still parses into a runnable case, so
     * without this the report counts a row as covered by a file no lane runs.
     */
    caseRunners?: readonly EnumeratedCaseRunner[];
}>;

function findingsForDuplicates(rows: readonly QbMatrixRow[]): readonly QbCoverageFinding[] {
    const seen = new Map<string, number>();
    const findings: QbCoverageFinding[] = [];
    for (const row of rows) {
        const previous = seen.get(row.id);
        if (previous !== undefined) {
            findings.push({
                code: 'duplicate-qb-id',
                id: row.id,
                message: `${row.id} is authored twice (lines ${previous} and ${row.line}); one QB id groups one composed recipe.`,
            });
            continue;
        }
        seen.set(row.id, row.line);
    }
    return findings;
}

/**
 * Derives requirement and invariant coverage from the `Covers` cells alone, as
 * `qa/QA-PROTOCOL.md` section 3 requires, and the deciding-row reference and
 * recipe integrity section 4 depends on over the same rows.
 *
 * This is the single closeout check for both, not a second coverage ledger: it
 * holds no state, restates no mapping, and its output is a report for review
 * rather than a committed artifact.
 */
export function deriveQbCoverage(input: QbCoverageInput): QbCoverageReport {
    const contract = parseContractIds(input.planMarkdown);
    const matrix = parseQbMatrix(input.protocolMarkdown);
    const declared = new Set(contract.all);
    const findings: QbCoverageFinding[] = [...findingsForDuplicates(matrix.rows)];

    for (const malformed of matrix.malformedRows) {
        findings.push({
            code: 'malformed-matrix-row',
            id: malformed.id,
            message: `${malformed.id} is authored with ${malformed.cellCount} columns instead of four `
                + `(line ${malformed.line}); its Covers authority cannot be read.`,
        });
    }

    const retiredIds = new Set(matrix.retired.map((retirement) => retirement.id));
    for (const row of matrix.rows) {
        if (!retiredIds.has(row.id)) continue;
        findings.push({
            code: 'retired-qb-id-reused',
            id: row.id,
            message: `${row.id} is recorded as retired, and a retired id is never reused (line ${row.line}).`,
        });
    }

    const decidedBy = new Map<string, string[]>();
    for (const row of matrix.rows) {
        if (row.covers.length === 0) {
            findings.push({
                code: 'empty-covers-cell',
                id: row.id,
                message: `${row.id} names no Covers id (line ${row.line}); a row that decides nothing cannot falsify anything.`,
            });
        }
        for (const coveredId of row.covers) {
            if (!declared.has(coveredId)) {
                findings.push({
                    code: 'unknown-covers-id',
                    id: coveredId,
                    message: `${row.id} covers ${coveredId}, which PLAN.md sections 2 and 3 do not declare (line ${row.line}).`,
                });
                continue;
            }
            const existing = decidedBy.get(coveredId);
            if (existing === undefined) decidedBy.set(coveredId, [row.id]);
            else existing.push(row.id);
        }
    }

    const exception = matrix.runtimeRowException;
    const advisories: QbCoverageFinding[] = [];
    if (exception !== undefined) {
        if (!declared.has(exception.contractId)) {
            findings.push({
                code: 'undeclared-exception-id',
                id: exception.contractId,
                message: `${exception.contractId} is named as the runtime-row exception but PLAN.md does not declare it.`,
            });
        }
        const covered = decidedBy.get(exception.contractId) ?? [];
        if (covered.length > 0) {
            findings.push({
                code: 'exempt-id-also-covered',
                id: exception.contractId,
                message: `${exception.contractId} is exempted as document-authoring yet ${covered.join(', ')} decide it; `
                    + 'an id is owned by the matrix or by its coherence document, never by both.',
            });
        }
        if (!input.resolveDecidingCheck(exception.decidingCheckDocument)) {
            advisories.push({
                code: 'unearned-runtime-row-exception',
                id: exception.contractId,
                message: `${exception.contractId} is exempted from a deciding runtime row, but `
                    + `${exception.decidingCheckDocument} carries no executable deciding check for it.`,
            });
        }
    }

    const entries: QbCoverageEntry[] = [];
    for (const contractId of contract.all) {
        const rows = decidedBy.get(contractId) ?? [];
        const exempt = exception?.contractId === contractId;
        entries.push(Object.freeze({
            contractId,
            decidedBy: Object.freeze(rows),
            exempt,
        }));
        if (rows.length === 0 && !exempt) {
            findings.push({
                code: 'uncovered-contract-id',
                id: contractId,
                message: `${contractId} has no deciding QB row; nothing in the matrix could falsify it.`,
            });
        }
    }

    const declaredRows = new Set(matrix.rows.map((row) => row.id));
    const rowLines = new Set(matrix.rows.map((row) => row.line));
    const retirementLines = new Set(matrix.retired.map((retirement) => retirement.line));
    for (const reference of parseQbRowReferences(input.protocolMarkdown, { rowLines, retirementLines })) {
        if (declaredRows.has(reference.id)) continue;
        const at = `line ${reference.lines.join(', ')}`;
        if (retiredIds.has(reference.id)) {
            if (reference.spanOnly) continue;
            findings.push({
                code: 'retired-row-reference',
                id: reference.id,
                message: `${reference.id} is retired but is still referenced individually (${at}).`,
            });
            continue;
        }
        findings.push({
            code: 'undeclared-row-reference',
            id: reference.id,
            message: `${reference.id} is referenced (${at}) but section 2 declares no such row.`,
        });
    }

    const runnableCases = linkRunnableCases(input.caseSources ?? []);
    for (const runnable of runnableCases) {
        if (declaredRows.has(runnable.qbId)) continue;
        findings.push({
            code: 'case-names-undeclared-row',
            id: runnable.qbId,
            message: `${runnable.path} runs "${runnable.title}", which names ${runnable.qbId}; section 2 declares no such row.`,
        });
    }

    const unrun = findUnrunCaseFiles(input.caseSources ?? [], input.caseRunners ?? []);
    for (const file of unrun) {
        findings.push({
            code: 'case-file-no-runner',
            id: file.path,
            message: file.message,
        });
    }

    const rowsWithCase = new Set(runnableCases.map((runnable) => runnable.qbId));
    return Object.freeze({
        ok: findings.length === 0,
        entries: Object.freeze(entries),
        findings: Object.freeze(findings),
        advisories: Object.freeze(advisories),
        rowCount: matrix.rows.length,
        retiredIds: Object.freeze([...retiredIds]),
        recipes: deriveQbRecipeDefinitions(input.protocolMarkdown, { rowLines, retirementLines }),
        producerGates: parseQbProducerGates(input.protocolMarkdown),
        runnableCases,
        unrunCaseFiles: Object.freeze(unrun.map((file) => file.path)),
        rowsAwaitingCase: Object.freeze(
            matrix.rows.map((row) => row.id).filter((id) => !rowsWithCase.has(id)),
        ),
    });
}

/** Renders the derived coverage report for a reviewer. */
export function formatQbCoverageReport(report: QbCoverageReport): string {
    const lines: string[] = [];
    lines.push(
        `Derived from ${report.rowCount} deciding QB rows`
        + ` (retired: ${report.retiredIds.join(', ') || 'none'}).`,
    );
    lines.push('');
    for (const entry of report.entries) {
        const decided = entry.exempt
            ? 'exempt (document-authoring rule with its own executable check)'
            : entry.decidedBy.join(', ') || 'NONE';
        lines.push(`${entry.contractId}  ${decided}`);
    }

    lines.push('');
    lines.push(`Derived section 4 recipe and evidence-vertical definitions (${report.recipes.length}):`);
    for (const recipe of report.recipes) {
        lines.push(`  line ${recipe.line} -> ${recipe.rows.join(', ')}`);
        lines.push(`    ${recipe.text.slice(0, 160)}`);
    }

    lines.push('');
    lines.push(`Producer-gated rows (${report.producerGates.length}) — UNRUN until their producer lands:`);
    for (const gate of report.producerGates) {
        lines.push(`  ${gate.id}: ${gate.blockers.join(', ') || 'producer named in prose'}`);
    }

    const byRow = new Map<string, number>();
    for (const runnable of report.runnableCases) {
        byRow.set(runnable.qbId, (byRow.get(runnable.qbId) ?? 0) + 1);
    }
    lines.push('');
    lines.push(`Rows with a runnable case (${byRow.size} of ${report.rowCount}):`);
    for (const [id, count] of byRow) lines.push(`  ${id}: ${count} case(s)`);
    lines.push(`  awaiting a case: ${report.rowsAwaitingCase.join(', ') || 'none'}`);
    lines.push(`  case files no runner executes: ${report.unrunCaseFiles.join(', ') || 'none'}`);

    if (report.findings.length > 0) {
        lines.push('');
        lines.push('Findings:');
        for (const finding of report.findings) lines.push(`  [${finding.code}] ${finding.message}`);
    }
    if (report.advisories.length > 0) {
        lines.push('');
        lines.push('Advisories (reported, not gating):');
        for (const advisory of report.advisories) lines.push(`  [${advisory.code}] ${advisory.message}`);
    }
    return lines.join('\n');
}
