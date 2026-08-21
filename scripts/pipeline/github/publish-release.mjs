// @ts-check

import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildRollingReleaseEditArgs } from './lib/gh-release-commands.mjs';

const DEFAULT_RELEASE_UPLOAD_RETRIES = 3;
const DEFAULT_RELEASE_UPLOAD_RETRY_DELAY_MS = 2_000;
const DEFAULT_RELEASE_TRANSFER_TIMEOUT_MS = 10 * 60_000;

function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * @param {string} remoteUrl
 * @returns {string}
 */
function inferRepoFromRemoteUrl(remoteUrl) {
  const raw = String(remoteUrl ?? '').trim();
  if (!raw) return '';

  if (raw.startsWith('https://github.com/')) {
    const suffix = raw.slice('https://github.com/'.length).replace(/\.git$/, '');
    const [owner, repo] = suffix.split('/').filter(Boolean);
    return owner && repo ? `${owner}/${repo}` : '';
  }

  if (raw.startsWith('git@github.com:')) {
    const suffix = raw.slice('git@github.com:'.length).replace(/\.git$/, '');
    const [owner, repo] = suffix.split('/').filter(Boolean);
    return owner && repo ? `${owner}/${repo}` : '';
  }

  return '';
}

/**
 * @returns {string}
 */
function inferRepoFromGitOrigin() {
  try {
    const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
      env: process.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
    }).trim();
    return inferRepoFromRemoteUrl(remoteUrl);
  } catch {
    return '';
  }
}

/**
 * @param {unknown} value
 * @param {string} name
 */
function parseBool(value, name) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  fail(`${name} must be 'true' or 'false' (got: ${value})`);
}

/**
 * @param {string} name
 * @param {number} defaultValue
 * @returns {number}
 */
function readPositiveIntegerEnv(name, defaultValue) {
  const raw = String(process.env[name] ?? '').trim();
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    fail(`${name} must be a positive integer (got: ${raw || '<empty>'})`);
  }
  return parsed;
}

/**
 * @param {number} ms
 */
function sleepSync(ms) {
  const buf = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buf), 0, 0, ms);
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatExecError(err) {
  if (err instanceof Error) {
    const stderr = 'stderr' in err ? String(err.stderr ?? '') : '';
    const stdout = 'stdout' in err ? String(err.stdout ?? '') : '';
    return `${stderr}\n${stdout}\n${err.message}`;
  }
  return String(err);
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isTransientReleaseTransferError(err) {
  const raw = formatExecError(err);
  return (
    /release not found/i.test(raw)
    || /404/i.test(raw)
    || /ETIMEDOUT/i.test(raw)
    || /ECONNRESET/i.test(raw)
    || /connection reset by peer/i.test(raw)
    || /socket hang up/i.test(raw)
    || /Service Unavailable/i.test(raw)
    || /\b50[234]\b/.test(raw)
  );
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ env?: Record<string, string>; dryRun?: boolean; allowFailure?: boolean; timeoutMs?: number }} [opts]
 */
function run(cmd, args, opts) {
  const dryRun = opts?.dryRun === true;
  const printable = `${cmd} ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`;
  if (dryRun) {
    console.log(`[dry-run] ${printable}`);
    return '';
  }

  try {
    return execFileSync(cmd, args, {
      env: { ...process.env, ...(opts?.env ?? {}) },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts?.timeoutMs ?? 120_000,
    });
  } catch (err) {
    if (opts?.allowFailure) return '';
    throw err;
  }
}

/**
 * @param {string} filePath
 * @returns {string[]}
 */
