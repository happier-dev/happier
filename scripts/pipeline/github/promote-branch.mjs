// @ts-check

import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

function fail(message) {
  console.error(message);
  process.exit(1);
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
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ env?: Record<string, string>; dryRun?: boolean }} [opts]
 */
function run(cmd, args, opts) {
  const dryRun = opts?.dryRun === true;
  const printable = `${cmd} ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`;
  if (dryRun) {
    console.log(`[dry-run] ${printable}`);
    return '';
  }

  return execFileSync(cmd, args, {
    env: { ...process.env, ...(opts?.env ?? {}) },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
}

/**
 * @param {unknown} err
 * @returns {{ stdout: string; stderr: string; message: string }}
 */
function normalizeExecError(err) {
  const anyErr = /** @type {{ stdout?: unknown; stderr?: unknown; message?: unknown }} */ (err ?? {});
  return {
    stdout: typeof anyErr?.stdout === 'string' ? anyErr.stdout : '',
    stderr: typeof anyErr?.stderr === 'string' ? anyErr.stderr : '',
    message: typeof anyErr?.message === 'string' ? anyErr.message : String(err ?? ''),
  };
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isGhNotFoundError(err) {
  const { stderr, message } = normalizeExecError(err);
  return stderr.includes('(HTTP 404)') || message.includes('(HTTP 404)');
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatExecError(err) {
  const { stdout, stderr, message } = normalizeExecError(err);
  const parts = [];
  if (message) parts.push(message.trim());
  if (stderr) parts.push(stderr.trim());
  if (stdout) parts.push(stdout.trim());
  return parts.filter(Boolean).join('\n');
}

/**
 * @param {string[]} files
 */
function classifyChangedComponents(files) {
  let changedUi = false;
  let changedCli = false;
  let changedServer = false;
  let changedWebsite = false;
  let changedDocs = false;
  let changedShared = false;

  for (const filename of files) {
    if (filename.startsWith('apps/ui/')) changedUi = true;
    else if (filename.startsWith('apps/cli/')) changedCli = true;
    else if (filename.startsWith('apps/server/')) changedServer = true;
    else if (filename.startsWith('apps/website/')) changedWebsite = true;
    else if (filename.startsWith('apps/docs/')) changedDocs = true;
    else if (filename.startsWith('packages/agents/') || filename.startsWith('packages/protocol/')) changedShared = true;
  }

  return { changedUi, changedCli, changedServer, changedWebsite, changedDocs, changedShared };
}

/**
 * @param {string} filePath
 * @param {string} markdown
 */
function appendSummary(filePath, markdown) {
  if (!filePath) return;
  fs.appendFileSync(filePath, markdown, 'utf8');
}

function main() {
  const { values } = parseArgs({
    options: {
      source: { type: 'string' },
      target: { type: 'string' },
      mode: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'allow-reset': { type: 'string', default: 'false' },
      confirm: { type: 'string', default: '' },
      'summary-file': { type: 'string', default: '' },
    },
    allowPositionals: false,
  });

  const source = String(values.source ?? '').trim();
  const target = String(values.target ?? '').trim();
  const mode = String(values.mode ?? '').trim();
  const dryRun = values['dry-run'] === true;
  const allowReset = parseBool(values['allow-reset'], '--allow-reset');
  const confirm = String(values.confirm ?? '').trim();
  const summaryFile = String(values['summary-file'] ?? '').trim();

  if (!source || !target) fail('--source and --target are required');
  if (source === target) fail(`Refusing to promote a branch onto itself (${target}).`);
  if (mode !== 'fast_forward' && mode !== 'reset') fail(`--mode must be 'fast_forward' or 'reset' (got: ${mode})`);

  const expectedConfirm = mode === 'fast_forward' ? `promote ${target} from ${source}` : `reset ${target} from ${source}`;
  if (confirm !== expectedConfirm) {
    fail(`Confirmation mismatch. Expected: ${expectedConfirm}`);
  }

  if (mode === 'reset' && !allowReset) {
    fail('Refusing to reset without --allow-reset true.');
  }

  const repo =
    String(process.env.GH_REPO ?? '').trim() ||
    String(process.env.GITHUB_REPOSITORY ?? '').trim() ||
    inferRepoFromGitOrigin();
  if (!repo && !dryRun) {
    fail('Missing GH_REPO/GITHUB_REPOSITORY and could not infer from git remote.');
  }

  /** @type {Record<string, string>} */
  const ghEnv = {};
  if (repo) ghEnv.GH_REPO = repo;
  const token = String(process.env.GH_TOKEN ?? '').trim();
  if (token) ghEnv.GH_TOKEN = token;

  const sourceRefApi = repo ? `repos/${repo}/git/ref/heads/${source}` : `repos/OWNER/REPO/git/ref/heads/${source}`;
  const targetRefApi = repo ? `repos/${repo}/git/ref/heads/${target}` : `repos/OWNER/REPO/git/ref/heads/${target}`;

  const sourceSha = run('gh', ['api', sourceRefApi, '--jq', '.object.sha'], { env: ghEnv, dryRun }).trim();
  const targetSha = run('gh', ['api', targetRefApi, '--jq', '.object.sha'], { env: ghEnv, dryRun }).trim();

  const compareApi = repo ? `repos/${repo}/compare/${target}...${source}` : `repos/OWNER/REPO/compare/${target}...${source}`;
  const compareJson = run(
    'gh',
    [
      'api',
      compareApi,
      '--jq',
      '{status:.status,ahead_by:.ahead_by,behind_by:.behind_by,files:[.files[].filename]}',
    ],
    { env: ghEnv, dryRun },
  ).trim();

  /** @type {{ status: string; ahead_by: number; behind_by: number; files: string[] }} */
  const compare = dryRun
    ? { status: 'ahead', ahead_by: 0, behind_by: 0, files: [] }
    : JSON.parse(compareJson);

  const commitCount = Number(compare.ahead_by ?? 0);
  const changed = classifyChangedComponents(Array.isArray(compare.files) ? compare.files : []);

  const markdown = `## Promote Branch

- source: \`${source}\`
- target: \`${target}\`
- mode: \`${mode}\`
- dry_run: \`${dryRun}\`
- origin/${target}: \`${targetSha || '(unavailable)'}\`
- ${source}: \`${sourceSha || '(unavailable)'}\`
- commits to promote: \`${String(commitCount)}\`

### Changed components (${target}..${source})
- ui: \`${changed.changedUi}\`
- cli: \`${changed.changedCli}\`
- server: \`${changed.changedServer}\`
- website: \`${changed.changedWebsite}\`
- docs: \`${changed.changedDocs}\`
- shared (agents/protocol): \`${changed.changedShared}\`

`;

  appendSummary(summaryFile, markdown);

  if (mode === 'fast_forward') {
    const status = String(compare.status ?? '').trim();
    if (!dryRun && status !== 'ahead' && status !== 'identical') {
      fail(`Cannot fast-forward: compare status is '${status}'. Use mode=reset or resolve divergence first.`);
    }
  }

  if (dryRun) return;

  if (!repo) fail('Missing repo for update operation.');

  const updateApi = `repos/${repo}/git/refs/heads/${target}`;
  const force = mode === 'reset';

  try {
    run('gh', ['api', '-X', 'PATCH', updateApi, '-F', `sha=${sourceSha}`, '-F', `force=${force}`], { env: ghEnv });
  } catch (err) {
    if (!isGhNotFoundError(err)) {
      fail(`Failed to update refs/heads/${target}.\n${formatExecError(err)}`);
    }

    // If ref doesn't exist yet, create it.
    const createApi = `repos/${repo}/git/refs`;
    run('gh', ['api', '-X', 'POST', createApi, '-f', `ref=refs/heads/${target}`, '-f', `sha=${sourceSha}`], {
      env: ghEnv,
    });
  }
}

main();
