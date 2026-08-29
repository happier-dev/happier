#!/usr/bin/env node

// @ts-check

import { spawnSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import { classifyReleaseValidationRisks } from '../release-validation/release-risk.mjs';
import { resolveAutomaticReleaseValidationExecution } from '../release-validation/registry.mjs';

const FAST_SUITE_IDS = new Set(['artifact-verify', 'binary-smoke']);

/**
 * @param {{
 *   base: string;
 *   head: string;
 *   paths: readonly string[];
 *   profileId: string;
 *   hasCliCandidate: boolean;
 *   hasServerCandidate: boolean;
 *   hasPublishedRelayPredecessor: boolean;
 * }} input
 */
export function buildReleaseChangeAnalysis(input) {
  const risks = classifyReleaseValidationRisks(input.paths);
  const execution = resolveAutomaticReleaseValidationExecution(input.profileId, {
    hasCliCandidate: input.hasCliCandidate,
    hasServerCandidate: input.hasServerCandidate,
    hasPublishedRelayPredecessor: input.hasPublishedRelayPredecessor,
    risks,
  });
  const requiredFastSuites = execution.selectedSuiteIds.filter((id) => FAST_SUITE_IDS.has(id));
  const requiredHeavySuites = execution.selectedSuiteIds.filter((id) => !FAST_SUITE_IDS.has(id));
  if (input.hasServerCandidate && risks.mysqlContract) requiredHeavySuites.push('mysql-contract');
  if (risks.platformServices) requiredHeavySuites.push('platform-services');
  if (risks.trustRoots) requiredHeavySuites.push('trust-root-compatibility');
  const skippedHeavySuites = [
    ...execution.skippedSuiteIds.filter((id) => !FAST_SUITE_IDS.has(id)),
    ...(!input.hasServerCandidate || !risks.mysqlContract ? ['mysql-contract'] : []),
    ...(!risks.platformServices ? ['platform-services'] : []),
    ...(!risks.trustRoots ? ['trust-root-compatibility'] : []),
  ];
  return {
    schemaVersion: 1,
    kind: 'happier.release-change-analysis.v1',
    base: input.base,
    head: input.head,
    changedPaths: [...new Set(input.paths)].sort(),
    compatibilityAnalysisRequired: risks.compatibilityAnalysisRequired,
    risks,
    requiredFastSuites,
    requiredHeavySuites: [...new Set(requiredHeavySuites)],
    skippedHeavySuites: [...new Set(skippedHeavySuites)],
    deepCertification: 'manual',
  };
}

/** @param {ReturnType<typeof buildReleaseChangeAnalysis>} analysis */
export function renderReleaseChangeAnalysisGitHubOutput(analysis) {
  return [
    `compatibility_analysis_required=${analysis.compatibilityAnalysisRequired}`,
    `risk_cli_upgrade=${analysis.risks.cliUpgrade}`,
    `risk_session_continuity=${analysis.risks.sessionContinuity}`,
    `risk_relay_upgrade=${analysis.risks.relayUpgrade}`,
    `risk_mysql_contract=${analysis.risks.mysqlContract}`,
    `risk_platform_services=${analysis.risks.platformServices}`,
    `risk_trust_roots=${analysis.risks.trustRoots}`,
    '',
  ].join('\n');
}

/** @param {string[]} args @param {string | undefined} cwd */
function git(args, cwd) {
  const result = spawnSync('git', args, { encoding: 'utf8', cwd });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || '').trim());
  return String(result.stdout ?? '');
}

/** @param {unknown} value @param {string} label */
function boolean(value, label) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${label} must be true or false`);
}

/** @param {string[]} [argv] */
export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      base: { type: 'string' },
      head: { type: 'string' },
      profile: { type: 'string', default: 'integrated' },
      'has-cli-candidate': { type: 'string', default: 'false' },
      'has-server-candidate': { type: 'string', default: 'false' },
      'has-published-relay-predecessor': { type: 'string', default: 'false' },
      'github-output': { type: 'string', default: '' },
      'repository-root': { type: 'string', default: '' },
    },
    allowPositionals: false,
  });
  const base = String(values.base ?? '').trim();
  const head = String(values.head ?? '').trim();
  if (!base || !head) throw new Error('--base and --head are required');
  const repositoryRoot = String(values['repository-root'] ?? '').trim() || undefined;
  const paths = git(['diff', '--name-only', `${base}..${head}`], repositoryRoot)
    .split('\n')
    .map((path) => path.trim())
    .filter(Boolean);
  const result = buildReleaseChangeAnalysis({
    base,
    head,
    paths,
    profileId: String(values.profile ?? ''),
    hasCliCandidate: boolean(values['has-cli-candidate'], '--has-cli-candidate'),
    hasServerCandidate: boolean(values['has-server-candidate'], '--has-server-candidate'),
    hasPublishedRelayPredecessor: boolean(values['has-published-relay-predecessor'], '--has-published-relay-predecessor'),
  });
  const githubOutput = String(values['github-output'] ?? '').trim();
  if (githubOutput) {
    await appendFile(githubOutput, renderReleaseChangeAnalysisGitHubOutput(result), 'utf8');
  } else {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
