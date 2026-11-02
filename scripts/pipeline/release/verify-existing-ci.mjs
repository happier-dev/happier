#!/usr/bin/env node
// @ts-check

import { spawnSync } from 'node:child_process';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { projectSourceSuiteReuse } from './source-suite-evidence.mjs';
import { getPublicReleaseRingEntry } from './lib/public-release-rings.mjs';

const CANONICAL_RELEASE_CI_WORKFLOW = 'tests.yml';
const PUBLIC_RELEASE_PROMOTION_BRANCHES = Object.freeze(
  ['publicdev', 'preview', 'stable'].map((ring) => getPublicReleaseRingEntry(ring).sourceBranch),
);

export const DEFAULT_RELEASE_CI_LANES = Object.freeze([
  'ci_plan', 'trusted_ref_guard',
  'ui-unit', 'ui-integration', 'ui', 'shared-packages-unit',
  'server', 'cli', 'stack', 'typecheck', 'e2e-core',
]);

const CLASSIFIED_CI_LANE_GROUPS = Object.freeze({
  run_ui: ['ui-unit', 'ui-integration', 'ui', 'shared-packages-unit'],
  run_server: ['server'],
  run_cli: ['cli'],
  run_stack: ['stack'],
  run_ui_e2e: ['ui-e2e'],
  run_server_db_contract: ['server-db-contract'],
  run_release_contracts: ['release-contracts'],
  run_installers_smoke: ['installers-smoke-linux', 'installers-smoke-macos', 'installers-smoke-windows'],
  run_binary_smoke: ['binary-smoke'],
  run_cli_daemon_e2e: ['cli-daemon-e2e'],
  run_e2e_core: ['e2e-core'],
  run_typecheck: ['typecheck'],
});

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function requireRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CI evidence must be an object');
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * CI is source evidence, so an exact-SHA successful push stays valid as that
 * commit moves forward through the public dev -> preview -> main promotion
 * chain. Branch mutation and source binding remain owned by release admission.
 *
 * @param {unknown} runBranch
 * @param {string} sourceBranch
 */
function isAllowedPromotionChainCiBranch(runBranch, sourceBranch) {
  const runIndex = PUBLIC_RELEASE_PROMOTION_BRANCHES.indexOf(String(runBranch));
  const sourceIndex = PUBLIC_RELEASE_PROMOTION_BRANCHES.indexOf(sourceBranch);
  return runIndex >= 0 && sourceIndex >= 0 && runIndex <= sourceIndex;
}

/**
 * @param {unknown} runValue
 * @param {{ repository: string; sourceSha: string; sourceBranch: string; runId: string }} expected
 */
export function validateCanonicalCiRun(runValue, expected) {
  const run = requireRecord(runValue);
  if (
    String(run.id ?? '') !== expected.runId
    || run.path !== `.github/workflows/${CANONICAL_RELEASE_CI_WORKFLOW}`
    || run.head_sha !== expected.sourceSha
    || !isAllowedPromotionChainCiBranch(run.head_branch, expected.sourceBranch)
    || run.event !== 'push'
    || requireRecord(run.head_repository).full_name !== expected.repository
    || run.status !== 'completed'
    || run.conclusion !== 'success'
  ) {
    throw new Error(`CI run ${expected.runId} is not a successful canonical push CI for the requested source`);
  }
  return run;
}

/**
 * @param {unknown} summaryValue
 * @param {{ runId: string; sourceSha: string; requiredLanes: string[]; allowNotesOnly?: boolean }} expected
 */
export function validateCiLaneSummary(summaryValue, expected) {
  const summary = requireRecord(summaryValue);
  if (summary.schemaVersion !== 1) throw new Error('CI lane summary has an unsupported schema version');
  if (String(summary.runId ?? '') !== expected.runId) throw new Error('CI lane summary run ID does not match the admitted run');
  if (summary.sourceSha !== expected.sourceSha) throw new Error('CI lane summary source SHA does not match the admitted source');
  if (!Array.isArray(summary.lanes)) throw new Error('CI lane summary is missing lanes');
  if (!Array.isArray(summary.failures)) throw new Error('CI lane summary is missing failures');
  if (summary.failures.length > 0) throw new Error('CI lane summary reports failed lanes');

  const lanes = new Map();
  for (const laneValue of summary.lanes) {
    const lane = requireRecord(laneValue);
    if (typeof lane.id !== 'string' || lanes.has(lane.id)) throw new Error('CI lane summary contains an invalid or duplicate lane ID');
    if (lane.result !== 'success' && lane.result !== 'skipped') throw new Error(`CI lane summary lane ${lane.id} has an invalid result`);
    lanes.set(lane.id, lane);
  }
  const planOutputs = lanes.get('ci_plan')?.outputs;
  const notesOnly = expected.allowNotesOnly !== false
    && expected.requiredLanes.length === DEFAULT_RELEASE_CI_LANES.length
    && DEFAULT_RELEASE_CI_LANES.every((lane) => expected.requiredLanes.includes(lane))
    && planOutputs?.notes_only === 'true';
  if (notesOnly) {
    const outputs = requireRecord(planOutputs);
    if (typeof outputs.notes_base_sha !== 'string' || !/^[0-9a-f]{40}$/u.test(outputs.notes_base_sha)
      || outputs.notes_base_sha === expected.sourceSha || !/^[1-9][0-9]*$/u.test(String(outputs.notes_base_run_id))
      || String(outputs.notes_base_run_id) === expected.runId
      || Object.keys(CLASSIFIED_CI_LANE_GROUPS).some((selection) => outputs[selection] !== 'false')) {
      throw new Error('CI notes-only source basis is invalid');
    }
    if (outputs.run_build_smoke !== 'true' || lanes.get('build-smoke')?.result !== 'success') {
      throw new Error('CI metadata child requires successful versioned build-smoke');
    }
  }
  for (const laneId of notesOnly ? ['ci_plan', 'trusted_ref_guard'] : expected.requiredLanes) {
    if (lanes.get(laneId)?.result !== 'success') throw new Error(`CI lane summary required lane ${laneId} did not succeed`);
  }
  if (expected.requiredLanes.includes('ci_plan')) {
    const outputs = requireRecord(lanes.get('ci_plan')?.outputs);
    for (const [selection, laneIds] of Object.entries(CLASSIFIED_CI_LANE_GROUPS)) {
      const selected = outputs[selection];
      if (selected !== 'true' && selected !== 'false') throw new Error(`CI lane summary classifier output ${selection} is invalid`);
      if (selected !== 'true') continue;
      for (const laneId of laneIds) {
        if (lanes.get(laneId)?.result !== 'success') throw new Error(`CI lane summary classifier-selected lane ${laneId} did not succeed`);
      }
    }
  }
  return summary;
}

