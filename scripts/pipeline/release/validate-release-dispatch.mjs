#!/usr/bin/env node
// @ts-check

import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { releaseTargets } from './component-registry.mjs';
import { validateReleaseValidationRefinements } from '../release-validation/resolve-validation-plan.mjs';

const SHA = /^[0-9a-f]{40}$/u;
const OPERATION = /^rel_[A-Za-z0-9_-]{8,80}$/u;
const ATTEMPT = /^attempt_[1-9][0-9]*$/u;
const RELEASE_NOTES = /^[a-z0-9][a-z0-9._-]*$/u;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[.-][0-9A-Za-z]+)*$/u;
const TARGETS = new Set(releaseTargets);
const OVERRIDE_REASON_MAX = 500;
const PUBLIC_SDK_TEXT_MAX = 500;
const PUBLIC_API_CLASSIFICATIONS = new Set(['unreviewed', 'first_publication', 'compatible', 'breaking']);
const SDK_AUTH_READINESS = new Set(['not_ready', 'ready', 'waived']);

/** @param {unknown} value */
const text = (value) => String(value ?? '').trim();

/** @param {unknown} value */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {Record<string, unknown>} value @param {Set<string>} allowed @param {string} label */
function rejectUnknownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`public_sdk_release_approval ${label} contains unknown field '${unknown[0]}'.`);
}

/** @param {unknown} value @param {string} fallback @param {string} label */
function boundedSingleLine(value, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > PUBLIC_SDK_TEXT_MAX || /[\r\n]/u.test(value)) {
    throw new Error(`public_sdk_release_approval ${label} must be a single-line string of at most ${PUBLIC_SDK_TEXT_MAX} characters.`);
  }
  return value;
}

/**
 * The workflow dispatch surface groups the two related public-SDK judgments so
 * GitHub's input limit does not force removal of release capabilities. This is
 * the only parser; downstream admission consumes its normalized fields.
 *
 * @param {unknown} value
 */
export function parsePublicSdkReleaseApproval(value) {
  const raw = text(value) || '{}';
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error('public_sdk_release_approval must be valid JSON.'); }
  if (!record(parsed)) throw new Error('public_sdk_release_approval must be a JSON object.');
  rejectUnknownKeys(parsed, new Set(['pluginSdk', 'sdk']), 'object');

  const pluginSdk = parsed.pluginSdk ?? {};
  if (!record(pluginSdk)) throw new Error('public_sdk_release_approval pluginSdk must be a JSON object.');
  rejectUnknownKeys(pluginSdk, new Set(['ready', 'apiClassification', 'migrationNotes']), 'pluginSdk');
  const ready = pluginSdk.ready ?? false;
  if (typeof ready !== 'boolean') throw new Error('public_sdk_release_approval pluginSdk.ready must be boolean.');
  const pluginClassification = boundedSingleLine(pluginSdk.apiClassification, 'unreviewed', 'pluginSdk.apiClassification');
  if (!PUBLIC_API_CLASSIFICATIONS.has(pluginClassification)) {
    throw new Error('public_sdk_release_approval pluginSdk.apiClassification is invalid.');
  }

  const sdk = parsed.sdk ?? {};
  if (!record(sdk)) throw new Error('public_sdk_release_approval sdk must be a JSON object.');
  rejectUnknownKeys(sdk, new Set(['authReadiness', 'authWaiver', 'apiClassification', 'migrationNotes']), 'sdk');
  const authReadiness = boundedSingleLine(sdk.authReadiness, 'not_ready', 'sdk.authReadiness');
  if (!SDK_AUTH_READINESS.has(authReadiness)) {
    throw new Error('public_sdk_release_approval sdk.authReadiness is invalid.');
  }
  const sdkClassification = boundedSingleLine(sdk.apiClassification, 'unreviewed', 'sdk.apiClassification');
  if (!PUBLIC_API_CLASSIFICATIONS.has(sdkClassification)) {
    throw new Error('public_sdk_release_approval sdk.apiClassification is invalid.');
  }

  return {
    pluginSdk: {
      ready,
      apiClassification: pluginClassification,
      migrationNotes: boundedSingleLine(pluginSdk.migrationNotes, 'not_required', 'pluginSdk.migrationNotes'),
    },
    sdk: {
      authReadiness,
      authWaiver: boundedSingleLine(sdk.authWaiver, '', 'sdk.authWaiver'),
      apiClassification: sdkClassification,
      migrationNotes: boundedSingleLine(sdk.migrationNotes, 'not_required', 'sdk.migrationNotes'),
    },
  };
}

