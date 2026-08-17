import { describe, expect, it } from 'vitest';

import {
    PLAN_DOCUMENT,
    QA_PROTOCOL_DOCUMENT,
    openPlanCorpus,
} from '../plan/planCorpus.ts';
import { findStatedComputableCounts } from './computableCounts.ts';
import { computableCorpusPopulations } from './corpusPopulations.ts';

const corpus = openPlanCorpus();
const populations = computableCorpusPopulations(
    corpus.read(PLAN_DOCUMENT),
    corpus.read(QA_PROTOCOL_DOCUMENT),
);

describe('D-7: no document states a number a command can compute', () => {
    it('holds for every living authored document in the current corpus', () => {
        const findings = findStatedComputableCounts({
            documents: corpus.livingDocuments(),
            populations,
        });
        expect(findings).toEqual([]);
    });

    it('reads the living corpus without the frozen evidence, execution and script trees', () => {
        const paths = corpus.livingDocuments().map((document) => document.path);
        expect(paths).toContain('PLAN.md');
        expect(paths).toContain(QA_PROTOCOL_DOCUMENT);
        expect(paths.some((path) => path.startsWith('evidence/'))).toBe(false);
        expect(paths.some((path) => path.startsWith('execution/'))).toBe(false);
    });

    it('computes each population from current bytes rather than a remembered number', () => {
        const rows = populations.find((population) => population.label === 'deciding QB rows');
        expect(rows?.computed).toBeGreaterThan(0);
        const withOneMoreRow = computableCorpusPopulations(
            corpus.read(PLAN_DOCUMENT),
            corpus.read(QA_PROTOCOL_DOCUMENT).replace(/^\| QB-02 \|.*$/m, (row) => `${row}\n${row}`),
        );
        expect(withOneMoreRow.find((population) => population.label === 'deciding QB rows')?.computed)
            .toBe((rows?.computed ?? 0) + 1);
    });

    it('reports a hand-typed count that agrees with the command today', () => {
        const rowCount = populations.find((population) => population.label === 'deciding QB rows')?.computed;
        const findings = findStatedComputableCounts({
            documents: [{
                path: 'qa/QA-PROTOCOL.md',
                markdown: `The matrix declares ${String(rowCount)} deciding rows.`,
            }],
            populations,
        });
        expect(findings).toHaveLength(1);
        expect(findings[0]?.population).toBe('deciding QB rows');
        expect(findings[0]?.stated).toBe(rowCount);
        expect(findings[0]?.computed).toBe(rowCount);
    });

    it('reads a spelled-out number, since drift arrives in prose as often as in digits', () => {
        const findings = findStatedComputableCounts({
            documents: [{ path: 'EXECUTION.md', markdown: 'It declares eight deciding rows today.' }],
            populations,
        });
        expect(findings.map((finding) => finding.stated)).toEqual([8]);
    });

    it('leaves an ordinary number alone when it names no computable population', () => {
        const findings = findStatedComputableCounts({
            documents: [{
                path: 'design/DESIGN-SPEC.md',
                markdown: 'The list holds its geometry at 2,000 rows and four indexes over three collections.',
            }],
            populations,
        });
        expect(findings).toEqual([]);
    });
});
