#!/usr/bin/env node
// @ts-check

import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { readTestflightBuildRequest } from './testflight-build-request.mjs';
import {
  formatMobileReleaseEnvironment,
  formatMobileReleaseProfile,
  normalizeMobileReleaseEnvironment,
  normalizeMobileReleaseProfile,
  supportsMobileNativeSubmit,
} from './mobile-release-environments.mjs';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function printable(args) {
  return args.map((value) => JSON.stringify(value)).join(' ');
}

const { values } = parseArgs({
  options: {
    repository: { type: 'string' },
    'workflow-ref': { type: 'string' },
    'source-sha': { type: 'string' },
    environment: { type: 'string' },
    profile: { type: 'string' },
    'build-json': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

const repository = String(values.repository ?? '').trim();
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) fail('--repository must be an owner/repository slug');
const workflowRef = String(values['workflow-ref'] ?? '').trim();
if (!['dev', 'preview', 'main'].includes(workflowRef)) fail('--workflow-ref must be dev, preview, or main');
const sourceSha = String(values['source-sha'] ?? '').trim();
if (!/^[a-f0-9]{40}$/u.test(sourceSha)) fail('--source-sha must be an exact lowercase commit SHA');
const environment = normalizeMobileReleaseEnvironment(values.environment);
if (!environment || !supportsMobileNativeSubmit(environment)) fail('--environment must select a store-capable mobile release environment');
const environmentArg = formatMobileReleaseEnvironment(environment);
const requestedProfile = String(values.profile ?? '').trim();
const profile = normalizeMobileReleaseProfile(requestedProfile) || requestedProfile;
if (!profile || !/^[a-z0-9-]+$/u.test(profile)) fail('--profile must be a valid EAS profile name');
const profileArg = formatMobileReleaseProfile(profile);
const buildJsonPath = String(values['build-json'] ?? '').trim();
if (!buildJsonPath) fail('--build-json is required');

let request;
try {
  request = readTestflightBuildRequest({ buildJsonPath });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

if (request.skipped === true) {
  process.stdout.write('[pipeline] TestFlight reconciliation not dispatched because the native build was skipped.\n');
  process.exit(0);
}

const fields = [
  'source_ref', sourceSha,
  'environment', environmentArg,
  'platform', 'ios',
  'profile', profileArg,
  'action', 'retry_testflight_distribution',
  'publish_apk_release', 'false',
  'retry_testflight_eas_build_id', request.easBuildId,
  'retry_testflight_build_number', request.buildNumber,
  'retry_testflight_app_version', request.appVersion,
];
const args = ['workflow', 'run', 'build-ui-mobile-local.yml', '--repo', repository, '--ref', workflowRef];
for (let index = 0; index < fields.length; index += 2) {
  const value = fields[index + 1];
  if (!value) continue;
  args.push('-f', `${fields[index]}=${value}`);
}

if (values['dry-run'] === true) {
  process.stdout.write(`[pipeline] exec: gh ${printable(args)}\n`);
} else {
  execFileSync('gh', args, {
    env: process.env,
    encoding: 'utf8',
    stdio: 'inherit',
    timeout: 120_000,
  });
  process.stdout.write(`[pipeline] dispatched TestFlight reconciliation for source=${sourceSha} environment=${environmentArg}\n`);
}
