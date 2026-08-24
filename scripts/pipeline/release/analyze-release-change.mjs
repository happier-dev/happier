#!/usr/bin/env node

// @ts-check

import { spawnSync } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import { analyzeCurrentPublicApiForEditorial } from './public-api-governance.mjs';
import { classifyChangedPaths, deriveVersionedComponentChanges } from './component-registry.mjs';
import { formatPublicReleaseChannel, normalizePublicReleaseChannel } from './lib/public-release-rings.mjs';
import { classifyReleaseValidationRisks } from '../release-validation/release-risk.mjs';
import { resolveAutomaticReleaseValidationExecution } from '../release-validation/registry.mjs';

const FAST_SUITE_IDS = new Set(['artifact-verify', 'binary-smoke']);
const PUBLIC_API_COMPARISON_PACKAGES = Object.freeze([
  Object.freeze({
    component: 'plugin_sdk',
    profileId: 'plugin-sdk',
    packageName: '@happier-dev/plugin-sdk',
    packageRelDir: 'packages/plugin-sdk',
  }),
  Object.freeze({
    component: 'plugin_sdk',
    profileId: 'plugin-ui',
    packageName: '@happier-dev/plugin-ui',
    packageRelDir: 'packages/plugin-ui',
  }),
  Object.freeze({
    component: 'sdk',
    profileId: 'sdk',
    packageName: '@happier-dev/sdk',
    packageRelDir: 'packages/sdk',
  }),
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function comparisonRequiresHumanReview(comparison) {
  if (!isRecord(comparison) || !isRecord(comparison.disposition)) return false;
  return comparison.disposition.humanReviewRequired === true;
}

function publicApiComparisonRequiresHumanReview(value) {
  if (!isRecord(value)) return false;
  return value.humanReviewRequired === true || comparisonRequiresHumanReview(value.comparison);
}

/**
 * Runs the public-package governance comparison while the release conductor
 * is still forming its editorial/version recommendation. The comparison's
 * source version is deliberately not a proposed release version.
 */
export async function analyzeReleasePublicApiComparisons({
  paths,
  repositoryRoot,
  releaseChannel,
  analyzeCurrentPublicApiForEditorialImpl = analyzeCurrentPublicApiForEditorial,
}) {
  const resolvedRepositoryRoot = resolve(repositoryRoot);
  const versionedChanges = deriveVersionedComponentChanges(classifyChangedPaths(paths));
  const comparisons = [];
  for (const candidate of PUBLIC_API_COMPARISON_PACKAGES) {
    if (!versionedChanges[candidate.component]) continue;
    const packageRoot = join(resolvedRepositoryRoot, candidate.packageRelDir);
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    if (manifest.name !== candidate.packageName || typeof manifest.version !== 'string') {
      throw new Error(`Invalid public package manifest for editorial comparison: ${candidate.packageRelDir}`);
    }
    const analysis = await analyzeCurrentPublicApiForEditorialImpl({
      profileId: candidate.profileId,
      packageName: candidate.packageName,
      packageRoot,
      sourceVersion: manifest.version,
      releaseChannel,
      repositoryRoot: resolvedRepositoryRoot,
    });
    comparisons.push(Object.freeze({
      component: candidate.component,
      profileId: candidate.profileId,
      packageName: candidate.packageName,
      sourceVersion: analysis.sourceVersion,
      releaseChannel: analysis.releaseChannel,
      humanReviewRequired: comparisonRequiresHumanReview(analysis.comparison),
      comparison: analysis.comparison,
    }));
  }
  return Object.freeze(comparisons);
}

/**
 * @param {{
 *   base: string;
 *   head: string;
 *   paths: readonly string[];
 *   profileId: string;
 *   hasCliCandidate: boolean;
 *   hasServerCandidate: boolean;
 *   hasPublishedRelayPredecessor: boolean;
 *   releaseChannel: import('@happier-dev/release-runtime/releaseRings').PublicReleaseRingId;
 *   publicApiComparisons?: readonly unknown[];
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
  const publicApiComparisons = input.publicApiComparisons ?? [];
  return {
    schemaVersion: 1,
    kind: 'happier.release-change-analysis.v1',
    base: input.base,
    head: input.head,
    releaseChannel: formatPublicReleaseChannel(input.releaseChannel),
    changedPaths: [...new Set(input.paths)].sort(),
    compatibilityAnalysisRequired: risks.compatibilityAnalysisRequired,
    publicApiHumanReviewRequired: publicApiComparisons.some(publicApiComparisonRequiresHumanReview),
    risks,
    requiredFastSuites,
    requiredHeavySuites: [...new Set(requiredHeavySuites)],
    skippedHeavySuites: [...new Set(skippedHeavySuites)],
    publicApiComparisons,
    deepCertification: 'manual',
  };
}

/** @param {ReturnType<typeof buildReleaseChangeAnalysis>} analysis */
export function renderReleaseChangeAnalysisGitHubOutput(analysis) {
  return [
    `compatibility_analysis_required=${analysis.compatibilityAnalysisRequired}`,
    `public_api_human_review_required=${analysis.publicApiHumanReviewRequired}`,
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
      channel: { type: 'string' },
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
  const releaseChannel = normalizePublicReleaseChannel(values.channel);
  if (!releaseChannel) throw new Error('--channel must be stable, preview, or dev');
  const repositoryRoot = String(values['repository-root'] ?? '').trim() || undefined;
  const paths = git(['diff', '--name-only', `${base}..${head}`], repositoryRoot)
    .split('\n')
    .map((path) => path.trim())
    .filter(Boolean);
  const publicApiComparisons = await analyzeReleasePublicApiComparisons({
    paths,
    repositoryRoot: repositoryRoot ?? process.cwd(),
    releaseChannel,
  });
  const result = buildReleaseChangeAnalysis({
    base,
    head,
    paths,
    profileId: String(values.profile ?? ''),
    hasCliCandidate: boolean(values['has-cli-candidate'], '--has-cli-candidate'),
    hasServerCandidate: boolean(values['has-server-candidate'], '--has-server-candidate'),
    hasPublishedRelayPredecessor: boolean(values['has-published-relay-predecessor'], '--has-published-relay-predecessor'),
    releaseChannel,
    publicApiComparisons,
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
