// @ts-check

import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ env?: Record<string, string>; dryRun?: boolean; allowFailure?: boolean }} [opts]
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
      timeout: 120_000,
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

function main() {
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
      clobber: { type: 'string', default: 'true' },
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
  /** @type {Record<string, string>} */
  const ghEnv = {};
  if (repo) ghEnv.GH_REPO = repo;
  if (ghToken) ghEnv.GH_TOKEN = ghToken;

  let oldSha = '';
  try {
    oldSha = run('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`], {
      dryRun,
      allowFailure: true,
    }).trim();
  } catch {
    oldSha = '';
  }

  let pushedRollingTag = true;
  if (rollingTag) {
    run('git', ['tag', '-f', tag, sha], { dryRun });
    try {
      run('git', ['push', 'origin', `refs/tags/${tag}`, '--force'], { dryRun });
    } catch {
      pushedRollingTag = false;
      console.log('::warning::Rolling tag push failed (tag protections or permissions). Skipping asset upload for rolling tag.');
    }
  }

  const prereleaseFlag = prerelease ? ['--prerelease'] : [];

  // Ensure release exists.
  let releaseExists = true;
  try {
    run('gh', ['release', 'view', tag], { env: ghEnv, dryRun });
  } catch {
    releaseExists = false;
  }

  if (!releaseExists) {
    if (generateNotes) {
      run(
        'gh',
        ['release', 'create', tag, ...prereleaseFlag, '--title', title, '--target', sha, '--generate-notes'],
        { env: ghEnv, dryRun },
      );
    } else {
      const prefix = releaseMessage.trim();
      const suffix = notes.trim();
      const body = prefix && suffix ? `${prefix}\n\n${suffix}` : prefix || suffix;
      if (!body) fail('notes or release_message is required when generate_notes=false');
      run(
        'gh',
        ['release', 'create', tag, ...prereleaseFlag, '--title', title, '--target', sha, '--notes', body],
        { env: ghEnv, dryRun },
      );
    }
  }

  // If rolling tag push failed, we still created/confirmed the release, but we must avoid mutating assets/notes.
  if (rollingTag && !pushedRollingTag) {
    return;
  }

  // Update rolling release notes with commit summary.
  if (rollingTag) {
    let compareUrl = '';
    let commitCount = '';
    let commits = '';
    if (oldSha && oldSha !== sha) {
      compareUrl = `https://github.com/${repo}/compare/${oldSha}...${sha}`;
      commitCount = run('git', ['rev-list', '--count', `${oldSha}..${sha}`], { dryRun }).trim();
      commits = run('git', ['log', `--max-count=${maxCommits}`, "--pretty=format:- %h %s", `${oldSha}..${sha}`], {
        dryRun,
      }).trim();
    }

    const notesPrefix = notes.trim() || 'Rolling release.';
    let body = '';
    if (releaseMessage.trim()) {
      body += `${releaseMessage.trim()}\n\n`;
    }
    body += `${notesPrefix}\n`;

    if (commitCount) {
      body += `\n### Commits (${commitCount})\n\n${commits}\n\nFull diff: ${compareUrl}\n`;
      const parsedCount = Number(commitCount);
      if (Number.isFinite(parsedCount) && parsedCount > maxCommits) {
        body += `\n(Showing first ${maxCommits} commits; see Full diff for the complete list.)\n`;
      }
    }

    run('gh', ['release', 'edit', tag, '--title', title, '--notes', body], { env: ghEnv, dryRun });
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

  for (const spec of uploadSpecs) {
    run('gh', ['release', 'upload', tag, spec, ...clobberFlag], { env: ghEnv, dryRun });
  }
}

main();
