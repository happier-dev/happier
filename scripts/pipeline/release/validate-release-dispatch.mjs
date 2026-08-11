#!/usr/bin/env node
// @ts-check

import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const SHA = /^[0-9a-f]{40}$/u;
const OPERATION = /^rel_[A-Za-z0-9_-]{8,80}$/u;
const ATTEMPT = /^attempt_[1-9][0-9]*$/u;
const RELEASE_NOTES = /^[a-z0-9][a-z0-9._-]*$/u;
const TARGETS = new Set(['ui', 'server', 'website', 'docs', 'cli', 'stack', 'server_runner']);

/** @param {unknown} value */
const text = (value) => String(value ?? '').trim();

/**
 * @param {{ authorizedPromotionSourceSha?: string; resumeRunId?: string; operationId?: string;
 * attemptId?: string; releaseNotesId?: string; bump?: string; confirm?: string;
 * deployTargets?: string; environment?: string; dryRun?: boolean; eventName?: string; refName?: string }} input
 */
export function validateReleaseDispatch(input) {
  const authorizedSha = text(input.authorizedPromotionSourceSha);
  const resumeRunId = text(input.resumeRunId);
  const operationId = text(input.operationId);
  const attemptId = text(input.attemptId);
  const releaseNotesId = text(input.releaseNotesId);
  const bump = text(input.bump);
  const confirm = text(input.confirm);
  const environment = text(input.environment);
  const dryRun = input.dryRun === true;

  if (resumeRunId && !/^\d+$/u.test(resumeRunId)) throw new Error('Resume run ID must contain only decimal digits.');
  if (!dryRun && !authorizedSha) throw new Error('authorized_promotion_source_sha is required when dry_run is false.');
  if (authorizedSha && !SHA.test(authorizedSha)) throw new Error('authorized_promotion_source_sha must be exactly 40 lowercase hexadecimal characters.');
  if (operationId && !OPERATION.test(operationId)) throw new Error('hmaint_operation_id has an invalid format.');
  if (operationId && !ATTEMPT.test(attemptId)) throw new Error('hmaint_attempt_id must match attempt_<positive integer>.');
  if (!RELEASE_NOTES.test(releaseNotesId)) throw new Error('release_notes_id has an invalid format.');
  if (bump !== 'none') throw new Error('Release candidates must already be materialized; final exact-SHA promotion requires bump=none.');

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
  return { mode, sourceRef, baseRef, compareLabel, deployTargets };
}

/** @param {Record<string, string | undefined>} env */
export function validateReleaseDispatchFromEnvironment(env) {
  return validateReleaseDispatch({
    authorizedPromotionSourceSha: env.AUTHORIZED_PROMOTION_SOURCE_SHA,
    resumeRunId: env.RESUME_RUN_ID,
    operationId: env.HMAINT_OPERATION_ID,
    attemptId: env.HMAINT_ATTEMPT_ID,
    releaseNotesId: env.RELEASE_NOTES_ID,
    bump: env.BUMP,
    confirm: env.CONFIRM,
    deployTargets: env.DEPLOY_TARGETS,
    environment: env.ENVIRONMENT,
    dryRun: env.DRY_RUN === 'true',
    eventName: env.GITHUB_EVENT_NAME,
    refName: env.GITHUB_REF_NAME,
  });
}

export async function main() {
  const result = validateReleaseDispatchFromEnvironment(process.env);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `mode=${result.mode}\nsource_ref=${result.sourceRef}\nbase_ref=${result.baseRef}\ncompare_label=${result.compareLabel}\n`, 'utf8');
  } else {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
