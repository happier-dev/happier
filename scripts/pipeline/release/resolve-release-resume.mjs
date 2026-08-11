#!/usr/bin/env node

// @ts-check

import { appendFile, readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import { validateCandidateVersions } from './verify-release-candidate-identity.mjs';

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const RESUMABLE_PRODUCTS = new Set(['cli', 'stack', 'server', 'ui-web']);
const TRUSTED_RELEASE_CONTROL_BRANCHES = new Set(['dev', 'preview', 'main']);
const RESUMABLE_WORKFLOW_EVENTS = new Map([
  ['.github/workflows/nightly-dev.yml', new Set(['schedule', 'workflow_dispatch'])],
  ['.github/workflows/release.yml', new Set(['workflow_dispatch'])],
]);

/** @param {unknown} value @param {string} label */
function asRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`[release] ${label} must be an object`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value @param {string} label */
function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error(`[release] ${label} must be a non-empty trimmed string`);
  }
  return value;
}

/** @param {unknown} value @param {string} label */
function requiredSha(value, label) {
  const sha = requiredString(value, label).toLowerCase();
  if (!SHA_PATTERN.test(sha)) throw new Error(`[release] ${label} must be a full commit SHA`);
  return sha;
}

/** @param {unknown} value */
function flattenArtifacts(value) {
  if (!Array.isArray(value)) {
    const page = asRecord(value, 'artifacts response');
    if (!Array.isArray(page.artifacts)) throw new Error('[release] artifacts response must contain artifacts');
    return page.artifacts;
  }
  const flattened = [];
  for (const entry of value) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry) && Array.isArray(entry.artifacts)) {
      flattened.push(...entry.artifacts);
    } else {
      flattened.push(entry);
    }
  }
  return flattened;
}

/**
 * @param {{
 *   originRun: unknown;
 *   artifacts: unknown;
 *   expected: { repository: string; workflowPath: string; channel: string; sourceSha?: string; operationId?: string };
 * }} input
 */
export function inspectReleaseResumeOrigin(input) {
  const run = asRecord(input.originRun, 'origin run');
  const expectedRepository = requiredString(input.expected.repository, 'expected repository');
  const expectedWorkflowPath = requiredString(input.expected.workflowPath, 'expected workflow path');
  const repository = asRecord(run.repository, 'origin run repository');
  const headRepository = asRecord(run.head_repository, 'origin run head repository');
  if (repository.full_name !== expectedRepository || headRepository.full_name !== expectedRepository) {
    throw new Error('[release] resume origin must belong to the expected repository and head repository');
  }
  if (run.path !== expectedWorkflowPath) {
    throw new Error(`[release] resume origin workflow path does not match ${expectedWorkflowPath}`);
  }
  const allowedEvents = RESUMABLE_WORKFLOW_EVENTS.get(expectedWorkflowPath);
  if (!allowedEvents || !allowedEvents.has(requiredString(run.event, 'resume origin event'))) {
    throw new Error('[release] resume origin event is not supported for the expected workflow');
  }
  if (!TRUSTED_RELEASE_CONTROL_BRANCHES.has(requiredString(run.head_branch, 'resume origin control branch'))) {
    throw new Error('[release] resume origin control branch is not trusted');
  }
  if (run.status !== 'completed') {
    throw new Error('[release] resume origin run must be completed');
  }
  if (!Number.isSafeInteger(run.id) || Number(run.id) < 1) {
    throw new Error('[release] resume origin run ID must be a positive safe integer');
  }
  const runId = Number(run.id);
  const workflowSha = requiredSha(run.head_sha, 'resume origin workflow SHA');
  const expectedUrl = `https://github.com/${expectedRepository}/actions/runs/${runId}`;
  if (run.html_url !== expectedUrl) {
    throw new Error('[release] resume origin URL does not bind the expected repository and run ID');
  }

  const matches = flattenArtifacts(input.artifacts)
    .map((entry) => asRecord(entry, 'artifact'))
    .filter((artifact) => artifact.name === 'happier-release-status');
  if (matches.length !== 1) {
    throw new Error('[release] resume origin must contain exactly one happier-release-status artifact');
  }
  const artifact = matches[0];
  if (artifact.expired !== false) throw new Error('[release] resume status artifact is expired');
  if (!Number.isSafeInteger(artifact.id) || Number(artifact.id) < 1) {
    throw new Error('[release] resume status artifact ID is invalid');
  }
  const digest = requiredString(artifact.digest, 'resume status artifact digest').toLowerCase();
  if (!DIGEST_PATTERN.test(digest)) {
    throw new Error('[release] resume status artifact digest must be SHA-256');
  }
  const workflowRun = asRecord(artifact.workflow_run, 'resume status artifact workflow run');
  if (workflowRun.id !== runId || requiredSha(workflowRun.head_sha, 'artifact workflow SHA') !== workflowSha) {
    throw new Error('[release] resume status artifact does not belong to the exact origin run and workflow SHA');
  }
  return { artifactDigest: digest, artifactId: Number(artifact.id), workflowSha };
}

/**
 * @param {{
 *   originRun: unknown;
 *   artifacts: unknown;
 *   downloadedDigest: string;
 *   status: unknown;
 *   expected: { repository: string; workflowPath: string; channel: string; sourceSha?: string; operationId?: string };
 * }} input
 */
