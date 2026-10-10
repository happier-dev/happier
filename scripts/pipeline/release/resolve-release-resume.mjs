#!/usr/bin/env node

// @ts-check

import { appendFile, readFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import { validateCandidateVersions } from './verify-release-candidate-identity.mjs';
import { fileSha256 } from './lib/artifact-checksums.mjs';
import { execFileSyncPortable } from '../lib/exec-file-sync-portable.mjs';
import { downloadReleaseAssetWithRetry } from '../github/lib/release-asset-transfer.mjs';
import { BUNDLE_CANDIDATE_PLATFORMS } from '../tauri/bundle-candidate.mjs';

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const OPERATION_ID_PATTERN = /^rel_[A-Za-z0-9_-]{8,80}$/u;
const RESUMABLE_PRODUCTS = new Set(['cli', 'stack', 'server', 'runner', 'ui-web']);
const RESUMABLE_SURFACE_PRODUCTS = new Map([
  ['cli-immutable-candidate', 'cli'],
  ['hstack-immutable-candidate', 'stack'],
  ['server-immutable-candidate', 'server'],
  ['runner-immutable-candidate', 'runner'],
  ['ui-web-immutable-candidate', 'ui-web'],
]);
const RESUMABLE_COMPLETION_SURFACES = new Map([
  ['deploy_docs', 'deployDocs'],
  ['deploy_server', 'deployServer'],
  ['deploy_ui', 'deployUi'],
  ['deploy_website', 'deployWebsite'],
  ['docker', 'docker'],
  ['npm', 'npm'],
]);
const RESUMABLE_VERIFIED_COMPLETION_SURFACES = new Map([
  ['cli_rolling_release', 'cliRolling'],
  ['hstack_rolling_release', 'stackRolling'],
  ['server_rolling_release', 'serverRolling'],
  ['runner_rolling_release', 'runnerRolling'],
  ['ui_web_rolling_release', 'uiWebRolling'],
]);
const TRUSTED_RELEASE_CONTROL_BRANCHES = new Set(['dev', 'preview', 'main']);
const RESUMABLE_WORKFLOW_EVENTS = new Map([
  ['.github/workflows/nightly-dev.yml', new Set(['schedule', 'workflow_dispatch'])],
  ['.github/workflows/release.yml', new Set(['workflow_dispatch'])],
]);
const STANDARD_RELEASE_WORKFLOWS = new Set([
  '.github/workflows/release.yml',
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

/** @param {unknown} value @param {string} label */
function requiredBoolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`[release] ${label} must be boolean`);
  return value;
}

/** @param {unknown} value @param {string} label @param {readonly string[]} allowed */
function requiredChoice(value, label, allowed) {
  const selected = requiredString(value, label);
  if (!allowed.includes(selected)) throw new Error(`[release] ${label} is unsupported`);
  return selected;
}

/** @param {unknown} value @param {string} label */
function optionalOperationId(value, label) {
  if (value === undefined || value === '') return '';
  const operationId = requiredString(value, label);
  if (!OPERATION_ID_PATTERN.test(operationId)) {
    throw new Error(`[release] ${label} must be a conductor release operation ID`);
  }
  return operationId;
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
 * Candidate-bound status and exact-origin successful steps admit these flows
 * independently of the control SHA, not store public availability.
 * @param {unknown} value
 * @param {{ runId: number; workflowSha: string; sourceSha: string; expectedSourceSha?: string; operationId?: string; workflowPath: string; channel: string; statusArtifactName?: string; requested: boolean; expoAction: string }} identity
 */
function resolveUiFlowCompletion(value, identity) {
  const completed = { ota: false, nativeIos: false, nativeAndroid: false, apk: false };
  if (!value || !identity.requested || !identity.operationId || identity.sourceSha !== identity.expectedSourceSha
    || !['preview', 'production'].includes(identity.channel)
    || identity.workflowPath !== '.github/workflows/release.yml') return completed;
  const pages = Array.isArray(value) ? value : [value];
  const jobs = pages.flatMap((page) => {
    const entry = asRecord(page, 'resume jobs response');
    return Array.isArray(entry.jobs) ? entry.jobs : [entry];
  }).map((job) => asRecord(job, 'resume job'));
  /** @param {string} name @param {string[]} stepNames @param {string} [legacyName] @param {string[]} [legacySteps] */
  const accepted = (name, stepNames, legacyName = name, legacySteps = stepNames) => {
    const evidence = identity.statusArtifactName === `happier-release-status-${identity.channel}`
      ? [{ name: `Release ${identity.channel} channel / deploy_ui / ${name}`, steps: stepNames }]
      : [{ name: `deploy_ui / ${legacyName}`, steps: legacySteps },
        { name: `Release single channel / deploy_ui / ${name}`, steps: stepNames }];
    const matches = jobs.flatMap((job) => evidence.filter((entry) => entry.name === job.name)
      .map((entry) => ({ job, stepNames: entry.steps })));
    if (matches.length !== 1) return false;
    const { job, stepNames: admittedSteps } = matches[0];
    if (!Number.isSafeInteger(job.id) || Number(job.id) < 1 || job.run_id !== identity.runId || job.head_sha !== identity.workflowSha
      || job.status !== 'completed' || job.conclusion !== 'success' || !Array.isArray(job.steps)) return false;
    return admittedSteps.every((stepName) => {
      const matches = job.steps.filter((step) => step && typeof step === 'object' && step.name === stepName);
      return matches.length === 1 && matches[0].status === 'completed' && matches[0].conclusion === 'success';
    });
  };
  if (['ota', 'full'].includes(identity.expoAction)) {
    completed.ota = accepted('promote', ['Publish Android OTA from validated bytes', 'Publish iOS OTA from validated bytes']);
  }
  if (['native', 'native_submit', 'full'].includes(identity.expoAction)) {
    completed.nativeIos = accepted('Mobile native (local runner) / Build (ios)', ['EAS build (local runner) (pipeline)']);
    completed.nativeAndroid = accepted('Mobile native (local runner) / Build (android)', ['EAS build (local runner) (pipeline)']);
    // The historical direct workflow published within its build; current control owns publication separately.
    completed.apk = accepted('Mobile APK release (local runner) / Sign and publish Android APK',
      ['Sign and publish APK with trusted control'],
      'Mobile APK release (local runner) / Build (android)', ['EAS build (local runner) (pipeline)']);
  }
  return completed;
}

/** @param {Record<string, unknown>} artifact @param {number} runId @param {string} workflowSha */
function inspectOriginArtifact(artifact, runId, workflowSha) {
  if (!Number.isSafeInteger(artifact.id) || Number(artifact.id) < 1) {
    throw new Error('[release] resume artifact ID is invalid');
  }
  const digest = requiredString(artifact.digest, 'resume artifact digest').toLowerCase();
  if (!DIGEST_PATTERN.test(digest)) throw new Error('[release] resume artifact digest must be SHA-256');
  const workflowRun = asRecord(artifact.workflow_run, 'resume artifact workflow run');
  if (workflowRun.id !== runId || requiredSha(workflowRun.head_sha, 'artifact workflow SHA') !== workflowSha) {
    throw new Error('[release] resume artifact does not belong to the exact origin run and workflow SHA');
  }
  return { id: Number(artifact.id), digest };
}

/** @param {unknown} artifacts @param {Record<string, unknown>} run @param {string} workflowSha @param {string} channel @param {boolean} allowLegacy */
function resolveDesktopArtifacts(artifacts, run, workflowSha, channel, allowLegacy) {
  if (!Number.isSafeInteger(run.run_number) || Number(run.run_number) < 1) {
    throw new Error('[release] desktop origin run number must be a positive safe integer');
  }
  /** @type {Record<string, { id: number; digest: string }>} */
  const selected = {};
  /** @type {Record<string, { id: number; digest: string }>} */
  const finalized = {};
  const seen = new Set();
  for (const rawArtifact of flattenArtifacts(artifacts)) {
    const artifact = asRecord(rawArtifact, 'artifact');
    if (typeof artifact.name !== 'string') continue;
    const prefix = ['tauri-candidate-', 'tauri-updates-'].find((value) => artifact.name.startsWith(value));
    if (!prefix) continue;
    const suffix = artifact.name.slice(prefix.length);
    const environment = ['dev', 'preview', 'production'].find((value) => suffix.startsWith(`${value}-`));
    if (environment && environment !== channel) {
      if (allowLegacy) throw new Error('[release] desktop artifact channel does not match nightly');
      continue;
    }
    // Only the released single-channel nightly predecessor used unscoped names.
    if (!environment && !allowLegacy) throw new Error('[release] desktop artifact must be channel-scoped for a release origin');
    const platform = environment ? suffix.slice(environment.length + 1) : suffix;
    if (!BUNDLE_CANDIDATE_PLATFORMS.includes(platform)) throw new Error('[release] unknown desktop artifact platform');
    const key = `${prefix}${platform}`;
    if (seen.has(key)) throw new Error('[release] duplicate desktop artifact');
    seen.add(key);
    const admitted = inspectOriginArtifact(artifact, Number(run.id), workflowSha);
    if (typeof artifact.expired !== 'boolean') throw new Error('[release] desktop artifact expiry must be boolean');
    if (!artifact.expired) (prefix === 'tauri-updates-' ? finalized : selected)[platform] = admitted;
  }
  return { runNumber: Number(run.run_number), artifacts: selected,
    ...(!allowLegacy || Object.keys(finalized).length > 0 ? { finalizedArtifacts: finalized } : {}) };
}

/** @param {{ repository: string; artifactId: number; digest: string; archivePath: string }} input */
export async function downloadReleaseResumeArtifact(input) {
  const repository = requiredString(input.repository, 'artifact repository');
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository)) throw new Error('[release] invalid artifact repository');
  if (!Number.isSafeInteger(input.artifactId) || input.artifactId < 1) throw new Error('[release] invalid artifact ID');
  if (!DIGEST_PATTERN.test(input.digest)) throw new Error('[release] invalid artifact digest');
  const archivePath = requiredString(input.archivePath, 'artifact archive path');
  await downloadReleaseAssetWithRetry({
    name: `Actions artifact ${input.artifactId}`,
    download(timeoutMs) {
      const descriptor = openSync(archivePath, 'w');
      try {
        execFileSyncPortable('gh', ['api', `repos/${repository}/actions/artifacts/${input.artifactId}/zip`], {
          stdio: ['ignore', descriptor, 'pipe'], timeout: timeoutMs,
        });
      } finally {
        closeSync(descriptor);
      }
    },
  });
  if (`sha256:${await fileSha256(input.archivePath)}` !== input.digest) {
    throw new Error('[release] downloaded resume artifact digest does not match GitHub metadata');
  }
}

