#!/usr/bin/env node

// @ts-check

import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import {
  RELEASE_VALIDATION_SUITE_IDS,
  resolveDesktopSetupCliSource,
  resolveAutomaticReleaseValidationExecution,
  resolveReleaseValidationSuite,
  resolveReleaseValidationSuiteApplicability,
  resolveReleaseValidationSuiteTimeoutMinutes,
} from './registry.mjs';

const OUTPUT_KEYS = Object.freeze([
  'run_installers_smoke',
  'run_artifact_verify',
  'run_binary_smoke',
  'run_cli_update_continuity',
  'run_daemon_continuity',
  'run_session_continuity',
  'run_release_assets_docker',
  'run_self_host_systemd',
  'run_self_host_launchd',
  'run_self_host_schtasks',
  'run_self_host_daemon',
]);

const SUITE_OUTPUT_KEYS = Object.freeze({
  'installers-smoke': 'run_installers_smoke',
  'artifact-verify': 'run_artifact_verify',
  'binary-smoke': 'run_binary_smoke',
  'cli-update': 'run_cli_update_continuity',
  'daemon-continuity': 'run_daemon_continuity',
  'session-continuity': 'run_session_continuity',
  'docker-release-assets': 'run_release_assets_docker',
});
const NON_WAIVABLE_SUITES = new Set(['artifact-verify', 'binary-smoke']);

function validateSuiteIds(values, label) {
  const ids = [...new Set(values ?? [])];
  for (const id of ids) {
    if (!RELEASE_VALIDATION_SUITE_IDS.includes(id)) throw new Error(`Unknown release validation suite in ${label}: ${id}`);
    // A registered suite without a tests.yml lane (desktop-setup gates build-tauri.yml) cannot be
    // included or waived here: honouring the request would report coverage nothing runs.
    if (!Object.hasOwn(SUITE_OUTPUT_KEYS, id)) throw new Error(`Release validation suite ${id} is not run by release verification (${label})`);
  }
  return ids;
}

export function validateReleaseValidationRefinements(input) {
  const includeSuiteIds = validateSuiteIds(input.includeSuiteIds, '--include-suites');
  const waiveSuiteIds = validateSuiteIds(input.waiveSuiteIds, '--waive-suites');
  for (const suiteId of waiveSuiteIds) {
    if (NON_WAIVABLE_SUITES.has(suiteId)) throw new Error(`Release validation suite ${suiteId} cannot be waived`);
  }
  return { includeSuiteIds, waiveSuiteIds };
}

/** @param {unknown} value @param {string} label */
function bool(value, label) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false' || value === '' || value === undefined) return false;
  throw new Error(`${label} must be true or false`);
}

/**
 * @param {{
 *   profileId: string;
 *   sourceBinarySmokeValidated?: boolean;
 *   hasCliCandidate: boolean;
 *   hasServerCandidate: boolean;
 *   hasPublishedRelayPredecessor: boolean;
 *   risks: { cliUpgrade: boolean; sessionContinuity: boolean; relayUpgrade: boolean };
 *   includeSuiteIds?: string[];
 *   waiveSuiteIds?: string[];
 * }} input
 */
export function resolveReleaseValidationPlan(input) {
  if (!input.profileId) throw new Error('A normal release validation profile is required');
  const execution = resolveAutomaticReleaseValidationExecution(input.profileId, {
    hasCliCandidate: input.hasCliCandidate,
    hasServerCandidate: input.hasServerCandidate,
    hasPublishedRelayPredecessor: input.hasPublishedRelayPredecessor,
    risks: input.risks,
  });
  const automatic = new Set(execution.selectedSuiteIds);
  const { includeSuiteIds, waiveSuiteIds } = validateReleaseValidationRefinements(input);
  for (const suiteId of includeSuiteIds) automatic.add(suiteId);
  for (const suiteId of waiveSuiteIds) automatic.delete(suiteId);
  // Only the canonical source admission supplies this result; artifact verification remains distinct.
  if (input.sourceBinarySmokeValidated === true) automatic.delete('binary-smoke');
  return {
    run_installers_smoke: String(automatic.has('installers-smoke')),
    run_artifact_verify: String(automatic.has('artifact-verify')),
    run_binary_smoke: String(automatic.has('binary-smoke')),
    run_cli_update_continuity: String(automatic.has('cli-update')),
    run_daemon_continuity: 'false',
    run_session_continuity: String(automatic.has('session-continuity')),
    run_release_assets_docker: String(automatic.has('docker-release-assets')),
    run_self_host_systemd: 'false',
    run_self_host_launchd: 'false',
    run_self_host_schtasks: 'false',
    run_self_host_daemon: 'false',
    waivedSuiteIds: waiveSuiteIds,
    // What the plan does not run and why (an explicit include still runs it).
    skippedSuites: execution.skippedSuiteIds
      .filter((suiteId) => !automatic.has(suiteId))
      .map((suiteId) => `${suiteId} (${execution.skipReasons[suiteId]})`),
  };
}

/**
 * One suite that gates a component build rather than release verification (build-tauri.yml runs
 * desktop-setup on its just-finalized Linux bundle). Selection comes from the same registry rule
 * as every profile suite; the hard stop derives from the suite's registry budget.
 * @param {{
 *   suiteId: string;
 *   candidateCliVersion: string;
 *   hasDesktopCandidate: boolean;
 *   candidateChannel: string;
 * }} input
 */