function listFilesRecursively(filePath) {
  /** @type {string[]} */
  const out = [];
  const stat = fs.statSync(filePath);
  if (stat.isFile()) return [filePath];
  if (!stat.isDirectory()) return [];

  /** @type {string[]} */
  const queue = [filePath];
  while (queue.length > 0) {
    const dir = /** @type {string} */ (queue.pop());
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  return out;
}

async function fileSha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function assertRemoteAssetMatches({ tag, repo, name, expectedPath, env, timeoutMs, retries, retryDelayMs }) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-immutable-release-audit-'));
  try {
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        run('gh', [
          'release', 'download', tag,
          '--repo', repo,
          '--pattern', name,
          '--dir', scratch,
          '--clobber',
        ], { env, timeoutMs });
        break;
      } catch (err) {
        if (isTransientReleaseTransferError(err) && attempt < retries) {
          sleepSync(retryDelayMs);
          continue;
        }
        throw err;
      }
    }
    const downloadedPath = path.join(scratch, name);
    if (!fs.existsSync(downloadedPath)) {
      fail(`Immutable release audit did not download expected asset: ${name}`);
    }
    const [expectedSha, downloadedSha] = await Promise.all([
      fileSha256(expectedPath),
      fileSha256(downloadedPath),
    ]);
    if (expectedSha !== downloadedSha) {
      fail(`Immutable release asset differs from the authorized bytes: ${name}`);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Resolve the current tag ref target SHA via the GitHub API.
 * Returns empty string when the ref is missing or cannot be read.
 *
 * @param {{ repo: string; tag: string; env: Record<string, string>; dryRun: boolean }} params
 */
function readTagShaViaGithubApi(params) {
  const repo = String(params.repo ?? '').trim();
  const tag = String(params.tag ?? '').trim();
  if (!repo || !tag) return '';
  return run('gh', ['api', `repos/${repo}/git/ref/tags/${tag}`, '--jq', '.object.sha'], {
    env: params.env,
    dryRun: params.dryRun,
    allowFailure: true,
  }).trim();
}

/**
 * @param {{ oldSha: string; sha: string; repo: string; dryRun: boolean; maxCommits: number; tag: string }} params
 * @returns {{ compareUrl: string; commitCount: string; commits: string }}
 */
function collectRollingCompareSummary(params) {
  const oldSha = String(params.oldSha ?? '').trim();
  const sha = String(params.sha ?? '').trim();
  if (!oldSha || !sha || oldSha === sha) {
    return { compareUrl: '', commitCount: '', commits: '' };
  }

  const compareRange = `${oldSha}..${sha}`;
  try {
    const commitCount = run('git', ['rev-list', '--count', compareRange], { dryRun: params.dryRun }).trim();
    const commits = run('git', ['log', `--max-count=${params.maxCommits}`, "--pretty=format:- %h %s", compareRange], {
      dryRun: params.dryRun,
    }).trim();
    return {
      compareUrl: `https://github.com/${params.repo}/compare/${oldSha}...${sha}`,
      commitCount,
      commits,
    };
  } catch (err) {
    const detail = formatExecError(err).trim().split('\n')[0] || 'unknown git error';
    console.log(`::warning::Skipping rolling compare summary for ${params.tag}: ${detail}`);
    return { compareUrl: '', commitCount: '', commits: '' };
  }
}

/**
 * Best-effort update for a rolling tag (force) using the GitHub API.
 * This avoids relying on `git push` auth being wired to GH_TOKEN in CI.
 *
 * @param {{ repo: string; tag: string; sha: string; env: Record<string, string>; dryRun: boolean; oldShaHint?: string }} params
 */
function updateRollingTagViaGithubApi(params) {
  const repo = String(params.repo ?? '').trim();
  const tag = String(params.tag ?? '').trim();
  const sha = String(params.sha ?? '').trim();
  if (!repo || !tag || !sha) return false;

  const oldSha = String(params.oldShaHint ?? '').trim() || readTagShaViaGithubApi({
    repo,
    tag,
    env: params.env,
    dryRun: params.dryRun,
  });

  // PATCH existing ref, otherwise POST a new ref.
  if (oldSha) {
    run(
      'gh',
      // `force` must be a JSON boolean; GitHub rejects `-f force=true` with HTTP 422.
      ['api', '-X', 'PATCH', `repos/${repo}/git/refs/tags/${tag}`, '-f', `sha=${sha}`, '-F', 'force=true'],
      { env: params.env, dryRun: params.dryRun },
    );
    return true;
  }

  run(
    'gh',
    ['api', '-X', 'POST', `repos/${repo}/git/refs`, '-f', `ref=refs/tags/${tag}`, '-f', `sha=${sha}`],
    { env: params.env, dryRun: params.dryRun },
  );
  return true;
}

/**
 * Ensure a versioned (immutable) tag exists and points at the requested sha.
 * This is required because `gh release create --target <sha>` is rejected by the
 * GitHub API (expects a branch/tag-ish value, not a raw commit SHA).
 *
 * @param {{ repo: string; tag: string; sha: string; env: Record<string, string>; dryRun: boolean }} params
 */
function ensureImmutableTagViaGithubApi(params) {
  const repo = String(params.repo ?? '').trim();
  const tag = String(params.tag ?? '').trim();
  const sha = String(params.sha ?? '').trim();
  if (!repo || !tag || !sha) return false;

  const existingSha = readTagShaViaGithubApi({
    repo,
    tag,
    env: params.env,
    dryRun: params.dryRun,
  });

  if (existingSha) {
    if (existingSha !== sha) {
      fail(`Tag refs/tags/${tag} already exists at a different sha (${existingSha}); refusing to move immutable tag.`);
    }
    return true;
  }

  run(
    'gh',
    ['api', '-X', 'POST', `repos/${repo}/git/refs`, '-f', `ref=refs/tags/${tag}`, '-f', `sha=${sha}`],
    { env: params.env, dryRun: params.dryRun },
  );
  return true;
}

async function main() {
  const { values } = parseArgs({
    options: {
      tag: { type: 'string' },
      title: { type: 'string' },
      'target-sha': { type: 'string' },
      prerelease: { type: 'string' },
      'rolling-tag': { type: 'string' },
      'generate-notes': { type: 'string' },
      notes: { type: 'string', default: '' },
      assets: { type: 'string', default: '' },
      'assets-dir': { type: 'string', default: '' },
      clobber: { type: 'string', default: 'false' },
      'prune-assets': { type: 'string', default: 'false' },
      'release-message': { type: 'string', default: '' },
      'dry-run': { type: 'boolean', default: false },
      'max-commits': { type: 'string', default: '200' },
    },
    allowPositionals: false,
  });

  const tag = String(values.tag ?? '').trim();
  const title = String(values.title ?? '').trim();
  const sha = String(values['target-sha'] ?? '').trim();
  if (!tag) fail('--tag is required');
  if (!title) fail('--title is required');
  if (!sha) fail('--target-sha is required');

  const prerelease = parseBool(values.prerelease, '--prerelease');
  const rollingTag = parseBool(values['rolling-tag'], '--rolling-tag');
  const generateNotes = parseBool(values['generate-notes'], '--generate-notes');
  const clobber = parseBool(values.clobber, '--clobber');
  const pruneAssets = parseBool(values['prune-assets'], '--prune-assets');
  const notes = String(values.notes ?? '');
  const releaseMessage = String(values['release-message'] ?? '');
  const dryRun = values['dry-run'] === true;
  const maxCommitsRaw = Number(String(values['max-commits'] ?? '200'));
  const maxCommits = Number.isFinite(maxCommitsRaw) ? Math.max(1, Math.floor(maxCommitsRaw)) : 200;

  const repo =
    String(process.env.GH_REPO ?? '').trim() ||
    String(process.env.GITHUB_REPOSITORY ?? '').trim() ||
    inferRepoFromGitOrigin();

  if (!repo && !dryRun) {
    fail('Missing GH_REPO/GITHUB_REPOSITORY and could not infer from git remote; required for release API calls.');
  }

  const ghToken = String(process.env.GH_TOKEN ?? '').trim();
  const uploadRetries = readPositiveIntegerEnv(
    'HAPPIER_PIPELINE_GH_RELEASE_UPLOAD_RETRIES',
    DEFAULT_RELEASE_UPLOAD_RETRIES,
  );
  const uploadRetryDelayMs = readPositiveIntegerEnv(
    'HAPPIER_PIPELINE_GH_RELEASE_UPLOAD_RETRY_DELAY_MS',
    DEFAULT_RELEASE_UPLOAD_RETRY_DELAY_MS,
  );
  const transferTimeoutMs = readPositiveIntegerEnv(
    'HAPPIER_PIPELINE_GH_RELEASE_TRANSFER_TIMEOUT_MS',
    DEFAULT_RELEASE_TRANSFER_TIMEOUT_MS,
  );
  /** @type {Record<string, string>} */
  const ghEnv = {};
  if (repo) ghEnv.GH_REPO = repo;
  if (ghToken) ghEnv.GH_TOKEN = ghToken;

  let oldSha = '';
  if (rollingTag && repo) {
    oldSha = readTagShaViaGithubApi({ repo, tag, env: ghEnv, dryRun });
  }
  if (!oldSha) {
    oldSha = run('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`], {
      dryRun,
      allowFailure: true,
    }).trim();
  }

  let pushedRollingTag = true;
  let tagEnsured = false;
  if (rollingTag) {
    try {
      // Prefer GH API so the workflow does not rely on git remote auth being configured.
      if (repo) {
        pushedRollingTag = updateRollingTagViaGithubApi({ repo, tag, sha, env: ghEnv, dryRun, oldShaHint: oldSha });
      } else {
        pushedRollingTag = false;
      }

      if (!pushedRollingTag) {
        // Fall back to git push for local runs where the user has origin auth set up.
        run('git', ['tag', '-f', tag, sha], { dryRun });
        run('git', ['push', 'origin', `refs/tags/${tag}`, '--force'], { dryRun });
        pushedRollingTag = true;
      }
    } catch {
      pushedRollingTag = false;
      console.log('::warning::Rolling tag push failed (tag protections or permissions). Skipping asset upload for rolling tag.');
    }
    tagEnsured = pushedRollingTag;
  } else {
    // Versioned tags must exist before creating a release, since `--target <sha>` is invalid.
    try {
      if (repo) {
        tagEnsured = ensureImmutableTagViaGithubApi({ repo, tag, sha, env: ghEnv, dryRun });
      } else {
        tagEnsured = false;
      }
      if (!tagEnsured) {
        run('git', ['tag', tag, sha], { dryRun });
        run('git', ['push', 'origin', `refs/tags/${tag}`], { dryRun });
        tagEnsured = true;
      }
    } catch (err) {
      if (!dryRun) {
        fail(`Failed to create immutable tag refs/tags/${tag}: ${formatExecError(err)}`);
      }
      tagEnsured = true;
    }
  }

  const prereleaseFlag = prerelease ? ['--prerelease'] : [];
  const approvedReleaseBody = releaseMessage.trim();

  // Ensure release exists.
  let releaseExists = true;
  try {
    run('gh', ['release', 'view', tag], { env: ghEnv, dryRun });
  } catch {
    releaseExists = false;
  }

  if (!releaseExists) {
    if (!tagEnsured && !dryRun) {
      fail(`Cannot create release ${tag}: tag ref could not be ensured.`);
    }
    if (generateNotes && !approvedReleaseBody) {
      run(
        'gh',
        ['release', 'create', tag, ...prereleaseFlag, '--title', title, '--generate-notes'],
        { env: ghEnv, dryRun },
      );
    } else {
      const body = approvedReleaseBody || notes.trim();
      if (!body) fail('notes or release_message is required when generate_notes=false');
      run(
        'gh',
        ['release', 'create', tag, ...prereleaseFlag, '--title', title, '--notes', body],
        { env: ghEnv, dryRun },
      );
    }
  }

  // Update rolling release notes with commit summary.
  if (rollingTag) {
    if (approvedReleaseBody) {
      run('gh', buildRollingReleaseEditArgs({ tag, title, notes: approvedReleaseBody }), { env: ghEnv, dryRun });
    } else {
      const { compareUrl, commitCount, commits } = collectRollingCompareSummary({
        oldSha,
        sha,
        repo,
        dryRun,
        maxCommits,
        tag,
      });

      const notesPrefix = notes.trim() || 'Rolling release.';
      let body = `${notesPrefix}\n`;

      if (commitCount) {
        body += `\n### Commits (${commitCount})\n\n${commits}\n\nFull diff: ${compareUrl}\n`;
        const parsedCount = Number(commitCount);
        if (Number.isFinite(parsedCount) && parsedCount > maxCommits) {
          body += `\n(Showing first ${maxCommits} commits; see Full diff for the complete list.)\n`;
        }
      }

      run('gh', buildRollingReleaseEditArgs({ tag, title, notes: body }), { env: ghEnv, dryRun });
    }
  }

  // Prune assets (rolling tags typically).
  if (pruneAssets) {
    if (!repo) {
      fail('Cannot prune assets without GH_REPO/GITHUB_REPOSITORY or an inferable git remote.');
    }
    const releaseApi = `repos/${repo}/releases/tags/${tag}`;
    let assetIds = '';
    try {
      assetIds = run('gh', ['api', releaseApi, '--jq', '.assets[].id'], { env: ghEnv, dryRun }).trim();
    } catch {
      assetIds = '';
    }
    if (assetIds) {
      for (const line of assetIds.split('\n')) {
        const id = line.trim();
        if (!id) continue;
        run('gh', ['api', '-X', 'DELETE', `repos/${repo}/releases/assets/${id}`], { env: ghEnv, dryRun });
      }
    }
  }

  // Upload assets.
  const assetsDir = String(values['assets-dir'] ?? '').trim();
  const assetsRaw = String(values.assets ?? '').trim();
  const clobberFlag = clobber ? ['--clobber'] : [];

  /** @type {string[]} */
  const uploadSpecs = [];
  if (assetsDir) {
    if (!fs.existsSync(assetsDir) || !fs.statSync(assetsDir).isDirectory()) {
      fail(`assets_dir does not exist: ${assetsDir}`);
    }
    const files = listFilesRecursively(assetsDir);
    if (files.length === 0) fail(`No files found in assets_dir: ${assetsDir}`);
    uploadSpecs.push(...files);
  }
  if (assetsRaw) {
    for (const line of assetsRaw.split('\n')) {
      const spec = line.trim();
      if (!spec) continue;
      uploadSpecs.push(spec);
    }
  }

  if (!rollingTag) {
    if (clobber || pruneAssets) {
      fail('Immutable version releases forbid --clobber true and --prune-assets true.');
    }
    const localByName = new Map();
    for (const spec of uploadSpecs) {
      const name = path.basename(spec);
      if (localByName.has(name)) {
        fail(`Duplicate immutable release asset name: ${name}`);
      }
      localByName.set(name, spec);
    }
    const existingAssetNames = run('gh', [
      'release', 'view', tag,
      '--repo', repo,
      '--json', 'assets',
      '--jq', '.assets[].name',
    ], { env: ghEnv, dryRun }).trim()
      .split(/\r?\n/)
      .map((name) => name.trim())
      .filter(Boolean);
    const unexpected = existingAssetNames.filter((name) => !localByName.has(name));
    if (unexpected.length > 0) {
      fail(`Immutable release contains unexpected pre-existing asset(s): ${unexpected.join(', ')}`);
    }
    if (!dryRun) {
      for (const name of existingAssetNames) {
        await assertRemoteAssetMatches({
          tag,
          repo,
          name,
          expectedPath: /** @type {string} */ (localByName.get(name)),
          env: ghEnv,
          timeoutMs: transferTimeoutMs,
          retries: uploadRetries,
          retryDelayMs: uploadRetryDelayMs,
        });
      }
    }
    const existing = new Set(existingAssetNames);
    for (const [name, spec] of localByName) {
      if (existing.has(name)) continue;
      let uploaded = false;
      for (let attempt = 1; attempt <= uploadRetries; attempt += 1) {
        try {
          run('gh', ['release', 'upload', tag, spec], {
            env: ghEnv,
            dryRun,
            timeoutMs: transferTimeoutMs,
          });
          uploaded = true;
          break;
        } catch (err) {
          if (!dryRun && isTransientReleaseTransferError(err) && attempt < uploadRetries) {
            sleepSync(uploadRetryDelayMs);
            continue;
          }
          throw err;
        }
      }
      if (!uploaded) fail(`Failed to upload immutable release asset: ${name}`);
    }
    if (!dryRun) {
      for (const [name, expectedPath] of localByName) {
        await assertRemoteAssetMatches({
          tag,
          repo,
          name,
          expectedPath,
          env: ghEnv,
          timeoutMs: transferTimeoutMs,
          retries: uploadRetries,
          retryDelayMs: uploadRetryDelayMs,
        });
      }
    }
    return;
  }

  for (const spec of uploadSpecs) {
    let uploaded = false;
    for (let attempt = 1; attempt <= uploadRetries; attempt += 1) {
      try {
        run('gh', ['release', 'upload', tag, spec, ...clobberFlag], {
          env: ghEnv,
          dryRun,
          timeoutMs: transferTimeoutMs,
        });
        uploaded = true;
        break;
      } catch (err) {
        if (!dryRun && isTransientReleaseTransferError(err) && attempt < uploadRetries) {
          sleepSync(uploadRetryDelayMs);
          continue;
        }
        throw err;
      }
    }
    if (!uploaded) {
      fail(`Failed to upload release asset after ${uploadRetries} attempts: ${spec}`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