/**
 * @param {{
 *   originRun: unknown;
 *   artifacts: unknown;
 *   expected: { repository: string; workflowPath: string; channel: string; sourceSha?: string; operationId?: string; statusArtifactName?: string };
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
  if (run.status !== 'completed') throw new Error('[release] resume origin run must be completed');
  if (!Number.isSafeInteger(run.id) || Number(run.id) < 1) {
    throw new Error('[release] resume origin run ID must be a positive safe integer');
  }
  const runId = Number(run.id);
  const workflowSha = requiredSha(run.head_sha, 'resume origin workflow SHA');
  const expectedUrl = `https://github.com/${expectedRepository}/actions/runs/${runId}`;
  if (run.html_url !== expectedUrl) {
    throw new Error('[release] resume origin URL does not bind the expected repository and run ID');
  }

  const artifacts = flattenArtifacts(input.artifacts).map((entry) => asRecord(entry, 'artifact'));
  let statusArtifactName = input.expected.statusArtifactName === undefined || input.expected.statusArtifactName === ''
    ? '' : requiredString(input.expected.statusArtifactName, 'resume status artifact name');
  if (!statusArtifactName) {
    const scoped = expectedWorkflowPath === '.github/workflows/release.yml'
      && artifacts.some((artifact) => ['happier-release-status-preview', 'happier-release-status-production'].includes(String(artifact.name)));
    if (scoped && artifacts.some((artifact) => artifact.name === 'happier-release-status')) {
      throw new Error('[release] resume status artifact topology is ambiguous');
    }
    statusArtifactName = scoped ? `happier-release-status-${input.expected.channel}` : 'happier-release-status';
  }
  if (statusArtifactName !== 'happier-release-status'
    && (expectedWorkflowPath !== '.github/workflows/release.yml'
      || !['preview', 'production'].includes(input.expected.channel)
      || statusArtifactName !== `happier-release-status-${input.expected.channel}`)) {
    throw new Error('[release] resume status artifact name must match the requested workflow and channel');
  }
  const matches = artifacts.filter((artifact) => artifact.name === statusArtifactName);
  if (matches.length !== 1) {
    throw new Error(`[release] resume origin must contain exactly one ${statusArtifactName} artifact`);
  }
  const artifact = matches[0];
  if (artifact.expired !== false) throw new Error('[release] resume status artifact is expired');
  const admitted = inspectOriginArtifact(artifact, runId, workflowSha);
  return { artifactDigest: admitted.digest, artifactId: admitted.id, workflowSha, statusArtifactName };
}

/**
 * @param {{
 *   originRun: unknown;
 *   artifacts: unknown;
 *   downloadedDigest: string;
 *   status: unknown;
 *   jobs?: unknown;
 *   expected: { repository: string; workflowPath: string; channel: string; sourceSha?: string; operationId?: string; statusArtifactName?: string };
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
  const expectedOperationId = optionalOperationId(input.expected.operationId, 'expected operation ID');
  const statusOperationId = optionalOperationId(status.operationId, 'resume status operation ID');
  if (statusOperationId !== expectedOperationId) {
    throw new Error('[release] resume status operation does not match the current conductor operation');
  }
  const statusSourceSha = requiredSha(status.sourceSha, 'resume status source SHA');
  if (input.expected.sourceSha && statusSourceSha !== requiredSha(input.expected.sourceSha, 'expected source SHA')) {
    throw new Error('[release] resume status source SHA does not match the authorized source SHA');
  }
  const originRun = asRecord(input.originRun, 'origin run');
  const statusRun = asRecord(status.run, 'resume status run');
  const statusRunId = Number(statusRun.id);
  if (!Number.isSafeInteger(statusRunId) || statusRunId !== originRun.id) {
    throw new Error('[release] resume status run identity does not match the origin run');
  }
  if (statusRun.url !== originRun.html_url) {
    throw new Error('[release] resume status run URL does not match the origin run');
  }
  const statusRunName = requiredString(statusRun.name, 'resume status run name');
  if (expectedOperationId && !statusRunName.includes(expectedOperationId)) {
    throw new Error('[release] resume status run name does not bind the conductor operation');
  }
  if (!Array.isArray(status.surfaces)) throw new Error('[release] resume status surfaces must be an array');

  /** @type {Record<'cli' | 'stack' | 'server' | 'runner' | 'ui-web', string>} */
  const versions = { cli: '', stack: '', server: '', runner: '', 'ui-web': '' };
  /** @type {Record<'cli' | 'stack' | 'server' | 'runner' | 'ui-web', boolean>} */
  const requested = { cli: false, stack: false, server: false, runner: false, 'ui-web': false };
  const completed = {
    cliRolling: false, stackRolling: false, serverRolling: false, runnerRolling: false, uiWebRolling: false,
    deployUi: false, deployServer: false, deployWebsite: false, deployDocs: false, docker: false, npm: false,
  };
  const seenCompletionSurfaces = new Set();
  let completedNpmAccepted = false;
  let expandedNpmIntegrityRequested = false;
  let uiIntentRecorded = false;
  const resumeInputs = { deployUi: { deployWeb: false, expoAction: 'none', desktopMode: 'none' } };
  let desktopRequested = false;
  let uiExpoAction = '';
  let requestedUiSurfaces = 0;
  for (const [index, rawSurface] of status.surfaces.entries()) {
    const surface = asRecord(rawSurface, `resume status surface ${index}`);
    const surfaceId = String(surface.id ?? '');
    const completionKey = RESUMABLE_COMPLETION_SURFACES.get(surfaceId);
    const verifiedCompletionKey = RESUMABLE_VERIFIED_COMPLETION_SURFACES.get(surfaceId);
    if (completionKey || verifiedCompletionKey) {
      if (seenCompletionSurfaces.has(surfaceId)) throw new Error(`[release] duplicate resumable completion surface: ${surfaceId}`);
      requiredBoolean(surface.requested, `resumable completion surface ${surfaceId} requested`);
      seenCompletionSurfaces.add(surfaceId);
    }
    if (verifiedCompletionKey && surface.requested === true && surface.state === 'complete' && surface.result === 'success') {
      const identity = asRecord(surface.identity, `completed ${surfaceId} identity`);
      if (requiredSha(identity.sourceSha, `completed ${surfaceId} source SHA`) !== statusSourceSha) {
        throw new Error(`[release] completed ${surfaceId} source SHA does not match the release`);
      }
      if (identity.verified !== true) throw new Error(`[release] completed ${surfaceId} must carry verified identity evidence`);
      completed[/** @type {'cliRolling'|'stackRolling'|'serverRolling'|'runnerRolling'|'uiWebRolling'} */ (verifiedCompletionKey)] = true;
    }
    if (['npm_plugin_sdk', 'npm_plugin_ui', 'npm_sdk'].includes(surfaceId) && surface.requested === true) {
      expandedNpmIntegrityRequested = true;
    }
    if (completionKey && surface.requested === true && surface.state === 'published' && surface.result === 'accepted') {
      const identity = asRecord(surface.identity, `completed ${surfaceId} identity`);
      if (requiredSha(identity.sourceSha, `completed ${surfaceId} source SHA`) !== statusSourceSha) {
        throw new Error(`[release] completed ${surfaceId} source SHA does not match the release`);
      }
      if (identity.verified !== false) throw new Error(`[release] completed ${surfaceId} must carry accepted, non-verified identity evidence`);
      if (completionKey === 'npm') completedNpmAccepted = true;
      else completed[/** @type {'deployDocs'|'deployServer'|'deployUi'|'deployWebsite'|'docker'} */ (completionKey)] = true;
    }
    if (surface.id === 'deploy_ui' && surface.requested === true) {
      const identity = asRecord(surface.identity, 'requested deploy_ui identity');
      if (requiredSha(identity.sourceSha, 'requested deploy_ui source SHA') !== statusSourceSha) {
        throw new Error('[release] requested deploy_ui source SHA does not match the release');
      }
      desktopRequested = true;
      requestedUiSurfaces += 1;
      uiExpoAction = requestedUiSurfaces === 1 && ['none', 'ota', 'native', 'native_submit', 'full'].includes(String(identity.expoAction ?? ''))
        ? String(identity.expoAction) : '';
      // Historical statuses recorded only Expo action. They cannot restore web/desktop intent.
      if (Object.hasOwn(identity, 'deployWeb') || Object.hasOwn(identity, 'desktopMode')) {
        resumeInputs.deployUi = {
          deployWeb: requiredBoolean(identity.deployWeb, 'requested deploy_ui deployWeb'),
          expoAction: requiredChoice(identity.expoAction, 'requested deploy_ui expoAction', ['none', 'ota', 'native', 'native_submit', 'full']),
          desktopMode: requiredChoice(identity.desktopMode, 'requested deploy_ui desktopMode', ['none', 'build_only', 'build_and_publish']),
        };
        uiIntentRecorded = true;
      }
    }
    if (surface.id === 'ui_desktop' && input.expected.workflowPath === '.github/workflows/nightly-dev.yml') {
      const identity = asRecord(surface.identity, 'desktop candidate identity');
      if (identity.candidateOriginRunId !== undefined) {
        if (!Number.isSafeInteger(identity.candidateOriginRunId) || Number(identity.candidateOriginRunId) < 1) {
          throw new Error('[release] desktop candidate origin run ID must be a positive safe integer');
        }
        if (identity.candidateOriginRunId !== originRun.id) {
          throw new Error(`[release] resume the original desktop candidate run ${identity.candidateOriginRunId}; chained desktop recovery is not supported`);
        }
      }
    }
    const declaredProduct = RESUMABLE_SURFACE_PRODUCTS.get(String(surface.id ?? ''));
    if (declaredProduct && surface.requested === true) {
      requested[/** @type {'cli' | 'stack' | 'server' | 'runner' | 'ui-web'} */ (declaredProduct)] = true;
    }
    if (surface.state !== 'complete' || surface.result !== 'success') continue;
    if (!surface.identity || typeof surface.identity !== 'object' || Array.isArray(surface.identity)) continue;
    const identity = /** @type {Record<string, unknown>} */ (surface.identity);
    if (!Object.hasOwn(identity, 'product')) continue;
    const rawProduct = requiredString(identity.product, `resume status surface ${index} product`);
    const product = rawProduct === 'hstack' ? 'stack' : rawProduct;
    if (!RESUMABLE_PRODUCTS.has(product)) throw new Error(`[release] unsupported resumable product: ${rawProduct}`);
    if (identity.verified !== true) throw new Error(`[release] resumable ${product} candidate is not owner-verified`);
    if (requiredSha(identity.sourceSha, `resumable ${product} source SHA`) !== statusSourceSha) {
      throw new Error(`[release] resumable ${product} candidate source SHA does not match the release`);
    }
    const key = /** @type {'cli' | 'stack' | 'server' | 'runner' | 'ui-web'} */ (product);
    if (versions[key]) throw new Error(`[release] duplicate resumable ${product} candidate`);
    versions[key] = requiredString(identity.version, `resumable ${product} version`);
  }
  completed.npm = completedNpmAccepted && !expandedNpmIntegrityRequested;
  const validated = validateCandidateVersions({ channel: input.expected.channel, versions });
  if (!Object.values(validated.versions).some(Boolean)) {
    throw new Error('[release] resume origin contains no verified immutable candidates to reuse');
  }
  return { sourceSha: statusSourceSha, versions: validated.versions, requested, completed, uiExpoAction,
    ...(STANDARD_RELEASE_WORKFLOWS.has(input.expected.workflowPath)
      ? { requestedDeployUi: desktopRequested, uiIntentRecorded, resumeInputs } : {}),
    uiCompleted: resolveUiFlowCompletion(input.jobs, {
      runId: Number(originRun.id), workflowSha: inspected.workflowSha, sourceSha: statusSourceSha,
      expectedSourceSha: input.expected.sourceSha, operationId: expectedOperationId, workflowPath: input.expected.workflowPath,
      channel: input.expected.channel, statusArtifactName: inspected.statusArtifactName,
      requested: desktopRequested && requestedUiSurfaces === 1, expoAction: uiExpoAction,
    }),
    ...(input.expected.workflowPath === '.github/workflows/nightly-dev.yml' || desktopRequested
      ? { desktop: resolveDesktopArtifacts(input.artifacts, originRun, inspected.workflowSha, input.expected.channel,
        input.expected.workflowPath === '.github/workflows/nightly-dev.yml') } : {}),
  };
}