export function resolveReleaseValidationSuiteGate(input) {
  const suite = resolveReleaseValidationSuite(input.suiteId);
  if (!suite) throw new Error(`Unknown release validation suite: ${input.suiteId}`);
  if (suite.id !== 'desktop-setup') throw new Error(`Release validation suite ${suite.id} is not a build gate`);
  const candidateCliVersion = String(input.candidateCliVersion ?? '').trim();
  const { selected, skipReason } = resolveReleaseValidationSuiteApplicability(suite.id, {
    hasCliCandidate: candidateCliVersion !== '',
    hasDesktopCandidate: input.hasDesktopCandidate,
    candidateChannel: input.candidateChannel,
  });
  const cli = selected ? resolveDesktopSetupCliSource({ candidateChannel: input.candidateChannel, candidateCliVersion }) : null;
  return {
    run: String(selected),
    skip_reason: skipReason ?? '',
    timeout_minutes: String(resolveReleaseValidationSuiteTimeoutMinutes(suite)),
    cli_source: cli?.kind ?? '',
    cli_ref: cli?.ref ?? '',
  };
}

/** @param {string[]} [argv] */
export async function main(argv = process.argv.slice(2)) {
  const options = {
    profile: { type: 'string', default: '' },
    suite: { type: 'string', default: '' },
    'source-binary-smoke-validated': { type: 'string', default: 'false' },
    'has-cli-candidate': { type: 'string', default: 'false' },
    'has-server-candidate': { type: 'string', default: 'false' },
    'has-desktop-candidate': { type: 'string', default: 'false' },
    'candidate-cli-version': { type: 'string', default: '' },
    'candidate-channel': { type: 'string', default: '' },
    'has-published-relay-predecessor': { type: 'string', default: 'false' },
    'risk-cli-upgrade': { type: 'string', default: 'false' },
    'risk-session-continuity': { type: 'string', default: 'false' },
    'risk-relay-upgrade': { type: 'string', default: 'false' },
    'include-suites': { type: 'string', default: '' },
    'waive-suites': { type: 'string', default: '' },
    'github-output': { type: 'string', default: '' },
  };
  const { values } = parseArgs({ args: argv, options, allowPositionals: false });
  const githubOutput = String(values['github-output'] ?? '');
  const suiteId = String(values.suite ?? '').trim();
  if (suiteId) {
    if (String(values.profile ?? '').trim()) throw new Error('--suite and --profile are exclusive');
    const gate = resolveReleaseValidationSuiteGate({
      suiteId,
      candidateCliVersion: String(values['candidate-cli-version'] ?? ''),
      hasDesktopCandidate: bool(values['has-desktop-candidate'], '--has-desktop-candidate'),
      candidateChannel: String(values['candidate-channel'] ?? '').trim(),
    });
    if (gate.run !== 'true') process.stderr.write(`release-validation: skipped ${suiteId} (${gate.skip_reason})\n`);
    if (githubOutput) appendFileSync(githubOutput, `${Object.entries(gate).map(([key, value]) => `${key}=${value}`).join('\n')}\n`, 'utf8');
    else process.stdout.write(`${JSON.stringify(gate)}\n`);
    return gate;
  }
  if (bool(values['has-desktop-candidate'], '--has-desktop-candidate') || String(values['candidate-channel'] ?? '').trim() || String(values['candidate-cli-version'] ?? '').trim()) {
    throw new Error('--has-desktop-candidate, --candidate-channel and --candidate-cli-version apply only to --suite (desktop-setup gates build-tauri.yml)');
  }
  const csv = (value) => String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  const result = resolveReleaseValidationPlan({
    profileId: String(values.profile ?? ''),
    sourceBinarySmokeValidated: bool(values['source-binary-smoke-validated'], '--source-binary-smoke-validated'),
    hasCliCandidate: bool(values['has-cli-candidate'], '--has-cli-candidate'),
    hasServerCandidate: bool(values['has-server-candidate'], '--has-server-candidate'),
    hasPublishedRelayPredecessor: bool(values['has-published-relay-predecessor'], '--has-published-relay-predecessor'),
    risks: {
      cliUpgrade: bool(values['risk-cli-upgrade'], '--risk-cli-upgrade'),
      sessionContinuity: bool(values['risk-session-continuity'], '--risk-session-continuity'),
      relayUpgrade: bool(values['risk-relay-upgrade'], '--risk-relay-upgrade'),
    },
    includeSuiteIds: csv(values['include-suites']),
    waiveSuiteIds: csv(values['waive-suites']),
  });
  const lines = [
    ...OUTPUT_KEYS.map((key) => `${key}=${result[key]}`),
    `waived_suite_ids=${result.waivedSuiteIds.join(',')}`,
    `skipped_suites=${result.skippedSuites.join('; ')}`,
  ].join('\n');
  // Visible in the job log, not only in outputs: an unexecutable suite reads "skipped (reason)".
  for (const entry of result.skippedSuites) process.stderr.write(`release-validation: skipped ${entry}\n`);
  if (githubOutput) appendFileSync(githubOutput, `${lines}\n`, 'utf8');
  else process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