export function resolveReleaseResume(input) {
  const inspected = inspectReleaseResumeOrigin(input);
  const downloadedDigest = requiredString(input.downloadedDigest, 'downloaded status digest').toLowerCase();
  if (downloadedDigest !== inspected.artifactDigest) {
    throw new Error('[release] downloaded resume status artifact digest does not match GitHub metadata');
  }
  const status = asRecord(input.status, 'resume status');
  if (status.schemaVersion !== 1 || status.kind !== 'happier.release-status.v1') {
    throw new Error('[release] resume status uses an unsupported schema');
  }
  if (status.channel !== input.expected.channel) {
    throw new Error('[release] resume status channel does not match the requested channel');
  }
  const statusSourceSha = requiredSha(status.sourceSha, 'resume status source SHA');
  if (input.expected.sourceSha && statusSourceSha !== requiredSha(input.expected.sourceSha, 'expected source SHA')) {
    throw new Error('[release] resume status source SHA does not match the authorized source SHA');
  }
  const statusRun = asRecord(status.run, 'resume status run');
  const originRun = asRecord(input.originRun, 'origin run');
  if (statusRun.id !== originRun.id || statusRun.url !== originRun.html_url) {
    throw new Error('[release] resume status run identity does not match the origin run');
  }
  const statusOperationId = status.operationId === undefined ? '' : requiredString(status.operationId, 'resume status operation');
  const expectedOperationId = input.expected.operationId ?? '';
  if (statusOperationId !== expectedOperationId) {
    throw new Error('[release] resume status operation does not match the requested operation');
  }
  if (!Array.isArray(status.surfaces)) {
    throw new Error('[release] resume status surfaces must be an array');
  }

  /** @type {Record<'cli' | 'stack' | 'server' | 'ui-web', string>} */
  const versions = { cli: '', stack: '', server: '', 'ui-web': '' };
  for (const [index, rawSurface] of status.surfaces.entries()) {
    const surface = asRecord(rawSurface, `resume status surface ${index}`);
    if (surface.state !== 'complete' || surface.result !== 'success') continue;
    if (!surface.identity || typeof surface.identity !== 'object' || Array.isArray(surface.identity)) continue;
    const identity = /** @type {Record<string, unknown>} */ (surface.identity);
    if (!Object.hasOwn(identity, 'product')) continue;
    const rawProduct = requiredString(identity.product, `resume status surface ${index} product`);
    const product = rawProduct === 'hstack' ? 'stack' : rawProduct;
    if (!RESUMABLE_PRODUCTS.has(product)) {
      throw new Error(`[release] unsupported resumable product: ${rawProduct}`);
    }
    if (identity.verified !== true) {
      throw new Error(`[release] resumable ${product} candidate is not owner-verified`);
    }
    if (requiredSha(identity.sourceSha, `resumable ${product} source SHA`) !== statusSourceSha) {
      throw new Error(`[release] resumable ${product} candidate source SHA does not match the release`);
    }
    if (versions[/** @type {'cli' | 'stack' | 'server' | 'ui-web'} */ (product)]) {
      throw new Error(`[release] duplicate resumable ${product} candidate`);
    }
    versions[/** @type {'cli' | 'stack' | 'server' | 'ui-web'} */ (product)] = requiredString(
      identity.version,
      `resumable ${product} version`,
    );
  }
  const validated = validateCandidateVersions({ channel: input.expected.channel, versions });
  if (!Object.values(validated.versions).some(Boolean)) {
    throw new Error('[release] resume origin contains no verified immutable candidates to reuse');
  }
  return { sourceSha: statusSourceSha, versions: validated.versions };
}

/** @param {string} path */
async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

/** @param {string} path @param {Record<string, string | number>} outputs */
async function writeOutputs(path, outputs) {
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join('');
  await appendFile(path, lines, 'utf8');
}

/** @param {string[]} [argv] */
export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      mode: { type: 'string' },
      'origin-run-json': { type: 'string' },
      'artifacts-json': { type: 'string' },
      'status-json': { type: 'string' },
      'downloaded-digest': { type: 'string', default: '' },
      'expected-repository': { type: 'string' },
      'expected-workflow': { type: 'string' },
      'expected-channel': { type: 'string' },
      'expected-source-sha': { type: 'string', default: '' },
      'expected-operation-id': { type: 'string', default: '' },
      'github-output': { type: 'string' },
    },
    allowPositionals: false,
  });
  const mode = String(values.mode ?? '');
  const originRun = await readJson(String(values['origin-run-json'] ?? ''));
  const artifacts = await readJson(String(values['artifacts-json'] ?? ''));
  const expected = {
    repository: String(values['expected-repository'] ?? ''),
    workflowPath: String(values['expected-workflow'] ?? ''),
    channel: String(values['expected-channel'] ?? ''),
    sourceSha: String(values['expected-source-sha'] ?? ''),
    operationId: String(values['expected-operation-id'] ?? ''),
  };
  const outputPath = String(values['github-output'] ?? '');
  if (!outputPath) throw new Error('[release] --github-output is required');

  if (mode === 'inspect') {
    const inspected = inspectReleaseResumeOrigin({ originRun, artifacts, expected });
    await writeOutputs(outputPath, {
      artifact_digest: inspected.artifactDigest,
      artifact_id: inspected.artifactId,
      workflow_sha: inspected.workflowSha,
    });
    return inspected;
  }
  if (mode === 'resolve') {
    const resolved = resolveReleaseResume({
      originRun,
      artifacts,
      downloadedDigest: String(values['downloaded-digest'] ?? ''),
      status: await readJson(String(values['status-json'] ?? '')),
      expected,
    });
    await writeOutputs(outputPath, {
      source_sha: resolved.sourceSha,
      cli_version: resolved.versions.cli,
      stack_version: resolved.versions.stack,
      server_version: resolved.versions.server,
      ui_web_version: resolved.versions['ui-web'],
    });
    return resolved;
  }
  throw new Error('[release] --mode must be inspect or resolve');
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