function runGh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || '').trim());
  return String(result.stdout ?? '');
}

/** Verify the existing exact-run artifact, without selecting a different source.
 * @param {{repository: string; sourceSha: string; sourceBranch: string; runId: string; requiredLanes: string[]; allowNotesOnly?: boolean; sourceProfile?: string}} expected
 */
export async function verifyCanonicalCiEvidence(expected) {
  const run = JSON.parse(runGh(['api', `repos/${expected.repository}/actions/runs/${expected.runId}`]));
  validateCanonicalCiRun(run, expected);
  let sourceSuiteReuse = {};
  const evidenceRoot = await mkdtemp(join(tmpdir(), 'happier-ci-evidence-'));
  try {
    runGh(['run', 'download', expected.runId, '--repo', expected.repository, '--name', 'ci-lane-summary', '--dir', evidenceRoot]);
    const summary = JSON.parse(await readFile(join(evidenceRoot, 'ci-summary.json'), 'utf8'));
    validateCiLaneSummary(summary, expected);
    if (expected.sourceProfile) sourceSuiteReuse = projectSourceSuiteReuse(summary, { ...expected, profile: expected.sourceProfile });
  } finally {
    await rm(evidenceRoot, { recursive: true, force: true });
  }
  return expected.sourceProfile ? { ...run, sourceSuiteReuse } : run;
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      repository: { type: 'string' },
      'source-sha': { type: 'string' },
      'source-branch': { type: 'string' },
      'run-id': { type: 'string' },
      'required-lanes': { type: 'string', default: '' },
      'github-output': { type: 'string', default: '' },
      'source-profile': { type: 'string', default: '' },
    },
    allowPositionals: false,
  });
  const sourceProfile = String(values['source-profile'] ?? '').trim();
  if (sourceProfile && !['integrated', 'stable'].includes(sourceProfile)) throw new Error('Unsupported source validation profile');
  const repository = String(values.repository ?? '').trim();
  const sourceSha = String(values['source-sha'] ?? '').trim();
  const sourceBranch = String(values['source-branch'] ?? '').trim();
  const runId = String(values['run-id'] ?? '').trim();
  const selectedRequiredLanes = String(values['required-lanes'] ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  const requiredLanes = selectedRequiredLanes.length > 0 ? selectedRequiredLanes : [...DEFAULT_RELEASE_CI_LANES];
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repository)) throw new Error('--repository must be owner/repo');
  if (!/^[0-9a-f]{40}$/u.test(sourceSha)) throw new Error('--source-sha must be a full lowercase commit ID');
  if (!PUBLIC_RELEASE_PROMOTION_BRANCHES.includes(sourceBranch)) throw new Error('--source-branch must be dev, preview, or main');
  if (!runId) throw new Error('--run-id is required; releases consume an explicit completed CI attestation');
  if (!/^[1-9][0-9]*$/u.test(runId)) throw new Error('--run-id must be a positive integer');
  if (new Set(requiredLanes).size !== requiredLanes.length) throw new Error('--required-lanes must not contain duplicates');

  const run = await verifyCanonicalCiEvidence({ repository, sourceSha, sourceBranch, runId, requiredLanes, sourceProfile });

  const sourceSuiteReuse = sourceProfile ? requireRecord(run).sourceSuiteReuse : {};
  const output = { runId: Number(runId), runUrl: String(requireRecord(run).html_url ?? ''), sourceSha, sourceBranch };
  const githubOutput = String(values['github-output'] ?? '').trim();
  if (githubOutput) await appendFile(githubOutput, `ci_run_id=${output.runId}\nci_run_url=${output.runUrl}\n${Object.entries(sourceSuiteReuse).map(([key, value]) => `${key}=${value}\n`).join('')}`, 'utf8');
  else process.stdout.write(`${JSON.stringify(output)}\n`);
  return output;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
