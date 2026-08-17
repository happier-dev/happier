#!/usr/bin/env node
/**
 * `PLAN.md` §7.3 / `D-7`: no living authored document states a number a command
 * could compute. Counts appear as the command that produces them, or not at all.
 */
import { findStatedComputableCounts, formatStatedCountFindings } from '../src/counts/computableCounts.ts';
import { computableCorpusPopulations } from '../src/counts/corpusPopulations.ts';
import {
    PLAN_DOCUMENT,
    QA_PROTOCOL_DOCUMENT,
    openPlanCorpus,
} from '../src/plan/planCorpus.ts';

const quiet = process.argv.includes('--quiet');
const corpus = openPlanCorpus();
const documents = corpus.livingDocuments();
const populations = computableCorpusPopulations(
    corpus.read(PLAN_DOCUMENT),
    corpus.read(QA_PROTOCOL_DOCUMENT),
);
const findings = findStatedComputableCounts({ documents, populations });

if (!quiet || findings.length > 0) {
    process.stdout.write(
        `Checked ${documents.length} living authored documents against `
        + `${populations.length} computable populations `
        + `(${populations.map((population) => `${population.label}=${population.computed}`).join(', ')}).\n`,
    );
    process.stdout.write(`${formatStatedCountFindings(findings)}\n`);
}
if (findings.length > 0) process.exitCode = 1;
