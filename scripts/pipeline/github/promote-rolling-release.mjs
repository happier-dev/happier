// @ts-check

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, createReadStream, openSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  inspectImmutableReleaseCandidate,
  resolveImmutableCandidateIdentity,
} from '../release/lib/immutable-release-candidate.mjs';

const FULL_SHA = /^[a-f0-9]{40}$/;
const DEFAULT_UPLOAD_ATTEMPTS = 8;
const DEFAULT_UPLOAD_RETRY_DELAY_MS = 5_000;
const DEFAULT_UPLOAD_MAX_RETRY_DELAY_MS = 60_000;
const DEFAULT_MUTATION_CONFIRM_ATTEMPTS = 8;
const DEFAULT_MUTATION_CONFIRM_RETRY_DELAY_MS = 1_000;
const DEFAULT_MUTATION_CONFIRM_MAX_RETRY_DELAY_MS = 5_000;
const TRANSIENT_UPLOAD_CONNECTIVITY_EXHAUSTED_EXIT_CODE = 75;

class TransientUploadConnectivityExhaustedError extends Error {
  constructor(name, cause) {
    super(
      `GitHub asset upload connectivity retries exhausted for ${name}.\n${commandFailureOutput(cause)}`,
      { cause },
    );
    this.name = 'TransientUploadConnectivityExhaustedError';
  }
}

function fail(message) {
  throw new Error(message);
}

function readPositiveIntegerEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) fail(`${name} must be a positive integer.`);
  return value;
}

function readNonNegativeIntegerEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) fail(`${name} must be a non-negative integer.`);
  return value;
}

function parseBool(value, name) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  fail(`${name} must be true or false.`);
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ env?: Record<string, string>; dryRun?: boolean; allowNotFound?: boolean; cwd?: string }} [opts]
 */
function run(cmd, args, opts = {}) {
  const printable = `${cmd} ${args.map((arg) => (arg.includes(' ') ? JSON.stringify(arg) : arg)).join(' ')}`;
  if (opts.dryRun) {
    console.log(`[dry-run] ${printable}`);
    return '';
  }
  try {
    return execFileSync(cmd, args, {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, ...(opts.env ?? {}) },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10 * 60_000,
    });
  } catch (error) {
    if (opts.allowNotFound && isExplicitHttpNotFound(error)) return '';
    throw error;
  }
}

/** @param {unknown} error */
function isExplicitHttpNotFound(error) {
  if (!error || typeof error !== 'object') return false;
  const commandError = /** @type {{ stdout?: unknown; stderr?: unknown }} */ (error);
  const output = `${String(commandError.stdout ?? '')}\n${String(commandError.stderr ?? '')}`;
  return /\(HTTP 404\)(?:\s|$)/.test(output) || /HTTP\/\S+\s+404(?:\s|$)/.test(output);
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {string} destination
 * @param {{ env?: Record<string, string>; dryRun?: boolean; cwd?: string }} [opts]
 */
function runToFile(cmd, args, destination, opts = {}) {
  const printable = `${cmd} ${args.map((arg) => (arg.includes(' ') ? JSON.stringify(arg) : arg)).join(' ')}`;
  if (opts.dryRun) {
    console.log(`[dry-run] ${printable}`);
    return;
  }
  const output = openSync(destination, 'w');
  try {
    execFileSync(cmd, args, {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['ignore', output, 'pipe'],
      timeout: 10 * 60_000,
    });
  } finally {
    closeSync(output);
  }
}

function commandFailureOutput(error) {
  if (!error || typeof error !== 'object') return String(error ?? '');
  const commandError = /** @type {{ message?: unknown; stdout?: unknown; stderr?: unknown }} */ (error);
  return [commandError.message, commandError.stdout, commandError.stderr]
    .map((value) => Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? ''))
    .join('\n');
}

function sleepSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.trunc(ms));
}

async function fileSha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function assertDirectoriesEqual(leftDir, rightDir) {
  const leftNames = (await readdir(leftDir)).sort();
  const rightNames = (await readdir(rightDir)).sort();
  if (leftNames.length !== rightNames.length || leftNames.some((name, index) => name !== rightNames[index])) {
    fail('Rolling release asset names differ from the immutable release.');
  }
  for (const name of leftNames) {
    const [leftSha, rightSha] = await Promise.all([
      fileSha256(join(leftDir, name)),
      fileSha256(join(rightDir, name)),
    ]);
    if (leftSha !== rightSha) {
      fail(`Rolling release asset differs from immutable source bytes: ${name}`);
    }
  }
}

