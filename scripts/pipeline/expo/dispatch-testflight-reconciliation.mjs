#!/usr/bin/env node
// @ts-check

import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { readTestflightBuildRequest } from './testflight-build-request.mjs';
import { resolveTestflightDistributionConfig } from './testflight-distribution-config.mjs';
import {
  formatMobileReleaseEnvironment,
  formatMobileReleaseProfile,
  normalizeMobileReleaseEnvironment,
  normalizeMobileReleaseProfile,
  supportsMobileNativeSubmit,
} from './mobile-release-environments.mjs';

/** @param {string} message @returns {never} */
function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** @param {string[]} args */
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
    'release-id': { type: 'string', default: '' },
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
const normalizedProfile = normalizeMobileReleaseProfile(requestedProfile);
if (!normalizedProfile) fail('--profile must be a supported mobile release profile');
const profile = formatMobileReleaseProfile(normalizedProfile);
const buildJsonPath = String(values['build-json'] ?? '').trim();
if (!buildJsonPath) fail('--build-json is required');

if (environment !== 'production' && !resolveTestflightDistributionConfig({ environment, env: process.env }).enabled) {
  process.stdout.write('[pipeline] TestFlight reconciliation not dispatched because no external groups are configured.\n');
  process.exit(0);
}

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
  'profile', profile,
  'action', environment === 'production' ? 'retry_store_publication' : 'retry_testflight_distribution',
  'publish_apk_release', 'false',
  'retry_testflight_eas_build_id', request.easBuildId,
  'retry_testflight_build_number', request.buildNumber,
  'retry_testflight_app_version', request.appVersion,
];
if (environment === 'production') {
  const releaseId = String(values['release-id'] ?? '').trim();
  if (!releaseId) fail('--release-id is required for production App Store reconciliation');
  fields.push('release_notes_id', releaseId);
}
function dispatch(action) {
  const args = ['workflow', 'run', 'build-ui-mobile-local.yml', '--repo', repository, '--ref', workflowRef];
  for (let index = 0; index < fields.length; index += 2) {
    const value = fields[index] === 'action' ? action : fields[index + 1];
    if (value) args.push('-f', `${fields[index]}=${value}`);
  }
  if (values['dry-run'] === true) process.stdout.write(`[pipeline] exec: gh ${printable(args)}\n`);
  else {
    execFileSync('gh', args, { env: process.env, encoding: 'utf8', stdio: 'inherit', timeout: 120_000 });
    process.stdout.write(`[pipeline] dispatched ${action} for source=${sourceSha} environment=${environmentArg}; public availability remains unverified.\n`);
  }
}

dispatch(environment === 'production' ? 'retry_store_publication' : 'retry_testflight_distribution');
if (environment === 'production' && resolveTestflightDistributionConfig({ environment, env: process.env }).enabled) {
  try { dispatch('retry_testflight_distribution'); } catch {
    // Optional beta distribution cannot withdraw a successfully requested production publication.
    process.stderr.write('[pipeline] testflight_dispatch_failed: App Store publication was requested; retry optional TestFlight distribution separately.\n');
  }
}
