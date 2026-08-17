#!/usr/bin/env node
/**
 * `qa/QA-PROTOCOL.md` §3's closeout coverage check, plus the §4 recipe and
 * deciding-row reference derivation that reads the same rows.
 *
 * Coverage comes only from each deciding row's `Covers` cell and each recipe
 * from the sentence that owns it. The report is printed for review and never
 * written to disk: a committed coverage table or recipe list would be exactly
 * the second hand-maintained mapping §3 forbids.
 *
 * `scripts/validate-plan-links.mjs` in the plan corpus owns document/section
 * pointers and §6.1 blocker registration; this owns contract-id coverage,
 * reference integrity, and the link from a row to the cases that run it.
 */
import { deriveQbCoverage, formatQbCoverageReport } from '../src/coverage/qbCoverage.ts';
import {
    readDecidingCaseSources,
    readEnumeratedCaseRunners,
} from '../src/coverage/repositoryCaseSources.ts';
import {
    PLAN_DOCUMENT,
    QA_PROTOCOL_DOCUMENT,
    openPlanCorpus,
} from '../src/plan/planCorpus.ts';

const quiet = process.argv.includes('--quiet');
const corpus = openPlanCorpus();
const report = deriveQbCoverage({
    planMarkdown: corpus.read(PLAN_DOCUMENT),
    protocolMarkdown: corpus.read(QA_PROTOCOL_DOCUMENT),
    resolveDecidingCheck: (documentPath) => corpus.has(documentPath),
    caseSources: readDecidingCaseSources(),
    caseRunners: readEnumeratedCaseRunners(),
});

if (!quiet || !report.ok) process.stdout.write(`${formatQbCoverageReport(report)}\n`);
if (!report.ok) process.exitCode = 1;