function readTagSha({ repo, tag, env, dryRun }) {
  return run('gh', ['api', `repos/${repo}/git/ref/tags/${tag}`, '--jq', '.object.sha'], {
    env,
    dryRun,
    allowNotFound: true,
  }).trim().toLowerCase();
}

function findDraftReleaseId({ repo, tag, env, dryRun }) {
  const jqTag = JSON.stringify(tag);
  return run('gh', [
    'api',
    `repos/${repo}/releases?per_page=100`,
    '--paginate',
    '--jq',
    `.[] | select(.draft == true and .tag_name == ${jqTag}) | .id`,
  ], {
    env,
    dryRun,
  }).trim().split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
}

function findDraftReleasesByTagPrefix({ repo, tagPrefix, env, dryRun }) {
  const jqPrefix = JSON.stringify(tagPrefix);
  const output = run('gh', [
    'api',
    `repos/${repo}/releases?per_page=100`,
    '--paginate',
    '--jq',
    `.[] | select(.draft == true and (.tag_name | startswith(${jqPrefix}))) | [.id, .tag_name] | @tsv`,
  ], {
    env,
    dryRun,
  }).trim();
  if (!output) return [];
  return output.split(/\r?\n/).map((line) => {
    const [id = '', tagName = '', ...extra] = line.split('\t');
    if (extra.length > 0 || !/^\d+$/.test(id) || !tagName.startsWith(tagPrefix)) {
      fail('GitHub returned invalid staging draft metadata.');
    }
    return { id, tagName };
  });
}

function parseRelease(raw, label) {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  try {
    const release = JSON.parse(value);
    return {
      id: String(release.id ?? '').trim(),
      tagName: String(release.tag_name ?? '').trim(),
      name: String(release.name ?? ''),
      body: String(release.body ?? ''),
      prerelease: release.prerelease === true,
      draft: release.draft === true,
    };
  } catch {
    fail(`GitHub returned invalid release metadata for ${label}.`);
  }
}

function readReleaseByTag({ repo, tag, env, dryRun }) {
  return parseRelease(run('gh', ['api', `repos/${repo}/releases/tags/${tag}`], {
    env,
    dryRun,
    allowNotFound: true,
  }), tag);
}

function readReleaseById({ repo, releaseId, env, dryRun }) {
  return parseRelease(run('gh', ['api', `repos/${repo}/releases/${releaseId}`], {
    env,
    dryRun,
    allowNotFound: true,
  }), `release ${releaseId}`);
}

function sanitizeTagSegment(value) {
  const sanitized = String(value ?? '').trim().replace(/[^0-9A-Za-z._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!sanitized) fail('Unable to derive a safe rolling release staging tag.');
  return sanitized;
}

function backupReleaseName(name, backupTag) {
  return `[backup:${backupTag}] ${name}`;
}

function originalReleaseName(name, backupTag) {
  const prefix = `[backup:${backupTag}] `;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

function readReleaseAssetRows({ repo, releaseId, env, dryRun }) {
  const raw = run('gh', [
    'api', `repos/${repo}/releases/${releaseId}`,
    '--jq', '.assets[] | [.id, .name] | @tsv',
  ], { env, dryRun }).trim();
  return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const separator = line.indexOf('\t');
    if (separator <= 0) fail(`Invalid release asset row: ${line}`);
    const id = line.slice(0, separator);
    const name = line.slice(separator + 1);
    if (!/^[A-Za-z0-9._-]+$/u.test(id) || !name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
      fail(`Invalid release asset row: ${line}`);
    }
    return { id, name };
  });
}

function assetRowsEqual(left, right) {
  return left.length === right.length
    && left.every((entry, index) => entry.id === right[index]?.id && entry.name === right[index]?.name);
}

function readReleaseSnapshotByTag({ repo, tag, env, dryRun }) {
  const release = readReleaseByTag({ repo, tag, env, dryRun });
  if (!release) return null;
  return { release, assets: readReleaseAssetRows({ repo, releaseId: release.id, env, dryRun }) };
}

function readReleaseSnapshotById({ repo, releaseId, env, dryRun }) {
  const release = readReleaseById({ repo, releaseId, env, dryRun });
  if (!release) return null;
  return { release, assets: readReleaseAssetRows({ repo, releaseId, env, dryRun }) };
}