/** @param {string} path */
async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

/** @param {string} path @param {Record<string, string | number | boolean>} outputs */
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
      'artifact-id': { type: 'string' },
      'artifact-digest': { type: 'string' },
      'archive-path': { type: 'string' },
      'origin-run-json': { type: 'string' },
      'artifacts-json': { type: 'string' },
      'status-json': { type: 'string' },
      'jobs-json': { type: 'string' },
      'downloaded-digest': { type: 'string', default: '' },
      'expected-repository': { type: 'string' },
      'expected-workflow': { type: 'string' },
      'expected-channel': { type: 'string' },
      'expected-source-sha': { type: 'string', default: '' },
      'expected-operation-id': { type: 'string', default: '' },
      'status-artifact-name': { type: 'string', default: '' },
      'github-output': { type: 'string' },
    },
    allowPositionals: false,
  });
  if (String(values.mode ?? '') === 'download') {
    await downloadReleaseResumeArtifact({
      repository: String(values['expected-repository'] ?? ''),
      artifactId: Number(values['artifact-id']),
      digest: String(values['artifact-digest'] ?? ''),
      archivePath: String(values['archive-path'] ?? ''),
    });
    return;
  }
  const originRun = await readJson(String(values['origin-run-json'] ?? ''));
  const artifacts = await readJson(String(values['artifacts-json'] ?? ''));
  const expected = {
    repository: String(values['expected-repository'] ?? ''),
    workflowPath: String(values['expected-workflow'] ?? ''),
    channel: String(values['expected-channel'] ?? ''),
    sourceSha: String(values['expected-source-sha'] ?? ''),
    operationId: String(values['expected-operation-id'] ?? ''),
    statusArtifactName: String(values['status-artifact-name'] ?? ''),
  };
  const outputPath = String(values['github-output'] ?? '');
  if (!outputPath) throw new Error('[release] --github-output is required');

  if (values.mode === 'inspect') {
    const inspected = inspectReleaseResumeOrigin({ originRun, artifacts, expected });
    await writeOutputs(outputPath, {
      artifact_digest: inspected.artifactDigest,
      artifact_id: inspected.artifactId,
      workflow_sha: inspected.workflowSha,
    });
    return inspected;
  }
  if (values.mode === 'resolve') {
    const resolved = resolveReleaseResume({
      originRun,
      artifacts,
      downloadedDigest: String(values['downloaded-digest'] ?? ''),
      status: await readJson(String(values['status-json'] ?? '')),
      jobs: values['jobs-json'] ? await readJson(values['jobs-json']) : undefined,
      expected,
    });
    await writeOutputs(outputPath, {
      source_sha: resolved.sourceSha,
      ui_ota_complete: resolved.uiCompleted.ota,
      ui_native_ios_complete: resolved.uiCompleted.nativeIos,
      ui_native_android_complete: resolved.uiCompleted.nativeAndroid,
      ui_apk_complete: resolved.uiCompleted.apk,
      desktop_run_number: resolved.desktop?.runNumber ?? '',
      desktop_artifacts: JSON.stringify(resolved.desktop?.artifacts ?? {}),
      desktop_finalized_artifacts: JSON.stringify(resolved.desktop?.finalizedArtifacts ?? {}),
      cli_version: resolved.versions.cli,
      stack_version: resolved.versions.stack,
      server_version: resolved.versions.server,
      runner_version: resolved.versions.runner,
      ui_web_version: resolved.versions['ui-web'],
      cli_requested: String(resolved.requested.cli),
      stack_requested: String(resolved.requested.stack),
      server_requested: String(resolved.requested.server),
      runner_requested: String(resolved.requested.runner),
      ui_web_requested: String(resolved.requested['ui-web']),
      deploy_ui_requested: String(resolved.requestedDeployUi ?? false),
      deploy_docs_complete: String(resolved.completed.deployDocs),
      deploy_server_complete: String(resolved.completed.deployServer),
      deploy_ui_complete: String(resolved.completed.deployUi),
      deploy_website_complete: String(resolved.completed.deployWebsite),
      docker_complete: String(resolved.completed.docker),
      npm_complete: String(resolved.completed.npm),
      cli_rolling_complete: String(resolved.completed.cliRolling),
      stack_rolling_complete: String(resolved.completed.stackRolling),
      server_rolling_complete: String(resolved.completed.serverRolling),
      runner_rolling_complete: String(resolved.completed.runnerRolling),
      ui_web_rolling_complete: String(resolved.completed.uiWebRolling),
      deploy_ui_web_requested: String(resolved.resumeInputs?.deployUi.deployWeb ?? false),
      deploy_ui_intent_recorded: String(resolved.uiIntentRecorded ?? false),
      deploy_ui_expo_action: resolved.uiExpoAction,
      deploy_ui_desktop_mode: resolved.resumeInputs?.deployUi.desktopMode ?? 'none',
    });
    return resolved;
  }
  throw new Error('[release] --mode must be inspect, resolve, or download');
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
