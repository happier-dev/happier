// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

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
 * @param {string} raw
 * @returns {string[]}
 */
function splitCsv(raw) {
  const v = String(raw ?? '').trim();
  if (!v) return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @param {{ dryRun: boolean }} opts
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd: string; env?: Record<string, string>; stdio?: import('node:child_process').StdioOptions }} extra
 * @returns {string}
 */
function run(opts, cmd, args, extra) {
  const printable = `${cmd} ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`;
  if (opts.dryRun) {
    console.log(`[dry-run] (cwd: ${extra.cwd}) ${printable}`);
    return '';
  }

  return execFileSync(cmd, args, {
    cwd: extra.cwd,
    env: { ...process.env, ...(extra.env ?? {}) },
    encoding: 'utf8',
    stdio: extra.stdio ?? 'inherit',
    timeout: 10 * 60_000,
  });
}

/**
 * @param {{ dryRun: boolean }} opts
 * @param {string} cwd
 * @param {string} key
 * @returns {string}
 */
function gitConfigGet(opts, cwd, key) {
  if (opts.dryRun) return '';
  try {
    return execFileSync('git', ['config', '--get', key], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/**
 * @param {{ dryRun: boolean }} opts
 * @param {string} cwd
 * @returns {boolean}
 */
function hasStagedChanges(opts, cwd) {
  if (opts.dryRun) return true;
  const out = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  return Boolean(out);
}

/**
 * @param {{ dryRun: boolean }} opts
 * @param {string} cwd
 * @param {string} remote
 * @param {string} branch
 * @returns {boolean}
 */
function remoteBranchExists(opts, cwd, remote, branch) {
  // `git ls-remote` is fast and doesn't require that the remote branch is already fetched.
  if (opts.dryRun) {
    run(opts, 'git', ['ls-remote', '--exit-code', '--heads', remote, branch], { cwd });
    return true;
  }
  try {
    execFileSync('git', ['ls-remote', '--exit-code', '--heads', remote, branch], {
      cwd,
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 60_000,
    });
    return true;
  } catch {
    return false;
  }
}

function main() {
  const repoRoot = path.resolve(process.cwd());
  const { values } = parseArgs({
    options: {
      paths: { type: 'string', default: '' },
      'allow-missing': { type: 'string', default: 'false' },
      message: { type: 'string', default: '' },
      'author-name': { type: 'string', default: 'github-actions[bot]' },
      'author-email': { type: 'string', default: 'github-actions[bot]@users.noreply.github.com' },
      remote: { type: 'string', default: 'origin' },
      'push-ref': { type: 'string', default: '' },
      'push-mode': { type: 'string', default: 'auto' },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const pathsRaw = String(values.paths ?? '').trim();
  const pathsList = splitCsv(pathsRaw);
  if (pathsList.length < 1) fail('--paths is required (comma-separated)');

  const allowMissing = parseBool(values['allow-missing'], '--allow-missing');
  const message = String(values.message ?? '').trim();
  if (!message) fail('--message is required');

  const authorName = String(values['author-name'] ?? '').trim() || 'github-actions[bot]';
  const authorEmail = String(values['author-email'] ?? '').trim() || 'github-actions[bot]@users.noreply.github.com';
  const remote = String(values.remote ?? '').trim() || 'origin';

  const pushRef = String(values['push-ref'] ?? '').trim();
  const pushModeRaw = String(values['push-mode'] ?? '').trim();
  const pushMode = pushModeRaw === 'auto' || pushModeRaw === 'always' || pushModeRaw === 'never' ? pushModeRaw : 'auto';
  if (pushModeRaw && pushMode !== pushModeRaw) {
    fail(`--push-mode must be 'auto', 'always', or 'never' (got: ${pushModeRaw})`);
  }

  const dryRun = values['dry-run'] === true;
  const opts = { dryRun };

  const cwd = repoRoot;

  const existingName = gitConfigGet(opts, cwd, 'user.name');
  const existingEmail = gitConfigGet(opts, cwd, 'user.email');
  if (!existingName) run(opts, 'git', ['config', 'user.name', authorName], { cwd });
  if (!existingEmail) run(opts, 'git', ['config', 'user.email', authorEmail], { cwd });

  for (const relPath of pathsList) {
    const abs = path.resolve(repoRoot, relPath);
    const exists = fs.existsSync(abs);
    if (!exists) {
      if (allowMissing) continue;
      fail(`Missing path: ${relPath}`);
    }
    run(opts, 'git', ['add', relPath], { cwd });
  }

  if (!hasStagedChanges(opts, cwd)) {
    console.log('SKIP');
    console.log('DID_COMMIT=false');
    return;
  }

  run(opts, 'git', ['commit', '-m', message], { cwd });
  console.log('DID_COMMIT=true');

  if (pushMode === 'never') return;
  if (!pushRef) fail('--push-ref is required when --push-mode is not never');

  if (pushMode === 'auto') {
    if (!remoteBranchExists(opts, cwd, remote, pushRef)) {
      console.log(`Skipping push: '${pushRef}' is not a known branch ref.`);
      return;
    }
  }

  run(opts, 'git', ['push', remote, `HEAD:refs/heads/${pushRef}`], { cwd });
}

main();