function csv(value, label) {
  const raw = text(value);
  if (!raw) return [];
  const values = raw.split(',').map((item) => item.trim());
  if (values.some((item) => !/^[a-z0-9-]+$/u.test(item)) || new Set(values).size !== values.length) {
    throw new Error(`${label} must be a unique comma-separated list of validation suite IDs.`);
  }
  return values;
}

/**
 * @param {{
 * authorizedPromotionSourceSha?: string; candidateRunId?: string; candidateVersion?: string;
 * candidateSourceSha?: string; resumeRunId?: string; operationId?: string; attemptId?: string;
 * releaseNotesId?: string; confirm?: string; deployTargets?: string;
 * environment?: string; dryRun?: boolean; eventName?: string; refName?: string;
 * waiveCi?: boolean; includeValidationSuites?: string; waiveValidationSuites?: string; overrideReason?: string;
 * publicSdkReleaseApproval?: string;
 * }} input
 */
export function validateReleaseDispatch(input) {
  const authorizedSha = text(input.authorizedPromotionSourceSha);
  const candidateRunId = text(input.candidateRunId);
  const candidateVersion = text(input.candidateVersion);
  const candidateSourceSha = text(input.candidateSourceSha);
  const resumeRunId = text(input.resumeRunId);
  const operationId = text(input.operationId);
  const attemptId = text(input.attemptId);
  const releaseNotesId = text(input.releaseNotesId);
  const confirm = text(input.confirm);
  const environment = text(input.environment);
  const dryRun = input.dryRun === true;
  const refinements = validateReleaseValidationRefinements({
    includeSuiteIds: csv(input.includeValidationSuites, 'include_validation_suites'),
    waiveSuiteIds: csv(input.waiveValidationSuites, 'waive_validation_suites'),
  });
  const includeValidationSuiteIds = refinements.includeSuiteIds;
  const waiveValidationSuiteIds = refinements.waiveSuiteIds;
  const waiveCi = input.waiveCi === true;
  const overrideReason = text(input.overrideReason);
  const publicSdkReleaseApproval = parsePublicSdkReleaseApproval(input.publicSdkReleaseApproval);
  if ((waiveCi || waiveValidationSuiteIds.length > 0) && !overrideReason) {
    throw new Error('override_reason is required when CI or validation evidence is waived.');
  }
  if (overrideReason.length > OVERRIDE_REASON_MAX || /[\r\n]/u.test(overrideReason)) {
    throw new Error(`override_reason must be a single line of at most ${OVERRIDE_REASON_MAX} characters.`);
  }

  const candidateValues = [candidateRunId, candidateVersion, candidateSourceSha].filter(Boolean).length;
  if (resumeRunId && candidateValues !== 0) throw new Error('Top-level resume cannot combine with CLI candidate-run promotion.');
  if (candidateValues !== 0 && candidateValues !== 3) throw new Error('Candidate promotion requires run ID, version, and source SHA together.');
  if (candidateValues === 3) {
    if (environment !== 'preview') throw new Error('CLI candidate promotion is supported only for preview releases.');
    if (!/^\d+$/u.test(candidateRunId)) throw new Error('Candidate run ID must contain only decimal digits.');
    if (!SHA.test(candidateSourceSha)) throw new Error('Candidate source SHA must be exactly 40 lowercase hexadecimal characters.');
    if (!VERSION.test(candidateVersion)) throw new Error('Candidate version must be a canonical release version.');
  }
  if (resumeRunId && !/^\d+$/u.test(resumeRunId)) throw new Error('Resume run ID must contain only decimal digits.');
  if (!dryRun && !authorizedSha) throw new Error('authorized_promotion_source_sha is required when dry_run is false.');
  if (authorizedSha && !SHA.test(authorizedSha)) throw new Error('authorized_promotion_source_sha must be exactly 40 lowercase hexadecimal characters.');
  if (operationId && !OPERATION.test(operationId)) throw new Error('hmaint_operation_id has an invalid format.');
  if (operationId && !ATTEMPT.test(attemptId)) throw new Error('hmaint_attempt_id must match attempt_<positive integer>.');
  if (!RELEASE_NOTES.test(releaseNotesId)) throw new Error('release_notes_id has an invalid format.');

  let mode;
  let sourceRef = 'dev';
  let baseRef = 'preview';
  let compareLabel = 'preview..dev';
  if (environment === 'preview') {
    if (confirm !== 'release dev to preview') throw new Error('Confirmation mismatch for preview releases.');
    mode = 'preview_release';
  } else if (environment === 'production') {
    baseRef = 'main';
    const modes = new Map([
      ['release preview to main', 'promote_main_from_preview_fast_forward'],
      ['reset main from preview', 'promote_main_from_preview_reset'],
      ['release dev to main', 'promote_main_from_dev_fast_forward'],
      ['reset main from dev', 'promote_main_from_dev_reset'],
    ]);
    mode = modes.get(confirm);
    if (!mode) throw new Error(`Unknown confirmation phrase: ${confirm}`);
    if (confirm === 'release preview to main' || confirm === 'reset main from preview') {
      sourceRef = 'preview';
      compareLabel = 'main..preview';
    }
  } else {
    throw new Error(`Unsupported release environment: ${environment}`);
  }

  if (input.eventName === 'workflow_dispatch' && !['dev', 'preview', 'main'].includes(text(input.refName))) {
    throw new Error(`Refusing workflow_dispatch from untrusted ref '${text(input.refName)}'.`);
  }
  const deployTargets = text(input.deployTargets).toLowerCase().replaceAll(/\s/gu, '').split(',').filter(Boolean);
  for (const target of deployTargets) {
    if (!TARGETS.has(target)) throw new Error(`Unknown deploy_targets entry: '${target}'.`);
  }
  return {
    mode,
    sourceRef,
    baseRef,
    compareLabel,
    deployTargets,
    overrides: { waiveCi, includeValidationSuiteIds, waiveValidationSuiteIds, reason: overrideReason },
    publicSdkReleaseApproval,
  };
}

