import { describe, expect, it } from 'vitest';

import {
    PLAN_DOCUMENT,
    QA_PROTOCOL_DOCUMENT,
    openPlanCorpus,
} from '../plan/planCorpus.ts';
import { deriveQbCoverage, type QbCoverageFindingCode, type QbCoverageInput } from './qbCoverage.ts';
import { readDecidingCaseSources, readEnumeratedCaseRunners } from './repositoryCaseSources.ts';

const corpus = openPlanCorpus();
const planMarkdown = corpus.read(PLAN_DOCUMENT);
const protocolMarkdown = corpus.read(QA_PROTOCOL_DOCUMENT);
const decidingCheckPresent = (): boolean => true;

function derive(overrides: Partial<QbCoverageInput> = {}) {
    return deriveQbCoverage({
        planMarkdown,
        protocolMarkdown,
        resolveDecidingCheck: decidingCheckPresent,
        ...overrides,
    });
}

function codes(findings: readonly { code: QbCoverageFindingCode; id: string }[]): readonly string[] {
    return findings.map((finding) => `${finding.code}:${finding.id}`);
}

describe('QB coverage closeout check', () => {
    it('derives every declared contract id from the current corpus', () => {
        const report = derive({ caseSources: readDecidingCaseSources() });
        expect(report.rowCount).toBeGreaterThan(0);
        expect(report.entries.length).toBeGreaterThan(0);
        expect(codes(report.findings)).toEqual([]);
    });

    it('reports a declared requirement that no row decides', () => {
        // Drop the sole deciding cell reference to REQ-16 (QB-40's Covers cell).
        const withoutReq16 = protocolMarkdown.replace(/\| REQ-16 \|/g, '| REQ-12 |');
        expect(withoutReq16).not.toEqual(protocolMarkdown);
        const report = derive({ protocolMarkdown: withoutReq16 });
        expect(codes(report.findings)).toContain('uncovered-contract-id:REQ-16');
        expect(report.ok).toBe(false);
    });

    it('reports a row that names a contract id PLAN.md does not declare', () => {
        const withPhantom = protocolMarkdown.replace('| REQ-09, INV-01, INV-10 |', '| REQ-09, INV-44 |');
        expect(withPhantom).not.toEqual(protocolMarkdown);
        expect(codes(derive({ protocolMarkdown: withPhantom }).findings))
            .toContain('unknown-covers-id:INV-44');
    });

    it('reports one QB id authored more than once', () => {
        const duplicated = protocolMarkdown.replace(/^\| QB-02 \|.*$/m, (row) => `${row}\n${row}`);
        expect(duplicated).not.toEqual(protocolMarkdown);
        expect(codes(derive({ protocolMarkdown: duplicated }).findings))
            .toContain('duplicate-qb-id:QB-02');
    });

    it('reports a retired QB id brought back as a live row', () => {
        const revived = protocolMarkdown.replace(/^\| QB-02 \|/m, '| QB-07 |');
        expect(codes(derive({ protocolMarkdown: revived }).findings))
            .toContain('retired-qb-id-reused:QB-07');
    });

    it('reports a row whose Covers cell decides nothing', () => {
        const emptied = protocolMarkdown.replace('| REQ-01, REQ-02 |', '|  |');
        expect(emptied).not.toEqual(protocolMarkdown);
        expect(codes(derive({ protocolMarkdown: emptied }).findings))
            .toContain('empty-covers-cell:QB-02');
    });

    it('refuses to read coverage from a row whose column count is wrong', () => {
        // A fifth column: reading whichever cell happens to be last would take
        // the appended prose as the row's coverage authority.
        const extraColumn = protocolMarkdown.replace(
            /^(\| QB-02 \|.*)\|$/m,
            '$1| trailing prose that is not a Covers cell |',
        );
        expect(extraColumn).not.toEqual(protocolMarkdown);
        const report = derive({ protocolMarkdown: extraColumn });
        expect(codes(report.findings)).toContain('malformed-matrix-row:QB-02');
        expect(report.entries.find((entry) => entry.contractId === 'REQ-02')?.decidedBy)
            .not.toContain('QB-02');
    });

    it('reports a section 4 recipe that still names a row section 2 does not declare', () => {
        const dangling = protocolMarkdown.replace(
            'The daemon OS recipe executes QB-58',
            'The daemon OS recipe executes QB-99',
        );
        expect(dangling).not.toEqual(protocolMarkdown);
        expect(codes(derive({ protocolMarkdown: dangling }).findings))
            .toContain('undeclared-row-reference:QB-99');
    });

    it('reports an individual reference to a retired row but tolerates a span passing over it', () => {
        const individual = protocolMarkdown.replace(
            'The daemon OS recipe executes QB-58',
            'The daemon OS recipe executes QB-07',
        );
        expect(codes(derive({ protocolMarkdown: individual }).findings))
            .toContain('retired-row-reference:QB-07');

        const span = protocolMarkdown.replace(
            'The daemon OS recipe executes QB-58',
            'The daemon OS recipe executes QB-06 through QB-08',
        );
        expect(codes(derive({ protocolMarkdown: span }).findings))
            .not.toContain('retired-row-reference:QB-07');
    });

    it('reports a runnable case that names a row section 2 does not declare', () => {
        const report = derive({
            caseSources: [{
                path: 'packages/triage-protocol/src/phantom.test.ts',
                text: "it('QB-99: a case for a row that does not exist', () => {});",
            }],
        });
        expect(codes(report.findings)).toContain('case-names-undeclared-row:QB-99');
    });

    it('links a runnable case to the row its title names', () => {
        const report = derive({
            caseSources: [{
                path: 'packages/triage-protocol/src/real.test.ts',
                text: "test('QB-02: the list preserves a detailOnly fact', () => {});",
            }],
        });
        expect(report.runnableCases).toEqual([{
            qbId: 'QB-02',
            path: 'packages/triage-protocol/src/real.test.ts',
            title: 'QB-02: the list preserves a detailOnly fact',
        }]);
        expect(report.rowsAwaitingCase).not.toContain('QB-02');
    });

    /**
     * A case file that exists but that no lane runs still parses into a
     * runnable case and still marks its row covered. That is the failure this
     * whole harness exists to prevent, arriving through the one selection shape
     * a package's own glob cannot protect: another package naming its case
     * files one by one.
     */
    it('reports a case file that its enumerated runner never executes', () => {
        const report = derive({
            caseSources: [{
                path: 'packages/tests/fixtures/plugin-platform/out-of-tree-triage-source/test/orphan.test.mjs',
                text: "test('QB-02: a case nothing runs', () => {});",
            }],
            caseRunners: [{
                root: 'packages/tests/fixtures/plugin-platform/out-of-tree-triage-source/test',
                declaredBy: 'packages/tests/package.json test:plugin-platform:out-of-tree-triage-source',
                commandRoot: 'packages/tests',
                commandText: 'node --test fixtures/plugin-platform/out-of-tree-triage-source/test/other.test.mjs',
            }],
        });

        expect(codes(report.findings))
            .toContain('case-file-no-runner:packages/tests/fixtures/plugin-platform/out-of-tree-triage-source/test/orphan.test.mjs');
        expect(report.ok).toBe(false);
        // The row still reads as covered, which is exactly why the finding has
        // to be the thing that closes the gate.
        expect(report.rowsAwaitingCase).not.toContain('QB-02');
    });

    it('accepts a case file the enumerated runner names, and reports a missing command', () => {
        const source = {
            path: 'packages/tests/fixtures/plugin-platform/out-of-tree-triage-source/test/named.test.mjs',
            text: "test('QB-02: a case a lane runs', () => {});",
        };
        const runner = {
            root: 'packages/tests/fixtures/plugin-platform/out-of-tree-triage-source/test',
            declaredBy: 'packages/tests/package.json test:plugin-platform:out-of-tree-triage-source',
            commandRoot: 'packages/tests',
        };

        expect(derive({
            caseSources: [source],
            caseRunners: [{
                ...runner,
                commandText: 'node --test fixtures/plugin-platform/out-of-tree-triage-source/test/named.test.mjs',
            }],
        }).unrunCaseFiles).toEqual([]);

        // The other direction: the script key is gone entirely, so every case
        // file under that root is unrun rather than silently reachable.
        expect(derive({
            caseSources: [source],
            caseRunners: [{ ...runner, commandText: undefined }],
        }).unrunCaseFiles).toEqual([source.path]);
    });

    it('finds every current deciding case file reachable from a declared runner', () => {
        const report = derive({
            caseSources: readDecidingCaseSources(),
            caseRunners: readEnumeratedCaseRunners(),
        });
        expect(report.unrunCaseFiles).toEqual([]);
    });

    it('reports an id that is both exempted and decided by a row', () => {
        const alsoCovered = protocolMarkdown.replace('| REQ-09, INV-01, INV-10 |', '| REQ-09, INV-14 |');
        expect(alsoCovered).not.toEqual(protocolMarkdown);
        expect(codes(derive({ protocolMarkdown: alsoCovered }).findings))
            .toContain('exempt-id-also-covered:INV-14');
    });

    it('reports an unearned runtime-row exception without closing the gate', () => {
        const report = derive({ resolveDecidingCheck: () => false });
        expect(codes(report.advisories)).toEqual(['unearned-runtime-row-exception:INV-14']);
        expect(codes(report.findings)).toEqual([]);
        expect(report.ok).toBe(true);
    });

    it('exempts only the one contract id the protocol names, not every uncovered id', () => {
        const exempt = derive().entries
            .filter((entry) => entry.exempt)
            .map((entry) => entry.contractId);
        expect(exempt).toEqual(['INV-14']);
    });

    it('derives the section 4 recipes and producer gates the document states in prose', () => {
        const report = derive();
        expect(report.recipes.some((recipe) => recipe.rows.includes('QB-58'))).toBe(true);
        expect(report.producerGates.find((gate) => gate.id === 'QB-11')?.blockers)
            .toContain('CORPUS-E2EE-MODE-TRANSITION');
    });
});
