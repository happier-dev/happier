// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
function parseBoolString(value, name) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  fail(`${name} must be 'true' or 'false' (got: ${value})`);
}

/**
 * @param {string} outputPath
 * @param {Record<string, string>} values
 */
function writeGithubOutput(outputPath, values) {
  if (!outputPath) return;
  const lines = Object.entries(values).map(([k, v]) => `${k}=${String(v ?? '')}`);
  fs.appendFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
}

/**
 * @param {{ dryRun: boolean }} opts
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string; env?: Record<string, string> }} [extra]
 */
function run(opts, cmd, args, extra) {
  const cwd = extra?.cwd ? path.resolve(extra.cwd) : process.cwd();
  const printable = `${cmd} ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`;
  if (opts.dryRun) {
    console.log(`[dry-run] (cwd: ${cwd}) ${printable}`);
    return;
  }
  execFileSync(cmd, args, {
    cwd,
    env: { ...process.env, ...(extra?.env ?? {}) },
    stdio: 'inherit',
    timeout: 5 * 60_000,
  });
}

/**
 * @param {string} bump
 * @param {string} name
 */
function validateBump(bump, name) {
  if (!['none', 'patch', 'minor', 'major'].includes(bump)) {
    fail(`${name} must be one of: none, patch, minor, major (got: ${bump})`);
  }
}

function main() {
  const repoRoot = path.resolve(process.cwd());
  const { values } = parseArgs({
    options: {
      'bump-app': { type: 'string', default: 'none' },
      'bump-server': { type: 'string', default: 'none' },
      'bump-website': { type: 'string', default: 'none' },
      'bump-cli': { type: 'string', default: 'none' },
      'bump-stack': { type: 'string', default: 'none' },
      'bump-plugin-sdk': { type: 'string', default: 'none' },
      'bump-sdk': { type: 'string', default: 'none' },
      'push-branch': { type: 'string', default: 'dev' },
      'commit-message': { type: 'string', default: '' },
      'git-user-name': { type: 'string', default: 'github-actions[bot]' },
      'git-user-email': { type: 'string', default: 'github-actions[bot]@users.noreply.github.com' },
      'github-output': { type: 'string', default: '' },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const bumpApp = String(values['bump-app'] ?? '').trim() || 'none';
  const bumpServer = String(values['bump-server'] ?? '').trim() || 'none';
  const bumpWebsite = String(values['bump-website'] ?? '').trim() || 'none';
  const bumpCli = String(values['bump-cli'] ?? '').trim() || 'none';
  const bumpStack = String(values['bump-stack'] ?? '').trim() || 'none';
  const bumpPluginSdk = String(values['bump-plugin-sdk'] ?? '').trim() || 'none';
  const bumpSdk = String(values['bump-sdk'] ?? '').trim() || 'none';
  const pushBranch = String(values['push-branch'] ?? '').trim() || 'dev';
  const dryRun = values['dry-run'] === true;
  const opts = { dryRun };

  validateBump(bumpApp, '--bump-app');
  validateBump(bumpServer, '--bump-server');
  validateBump(bumpWebsite, '--bump-website');
  validateBump(bumpCli, '--bump-cli');
  validateBump(bumpStack, '--bump-stack');
  validateBump(bumpPluginSdk, '--bump-plugin-sdk');
  validateBump(bumpSdk, '--bump-sdk');

  /** @type {string[]} */
  const bumped = [];

  const bumpVersionScript = fileURLToPath(new URL('./bump-version.mjs', import.meta.url));
  /**
   * @param {'app'|'server'|'website'|'cli'|'stack'|'plugin_sdk'|'sdk'} component
   * @param {string} bump
   */
  const maybeBump = (component, bump) => {
    if (bump === 'none') return;
    run(opts, process.execPath, [bumpVersionScript, '--component', component, '--bump', bump], { cwd: repoRoot });
    bumped.push(component);
  };

  maybeBump('app', bumpApp);
  maybeBump('server', bumpServer);
  maybeBump('website', bumpWebsite);
  maybeBump('cli', bumpCli);
  maybeBump('stack', bumpStack);
  maybeBump('plugin_sdk', bumpPluginSdk);
  maybeBump('sdk', bumpSdk);

  const githubOutput = String(values['github-output'] ?? '').trim();
  if (bumped.length === 0) {
    writeGithubOutput(githubOutput, { did_bump: 'false' });
    return;
  }
  writeGithubOutput(githubOutput, { did_bump: 'true' });

  const userName = String(values['git-user-name'] ?? '').trim() || 'github-actions[bot]';
  const userEmail = String(values['git-user-email'] ?? '').trim() || 'github-actions[bot]@users.noreply.github.com';
  run(opts, 'git', ['config', 'user.name', userName], { cwd: repoRoot });
  run(opts, 'git', ['config', 'user.email', userEmail], { cwd: repoRoot });

  const addPaths = [
    'apps/ui/package.json',
    'apps/ui/app.config.js',
    'apps/server/package.json',
    'apps/website/package.json',
    'apps/cli/package.json',
    'apps/stack/package.json',
    'packages/relay-server/package.json',
    'packages/plugin-sdk/package.json',
    'packages/plugin-ui/package.json',
    'packages/sdk/package.json',
  ];
  run(opts, 'git', ['add', ...addPaths], { cwd: repoRoot });
  if (fs.existsSync(path.join(repoRoot, 'apps', 'ui', 'src-tauri'))) {
    run(opts, 'git', ['add', 'apps/ui/src-tauri'], { cwd: repoRoot });
  }

  const customMessage = String(values['commit-message'] ?? '').trim();
  const message = customMessage || `chore(release): bump versions (${bumped.join(' ')})`;
  run(opts, 'git', ['commit', '-m', message], { cwd: repoRoot });
  run(opts, 'git', ['push', 'origin', `HEAD:${pushBranch}`], { cwd: repoRoot });
}

main();