/** @param {Record<string, string | undefined>} env */
export function validateReleaseDispatchFromEnvironment(env) {
  return validateReleaseDispatch({
    authorizedPromotionSourceSha: env.AUTHORIZED_PROMOTION_SOURCE_SHA,
    candidateRunId: env.CANDIDATE_RUN_ID,
    candidateVersion: env.CANDIDATE_VERSION,
    candidateSourceSha: env.CANDIDATE_SOURCE_SHA,
    resumeRunId: env.RESUME_RUN_ID,
    operationId: env.HMAINT_OPERATION_ID,
    attemptId: env.HMAINT_ATTEMPT_ID,
    releaseNotesId: env.RELEASE_NOTES_ID,
    confirm: env.CONFIRM,
    deployTargets: env.DEPLOY_TARGETS,
    environment: env.ENVIRONMENT,
    dryRun: env.DRY_RUN === 'true',
    eventName: env.GITHUB_EVENT_NAME,
    refName: env.GITHUB_REF_NAME,
    waiveCi: env.WAIVE_CI === 'true',
    includeValidationSuites: env.INCLUDE_VALIDATION_SUITES,
    waiveValidationSuites: env.WAIVE_VALIDATION_SUITES,
    overrideReason: env.OVERRIDE_REASON,
    publicSdkReleaseApproval: env.PUBLIC_SDK_RELEASE_APPROVAL,
  });
}

export async function main() {
  const result = validateReleaseDispatchFromEnvironment(process.env);
  if (process.env.GITHUB_OUTPUT) {
    const approval = result.publicSdkReleaseApproval;
    await appendFile(process.env.GITHUB_OUTPUT, [
      `mode=${result.mode}`,
      `source_ref=${result.sourceRef}`,
      `base_ref=${result.baseRef}`,
      `compare_label=${result.compareLabel}`,
      `plugin_sdk_ready=${approval.pluginSdk.ready}`,
      `plugin_sdk_api_classification=${approval.pluginSdk.apiClassification}`,
      `plugin_sdk_migration_notes=${approval.pluginSdk.migrationNotes}`,
      `sdk_auth_readiness=${approval.sdk.authReadiness}`,
      `sdk_auth_waiver=${approval.sdk.authWaiver}`,
      `sdk_api_classification=${approval.sdk.apiClassification}`,
      `sdk_migration_notes=${approval.sdk.migrationNotes}`,
      '',
    ].join('\n'), 'utf8');
  } else {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
