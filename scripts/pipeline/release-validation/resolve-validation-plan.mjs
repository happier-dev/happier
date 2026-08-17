#!/usr/bin/env node

// @ts-check

import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import { resolveAutomaticReleaseValidationExecution } from './registry.mjs';

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

/** @param {unknown} value @param {string} label */
function bool(value, label) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false' || value === '' || value === undefined) return false;
  throw new Error(`${label} must be true or false`);
}

/**
 * @param {{
 *   profileId: string;
 *   hasCliCandidate: boolean;
 *   hasServerCandidate: boolean;
 *   hasPublishedRelayPredecessor: boolean;
 *   risks: { cliUpgrade: boolean; sessionContinuity: boolean; relayUpgrade: boolean };
 *   legacy?: Record<string, string>;
 * }} input
 */
export function resolveReleaseValidationPlan(input) {
  if (!input.profileId) {
    /** @type {Record<string, string>} */
    const legacy = {};
    for (const key of OUTPUT_KEYS) legacy[key] = input.legacy?.[key] === 'true' ? 'true' : 'false';
    return legacy;
  }
  const execution = resolveAutomaticReleaseValidationExecution(input.profileId, {
    hasCliCandidate: input.hasCliCandidate,
    hasServerCandidate: input.hasServerCandidate,
    hasPublishedRelayPredecessor: input.hasPublishedRelayPredecessor,
    risks: input.risks,
  });
  const automatic = new Set(execution.selectedSuiteIds);
  return {
    run_installers_smoke: 'false',
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
  };
}

/** @param {string[]} [argv] */
export async function main(argv = process.argv.slice(2)) {
  const options = {
    profile: { type: 'string', default: '' },
    'has-cli-candidate': { type: 'string', default: 'false' },
    'has-server-candidate': { type: 'string', default: 'false' },
    'has-published-relay-predecessor': { type: 'string', default: 'false' },
    'risk-cli-upgrade': { type: 'string', default: 'false' },
    'risk-session-continuity': { type: 'string', default: 'false' },
    'risk-relay-upgrade': { type: 'string', default: 'false' },
    'github-output': { type: 'string', default: '' },
  };
  for (const key of OUTPUT_KEYS) options[`legacy-${key.replaceAll('_', '-')}`] = { type: 'string', default: 'false' };
  const { values } = parseArgs({ args: argv, options, allowPositionals: false });
  /** @type {Record<string, string>} */
  const legacy = {};
  for (const key of OUTPUT_KEYS) legacy[key] = String(values[`legacy-${key.replaceAll('_', '-')}`] ?? 'false');
  const result = resolveReleaseValidationPlan({
    profileId: String(values.profile ?? ''),
    hasCliCandidate: bool(values['has-cli-candidate'], '--has-cli-candidate'),
    hasServerCandidate: bool(values['has-server-candidate'], '--has-server-candidate'),
    hasPublishedRelayPredecessor: bool(values['has-published-relay-predecessor'], '--has-published-relay-predecessor'),
    risks: {
      cliUpgrade: bool(values['risk-cli-upgrade'], '--risk-cli-upgrade'),
      sessionContinuity: bool(values['risk-session-continuity'], '--risk-session-continuity'),
      relayUpgrade: bool(values['risk-relay-upgrade'], '--risk-relay-upgrade'),
    },
    legacy,
  });
  const lines = Object.entries(result).map(([key, value]) => `${key}=${value}`).join('\n');
  const githubOutput = String(values['github-output'] ?? '');
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