function assertReleaseSnapshotCurrent({ repo, snapshot, expectedTag, expectedDraft, env }) {
  const current = readReleaseSnapshotById({ repo, releaseId: snapshot.release.id, env, dryRun: false });
  if (!current
    || current.release.tagName !== expectedTag
    || current.release.draft !== expectedDraft
    || !assetRowsEqual(current.assets, snapshot.assets)) {
    fail(`GitHub release ${snapshot.release.id} changed while its assets were being audited.`);
  }
  return current;
}

function uploadReleaseAssetWithRetry({
  repo,
  releaseId,
  name,
  sourcePath,
  env,
  attempts = readPositiveIntegerEnv('HAPPIER_PIPELINE_GH_ROLLING_UPLOAD_ATTEMPTS', DEFAULT_UPLOAD_ATTEMPTS),
  retryDelayMs = readNonNegativeIntegerEnv(
    'HAPPIER_PIPELINE_GH_ROLLING_UPLOAD_RETRY_DELAY_MS',
    DEFAULT_UPLOAD_RETRY_DELAY_MS,
  ),
  maxRetryDelayMs = readNonNegativeIntegerEnv(
    'HAPPIER_PIPELINE_GH_ROLLING_UPLOAD_MAX_RETRY_DELAY_MS',
    DEFAULT_UPLOAD_MAX_RETRY_DELAY_MS,
  ),
  sleep = sleepSync,
}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let uploadError = null;
    try {
      run('gh', [
        'api', '-X', 'POST',
        `https://uploads.github.com/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
        '-H', 'Content-Type: application/octet-stream',
        '--input', sourcePath,
        '--silent',
      ], { env });
    } catch (error) {
      uploadError = error;
    }
    const uploaded = readReleaseAssetRows({ repo, releaseId, env, dryRun: false })
      .some((entry) => entry.name === name);
    if (uploaded) return;
    if (!uploadError) {
      fail(`GitHub did not upload staging asset ${name}.`);
    }
    const transientConnectionFailure = /error connecting to (?:api\.)?uploads\.github\.com/iu.test(
      commandFailureOutput(uploadError),
    );
    if (!transientConnectionFailure) {
      throw uploadError;
    }
    if (attempt >= attempts) {
      throw new TransientUploadConnectivityExhaustedError(name, uploadError);
    }
    const nextAttempt = attempt + 1;
    const delayMs = Math.min(retryDelayMs * (2 ** (attempt - 1)), maxRetryDelayMs);
    console.warn(
      `[pipeline] GitHub asset upload connection failed; retrying ${name} `
      + `(${nextAttempt}/${attempts})`,
    );
    sleep(delayMs);
  }
  fail(`GitHub asset upload retry loop exhausted unexpectedly for ${name}.`);
}

function runMutationAndConfirm({ args, env, dryRun, confirm, failureMessage }) {
  if (dryRun) {
    run('gh', args, { env, dryRun: true });
    return;
  }
  let mutationError = null;
  try {
    run('gh', args, { env });
  } catch (error) {
    mutationError = error;
  }
  if (confirm()) return;
  if (mutationError) throw mutationError;
  const attempts = readPositiveIntegerEnv(
    'HAPPIER_PIPELINE_GH_MUTATION_CONFIRM_ATTEMPTS',
    DEFAULT_MUTATION_CONFIRM_ATTEMPTS,
  );
  const retryDelayMs = readNonNegativeIntegerEnv(
    'HAPPIER_PIPELINE_GH_MUTATION_CONFIRM_RETRY_DELAY_MS',
    DEFAULT_MUTATION_CONFIRM_RETRY_DELAY_MS,
  );
  const maxRetryDelayMs = readNonNegativeIntegerEnv(
    'HAPPIER_PIPELINE_GH_MUTATION_CONFIRM_MAX_RETRY_DELAY_MS',
    DEFAULT_MUTATION_CONFIRM_MAX_RETRY_DELAY_MS,
  );
  for (let attempt = 2; attempt <= attempts; attempt += 1) {
    const delayMs = Math.min(retryDelayMs * (2 ** (attempt - 2)), maxRetryDelayMs);
    console.warn(`[pipeline] GitHub mutation is not visible yet; retrying confirmation (${attempt}/${attempts})`);
    sleepSync(delayMs);
    if (confirm()) return;
  }
  fail(failureMessage);
}

function ensureRefAtSha({ repo, tag, sha, env, dryRun }) {
  const current = readTagSha({ repo, tag, env, dryRun });
  if (!dryRun && current === sha) return;
  const args = current
    ? ['api', '-X', 'PATCH', `repos/${repo}/git/refs/tags/${tag}`, '-f', `sha=${sha}`, '-F', 'force=true']
    : ['api', '-X', 'POST', `repos/${repo}/git/refs`, '-f', `ref=refs/tags/${tag}`, '-f', `sha=${sha}`];
  runMutationAndConfirm({
    args,
    env,
    dryRun,
    confirm: () => readTagSha({ repo, tag, env, dryRun: false }) === sha,
    failureMessage: `GitHub did not move tag ${tag} to ${sha}.`,
  });
}

function deleteRefIfPresent({ repo, tag, env, dryRun }) {
  const current = readTagSha({ repo, tag, env, dryRun });
  if (!current && !dryRun) return;
  runMutationAndConfirm({
    args: ['api', '-X', 'DELETE', `repos/${repo}/git/refs/tags/${tag}`],
    env,
    dryRun,
    confirm: () => !readTagSha({ repo, tag, env, dryRun: false }),
    failureMessage: `GitHub did not delete temporary tag ${tag}.`,
  });
}

function patchReleaseAndConfirm({ repo, releaseId, fields, env, dryRun, confirm, failureMessage }) {
  const args = ['api', '-X', 'PATCH', `repos/${repo}/releases/${releaseId}`];
  for (const [name, value] of Object.entries(fields)) {
    args.push(typeof value === 'boolean' ? '-F' : '-f', `${name}=${value}`);
  }
  runMutationAndConfirm({ args, env, dryRun, confirm, failureMessage });
}

function deleteReleaseIfPresent({ repo, releaseId, env, dryRun }) {
  if (!releaseId) return;
  runMutationAndConfirm({
    args: ['api', '-X', 'DELETE', `repos/${repo}/releases/${releaseId}`],
    env,
    dryRun,
    confirm: () => !readReleaseById({ repo, releaseId, env, dryRun: false }),
    failureMessage: `GitHub did not delete backup release ${releaseId}.`,
  });
}

async function downloadReleaseAssetsById({ repo, assets, destination, env, dryRun }) {
  for (const { id: assetId, name } of assets) {
    runToFile('gh', [
      'api',
      `repos/${repo}/releases/assets/${assetId}`,
      '-H',
      'Accept: application/octet-stream',
    ], join(destination, name), { env, dryRun });
  }
}

async function inspectAndVerifyCandidate({ directory, sourceTag, expectedProduct, expectedVersion, publicKey }) {
  const inspected = await inspectImmutableReleaseCandidate({
    directory,
    sourceTag,
    expectedProduct,
    expectedVersion,
  });
  run(process.execPath, [
    'scripts/pipeline/release/verify-artifacts.mjs',
    '--artifacts-dir', directory,
    '--checksums', join(directory, inspected.checksumsName),
    '--public-key', publicKey,
    '--skip-smoke',
  ]);
  return inspected;
}

async function auditReleaseById({
  repo,
  releaseId,
  expectedTag,
  expectedDraft,
  expectedDir,
  sourceTag,
  expectedProduct,
  expectedVersion,
  publicKey,
  env,
}) {
  const destination = await mkdtemp(join(tmpdir(), 'happier-visible-release-audit-'));
  try {
    const snapshot = readReleaseSnapshotById({ repo, releaseId, env, dryRun: false });
    if (!snapshot || snapshot.release.tagName !== expectedTag || snapshot.release.draft !== expectedDraft) {
      fail(`GitHub release ${releaseId} no longer identifies ${expectedTag}.`);
    }
    await downloadReleaseAssetsById({ repo, assets: snapshot.assets, destination, env, dryRun: false });
    assertReleaseSnapshotCurrent({ repo, snapshot, expectedTag, expectedDraft, env });
    await inspectAndVerifyCandidate({
      directory: destination,
      sourceTag,
      expectedProduct,
      expectedVersion,
      publicKey,
    });
    await assertDirectoriesEqual(expectedDir, destination);
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      'source-tag': { type: 'string' },
      'expected-product': { type: 'string', default: '' },
      'expected-version': { type: 'string', default: '' },
      'rolling-tag': { type: 'string' },
      title: { type: 'string' },
      'target-sha': { type: 'string' },
      prerelease: { type: 'string' },
      notes: { type: 'string', default: '' },
      'release-message': { type: 'string', default: '' },
      repo: { type: 'string', default: '' },
      'public-key': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  const sourceTag = String(values['source-tag'] ?? '').trim();
  const expectedProduct = String(values['expected-product'] ?? '').trim();
  const expectedVersion = String(values['expected-version'] ?? '').trim();
  const rollingTag = String(values['rolling-tag'] ?? '').trim();
  const title = String(values.title ?? '').trim();
  const targetSha = String(values['target-sha'] ?? '').trim().toLowerCase();
  const repo = String(values.repo ?? '').trim()
    || String(process.env.GH_REPO ?? '').trim()
    || String(process.env.GITHUB_REPOSITORY ?? '').trim();
  const publicKey = resolve(String(values['public-key'] ?? '').trim());
  const prerelease = parseBool(values.prerelease, '--prerelease');
  const notes = String(values.notes ?? '').trim();
  const releaseMessage = String(values['release-message'] ?? '').trim();
  const dryRun = values['dry-run'] === true;
  if (!sourceTag) fail('--source-tag is required');
  if (Boolean(expectedProduct) !== Boolean(expectedVersion)) {
    fail('--expected-product and --expected-version must be supplied together');
  }
  if (expectedProduct) {
    const expectedIdentity = resolveImmutableCandidateIdentity({ product: expectedProduct, version: expectedVersion });
    if (expectedIdentity.sourceTag !== sourceTag) {
      fail(`Immutable source tag ${sourceTag} does not identify expected ${expectedProduct} ${expectedVersion}.`);
    }
  }
  if (!rollingTag) fail('--rolling-tag is required');
  if (!title) fail('--title is required');
  if (!FULL_SHA.test(targetSha)) fail('--target-sha must be a full 40-character commit id');
  if (!repo) fail('--repo or GH_REPO/GITHUB_REPOSITORY is required');
  if (!String(values['public-key'] ?? '').trim()) fail('--public-key is required');

  const ghEnv = {
    GH_REPO: repo,
    ...(String(process.env.GH_TOKEN ?? '').trim() ? { GH_TOKEN: String(process.env.GH_TOKEN) } : {}),
  };
  const sourceDir = await mkdtemp(join(tmpdir(), 'happier-immutable-release-'));
  const auditDir = await mkdtemp(join(tmpdir(), 'happier-rolling-release-audit-'));
  try {
    const immutableSha = readTagSha({ repo, tag: sourceTag, env: ghEnv, dryRun });
    if (!dryRun && immutableSha !== targetSha) {
      fail(`Immutable source tag ${sourceTag} does not resolve to authorized SHA ${targetSha}.`);
    }
    if (!dryRun) {
      const immutableSnapshot = readReleaseSnapshotByTag({ repo, tag: sourceTag, env: ghEnv, dryRun: false });
      if (!immutableSnapshot
        || immutableSnapshot.release.tagName !== sourceTag
        || immutableSnapshot.release.draft !== false
        || immutableSnapshot.assets.length === 0) {
        fail(`Immutable source release ${sourceTag} is missing, draft, or has no assets.`);
      }
      await downloadReleaseAssetsById({
        repo,
        assets: immutableSnapshot.assets,
        destination: sourceDir,
        env: ghEnv,
        dryRun: false,
      });
      assertReleaseSnapshotCurrent({
        repo,
        snapshot: immutableSnapshot,
        expectedTag: sourceTag,
        expectedDraft: false,
        env: ghEnv,
      });
      if (readTagSha({ repo, tag: sourceTag, env: ghEnv, dryRun: false }) !== targetSha) {
        fail(`Immutable source tag ${sourceTag} changed while release ${immutableSnapshot.release.id} was audited.`);
      }
      await inspectAndVerifyCandidate({
        directory: sourceDir,
        sourceTag,
        expectedProduct,
        expectedVersion,
        publicKey,
      });
    } else {
      console.log(`[dry-run] download immutable assets for ${sourceTag} by observed release and asset IDs`);
    }

    const body = releaseMessage && notes ? `${releaseMessage}\n\n${notes}` : releaseMessage || notes;
    const safeRollingTag = sanitizeTagSegment(rollingTag);
    const stagingTag = `happier-rolling-staging-${safeRollingTag}-${targetSha}`;
    const backupTag = `happier-rolling-backup-${safeRollingTag}`;
    const stagingName = `[staging:${rollingTag}] ${title}`;

    if (!dryRun) {
      const stagingPrefix = `happier-rolling-staging-${safeRollingTag}-`;
      for (const staleDraft of findDraftReleasesByTagPrefix({
        repo,
        tagPrefix: stagingPrefix,
        env: ghEnv,
        dryRun: false,
      })) {
        if (staleDraft.tagName === stagingTag) continue;
        deleteReleaseIfPresent({ repo, releaseId: staleDraft.id, env: ghEnv, dryRun: false });
        deleteRefIfPresent({ repo, tag: staleDraft.tagName, env: ghEnv, dryRun: false });
      }
    }

    let rollingRelease = readReleaseByTag({ repo, tag: rollingTag, env: ghEnv, dryRun });
    let rollingSha = readTagSha({ repo, tag: rollingTag, env: ghEnv, dryRun });
    let backupRelease = readReleaseByTag({ repo, tag: backupTag, env: ghEnv, dryRun });

    if (!dryRun && !rollingRelease && backupRelease) {
      const backupSha = readTagSha({ repo, tag: backupTag, env: ghEnv, dryRun: false });
      if (!backupSha) fail(`Interrupted rolling promotion backup ${backupTag} has no tag ref.`);
      ensureRefAtSha({ repo, tag: rollingTag, sha: backupSha, env: ghEnv, dryRun: false });
      const restoredName = originalReleaseName(backupRelease.name, backupTag);
      patchReleaseAndConfirm({
        repo,
        releaseId: backupRelease.id,
        fields: { tag_name: rollingTag, name: restoredName },
        env: ghEnv,
        dryRun: false,
        confirm: () => readReleaseByTag({ repo, tag: rollingTag, env: ghEnv, dryRun: false })?.id === backupRelease.id,
        failureMessage: `Failed to restore interrupted predecessor release ${backupRelease.id}.`,
      });
      deleteRefIfPresent({ repo, tag: backupTag, env: ghEnv, dryRun: false });
      rollingRelease = readReleaseByTag({ repo, tag: rollingTag, env: ghEnv, dryRun: false });
      rollingSha = backupSha;
      backupRelease = null;
    }

    if (!dryRun && rollingRelease && rollingSha === targetSha) {
      let alreadyExact = false;
      try {
        await auditReleaseById({
          repo,
          releaseId: rollingRelease.id,
          expectedTag: rollingTag,
          expectedDraft: false,
          expectedDir: sourceDir,
          sourceTag,
          expectedProduct,
          expectedVersion,
          publicKey,
          env: ghEnv,
        });
        alreadyExact = true;
      } catch {
        // The ref alone is not admission; replace a stale or incomplete release object below.
      }
      if (alreadyExact) {
        if (backupRelease) deleteReleaseIfPresent({ repo, releaseId: backupRelease.id, env: ghEnv, dryRun: false });
        const staleDraftId = findDraftReleaseId({ repo, tag: stagingTag, env: ghEnv, dryRun: false });
        if (staleDraftId) deleteReleaseIfPresent({ repo, releaseId: staleDraftId, env: ghEnv, dryRun: false });
        deleteRefIfPresent({ repo, tag: backupTag, env: ghEnv, dryRun: false });
        deleteRefIfPresent({ repo, tag: stagingTag, env: ghEnv, dryRun: false });
        console.log(`[pipeline] rolling release ${rollingTag} already exposes exact immutable release ${sourceTag}.`);
        return;
      }
    }
    if (!dryRun && rollingRelease && backupRelease) {
      fail(`Both rolling release ${rollingTag} and backup release ${backupTag} exist; refusing ambiguous recovery.`);
    }

    ensureRefAtSha({ repo, tag: stagingTag, sha: targetSha, env: ghEnv, dryRun });
    let draftReleaseId = findDraftReleaseId({ repo, tag: stagingTag, env: ghEnv, dryRun });
    if (!draftReleaseId && !dryRun) {
      let createError = null;
      let createOutput = '';
      try {
        createOutput = run('gh', [
          'api', '-X', 'POST', `repos/${repo}/releases`,
          '-f', `tag_name=${stagingTag}`,
          '-f', `target_commitish=${targetSha}`,
          '-f', `name=${stagingName}`,
          '-f', 'body=',
          '-F', 'draft=true',
          '-F', `prerelease=${prerelease}`,
        ], { env: ghEnv });
      } catch (error) {
        createError = error;
      }
      if (createOutput.trim()) {
        const createdDraft = parseRelease(createOutput, `new staging release ${stagingTag}`);
        if (!createdDraft?.id || createdDraft.tagName !== stagingTag || createdDraft.draft !== true) {
          fail(`GitHub returned an invalid staging draft release for ${stagingTag}.`);
        }
        draftReleaseId = createdDraft.id;
      }
      if (!draftReleaseId) {
        draftReleaseId = findDraftReleaseId({ repo, tag: stagingTag, env: ghEnv, dryRun: false });
      }
      if (!draftReleaseId) {
        if (createError) throw createError;
        fail(`GitHub did not create staging draft release ${stagingTag}.`);
      }
    }
    if (dryRun) draftReleaseId = '<staging-release-id>';

    for (const asset of readReleaseAssetRows({ repo, releaseId: draftReleaseId, env: ghEnv, dryRun })) {
      runMutationAndConfirm({
        args: ['api', '-X', 'DELETE', `repos/${repo}/releases/assets/${asset.id}`],
        env: ghEnv,
        dryRun,
        confirm: () => !readReleaseAssetRows({ repo, releaseId: draftReleaseId, env: ghEnv, dryRun: false })
          .some((entry) => entry.id === asset.id),
        failureMessage: `GitHub did not delete stale staging asset ${asset.name}.`,
      });
    }

    if (!dryRun) {
      const { assetNames, checksumsName, signatureName } = await inspectImmutableReleaseCandidate({
        directory: sourceDir,
        sourceTag,
        expectedProduct,
        expectedVersion,
      });
      const names = [...assetNames, checksumsName, signatureName].sort();
      for (const name of names) {
        uploadReleaseAssetWithRetry({
          repo,
          releaseId: draftReleaseId,
          name,
          sourcePath: join(sourceDir, name),
          env: ghEnv,
        });
      }
    } else {
      console.log(`[dry-run] upload every verified asset from ${sourceTag} to staging release ${stagingTag}`);
    }

    const draftSnapshot = dryRun
      ? null
      : readReleaseSnapshotById({ repo, releaseId: draftReleaseId, env: ghEnv, dryRun: false });
    if (!dryRun && (!draftSnapshot || draftSnapshot.release.tagName !== stagingTag || draftSnapshot.release.draft !== true)) {
      fail(`Staging release ${draftReleaseId} changed before its asset audit.`);
    }
    await downloadReleaseAssetsById({
      repo,
      assets: draftSnapshot?.assets ?? [],
      destination: auditDir,
      env: ghEnv,
      dryRun,
    });
    if (!dryRun) {
      assertReleaseSnapshotCurrent({
        repo,
        snapshot: draftSnapshot,
        expectedTag: stagingTag,
        expectedDraft: true,
        env: ghEnv,
      });
      await inspectAndVerifyCandidate({
        directory: auditDir,
        sourceTag,
        expectedProduct,
        expectedVersion,
        publicKey,
      });
      await assertDirectoriesEqual(sourceDir, auditDir);
    }

    const predecessor = rollingRelease;
    const predecessorSha = rollingSha;
    const predecessorName = predecessor?.name ?? '';
    let predecessorRenamed = false;
    try {
      if (predecessor) {
        if (!predecessorSha) fail(`Published rolling release ${rollingTag} has no tag ref.`);
        const predecessorById = readReleaseById({ repo, releaseId: predecessor.id, env: ghEnv, dryRun });
        const predecessorByTag = readReleaseByTag({ repo, tag: rollingTag, env: ghEnv, dryRun });
        const currentPredecessorSha = readTagSha({ repo, tag: rollingTag, env: ghEnv, dryRun });
        if (!dryRun && (
          predecessorById?.tagName !== rollingTag
          || predecessorByTag?.id !== predecessor.id
          || currentPredecessorSha !== predecessorSha
        )) {
          fail(`Published rolling release ${rollingTag} changed before replacement.`);
        }
        ensureRefAtSha({ repo, tag: backupTag, sha: predecessorSha, env: ghEnv, dryRun });
        patchReleaseAndConfirm({
          repo,
          releaseId: predecessor.id,
          fields: { tag_name: backupTag, name: backupReleaseName(predecessorName, backupTag) },
          env: ghEnv,
          dryRun,
          confirm: () => readReleaseById({ repo, releaseId: predecessor.id, env: ghEnv, dryRun: false })?.tagName === backupTag,
          failureMessage: `GitHub did not preserve predecessor release ${predecessor.id} under ${backupTag}.`,
        });
        predecessorRenamed = true;
      }

      ensureRefAtSha({ repo, tag: rollingTag, sha: targetSha, env: ghEnv, dryRun });
      patchReleaseAndConfirm({
        repo,
        releaseId: draftReleaseId,
        fields: {
          tag_name: rollingTag,
          target_commitish: targetSha,
          name: title,
          body,
          draft: false,
          prerelease,
        },
        env: ghEnv,
        dryRun,
        confirm: () => {
          const byId = readReleaseById({ repo, releaseId: draftReleaseId, env: ghEnv, dryRun: false });
          const byTag = readReleaseByTag({ repo, tag: rollingTag, env: ghEnv, dryRun: false });
          return byId?.tagName === rollingTag && byId.draft === false && byTag?.id === draftReleaseId;
        },
        failureMessage: `GitHub did not publish audited replacement release ${draftReleaseId} as ${rollingTag}.`,
      });
      if (!dryRun && readTagSha({ repo, tag: rollingTag, env: ghEnv, dryRun: false }) !== targetSha) {
        fail(`Published rolling tag ${rollingTag} did not resolve to audited target ${targetSha}.`);
      }
      if (!dryRun) {
        await auditReleaseById({
          repo,
          releaseId: draftReleaseId,
          expectedTag: rollingTag,
          expectedDraft: false,
          expectedDir: sourceDir,
          sourceTag,
          expectedProduct,
          expectedVersion,
          publicKey,
          env: ghEnv,
        });
      }
    } catch (switchError) {
      if (!dryRun) {
        const restoreErrors = [];
        const replacement = readReleaseById({ repo, releaseId: draftReleaseId, env: ghEnv, dryRun: false });
        if (replacement?.tagName === rollingTag) {
          try {
            patchReleaseAndConfirm({
              repo,
              releaseId: draftReleaseId,
              fields: { tag_name: stagingTag, name: stagingName, body: '', draft: true, prerelease },
              env: ghEnv,
              dryRun: false,
              confirm: () => readReleaseById({ repo, releaseId: draftReleaseId, env: ghEnv, dryRun: false })?.tagName === stagingTag,
              failureMessage: `Failed to return replacement release ${draftReleaseId} to staging.`,
            });
          } catch (error) {
            restoreErrors.push(error);
          }
        }
        try {
          if (predecessorSha) ensureRefAtSha({ repo, tag: rollingTag, sha: predecessorSha, env: ghEnv, dryRun: false });
          else deleteRefIfPresent({ repo, tag: rollingTag, env: ghEnv, dryRun: false });
        } catch (error) {
          restoreErrors.push(error);
        }
        if (predecessor && predecessorRenamed) {
          try {
            patchReleaseAndConfirm({
              repo,
              releaseId: predecessor.id,
              fields: { tag_name: rollingTag, name: predecessorName },
              env: ghEnv,
              dryRun: false,
              confirm: () => readReleaseByTag({ repo, tag: rollingTag, env: ghEnv, dryRun: false })?.id === predecessor.id,
              failureMessage: `Failed to restore predecessor release ${predecessor.id}.`,
            });
          } catch (error) {
            restoreErrors.push(error);
          }
        }
        if (restoreErrors.length > 0) {
          fail(`Rolling replacement failed and predecessor restoration was incomplete: ${restoreErrors.map(String).join('; ')}`);
        }
      }
      throw switchError;
    }

    if (predecessor) deleteReleaseIfPresent({ repo, releaseId: predecessor.id, env: ghEnv, dryRun });
    deleteRefIfPresent({ repo, tag: backupTag, env: ghEnv, dryRun });
    deleteRefIfPresent({ repo, tag: stagingTag, env: ghEnv, dryRun });
    console.log(`[pipeline] promoted immutable release ${sourceTag} to ${rollingTag} after exact remote audit.`);
  } finally {
    await Promise.all([
      rm(sourceDir, { recursive: true, force: true }),
      rm(auditDir, { recursive: true, force: true }),
    ]);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(
    error instanceof TransientUploadConnectivityExhaustedError
      ? TRANSIENT_UPLOAD_CONNECTIVITY_EXHAUSTED_EXIT_CODE
      : 1,
  );
});
