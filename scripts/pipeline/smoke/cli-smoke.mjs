// @ts-check

import fs from 'node:fs';
import os from 'node:os';
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
 * @param {{ dryRun: boolean }} opts
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string; env?: Record<string, string>; stdio?: import('node:child_process').StdioOptions; timeoutMs?: number; }} [extra]
 * @returns {string}
 */
function run(opts, cmd, args, extra) {
  const printable = `${cmd} ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`;
  const cwd = extra?.cwd ? path.resolve(extra.cwd) : process.cwd();
  const timeout = extra?.timeoutMs ?? 10 * 60_000;
  if (opts.dryRun) {
    console.log(`[dry-run] (cwd: ${cwd}) ${printable}`);
    return '';
  }

  const stdio = extra?.stdio ?? 'inherit';
  const needsShell =
    process.platform === 'win32' && (String(cmd).toLowerCase().endsWith('.cmd') || String(cmd).toLowerCase().endsWith('.bat'));
  return execFileSync(cmd, args, {
    cwd,
    env: { ...process.env, ...(extra?.env ?? {}) },
    encoding: stdio === 'inherit' ? 'utf8' : 'utf8',
    stdio,
    shell: needsShell,
    timeout,
  });
}

/**
 * @param {string} repoRoot
 * @param {string} rel
 */
function withinRepo(repoRoot, rel) {
  return path.resolve(repoRoot, rel);
}

/**
 * @param {string} prefix
 * @returns {string}
 */
function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * @param {string} pkgDir
 * @param {string} destDir
 * @param {{ dryRun: boolean }} opts
 * @returns {string} absolute tgz path
 */
function npmPack(pkgDir, destDir, opts) {
  if (opts.dryRun) {
    const printable = `npm pack --silent --pack-destination ${destDir}`;
    console.log(`[dry-run] (cwd: ${pkgDir}) ${printable}`);
    return path.join(destDir, 'DRY_RUN.tgz');
  }

  fs.mkdirSync(destDir, { recursive: true });
  const raw = execFileSync('npm', ['pack', '--silent', '--pack-destination', destDir], {
    cwd: pkgDir,
    env: { ...process.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    timeout: 10 * 60_000,
  }).trim();

  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const filename = lines.length > 0 ? lines[lines.length - 1] : '';
  if (!filename) {
    throw new Error(`npm pack did not return a tarball filename (cwd: ${pkgDir})`);
  }
  const tgzPath = path.resolve(destDir, filename);
  if (!tgzPath.endsWith('.tgz') || !fs.existsSync(tgzPath) || !fs.statSync(tgzPath).isFile()) {
    throw new Error(`npm pack did not produce an expected .tgz file (cwd: ${pkgDir}): ${tgzPath}`);
  }
  return tgzPath;
}

/**
 * @param {string} prefixDir
 * @returns {string}
 */
function resolveInstalledBin(prefixDir) {
  const exe = process.platform === 'win32' ? 'happier.cmd' : 'happier';

  const env = { ...process.env, npm_config_prefix: prefixDir };
  let binDir = '';
  try {
    binDir = execFileSync('npm', ['bin', '-g'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim()
      .split(/\r?\n/)[0]
      .trim();
  } catch {
    binDir = '';
  }

  const candidates = [
    ...(binDir ? [path.join(binDir, exe)] : []),
    path.join(prefixDir, 'bin', exe),
    path.join(prefixDir, exe),
    path.join(prefixDir, 'node_modules', '.bin', exe),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  fail(`Unable to locate installed CLI binary under prefix ${prefixDir} (looked for: ${exe})`);
}

function main() {
  const repoRoot = path.resolve(process.cwd());
  const { values } = parseArgs({
    options: {
      'package-dir': { type: 'string', default: 'apps/cli' },
      'workspace-name': { type: 'string', default: '@happier-dev/cli' },
      'skip-build': { type: 'string', default: 'false' },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const pkgDir = String(values['package-dir'] ?? '').trim() || 'apps/cli';
  const workspaceName = String(values['workspace-name'] ?? '').trim() || '@happier-dev/cli';
  const skipBuild = parseBool(values['skip-build'], '--skip-build');
  const dryRun = values['dry-run'] === true;
  const opts = { dryRun };

  const absPkgDir = withinRepo(repoRoot, pkgDir);
  if (!fs.existsSync(absPkgDir)) {
    fail(`package dir not found: ${pkgDir}`);
  }

  const prefixDir = dryRun ? withinRepo(repoRoot, 'dist/smoke/DRY_RUN_PREFIX') : mkTmpDir('happier-cli-smoke-prefix-');
  const homeDir = dryRun ? withinRepo(repoRoot, 'dist/smoke/DRY_RUN_HOME') : mkTmpDir('happier-cli-smoke-home-');
  const packDir = dryRun ? withinRepo(repoRoot, 'dist/smoke/DRY_RUN_PACK') : mkTmpDir('happier-cli-smoke-pack-');

  if (!skipBuild) {
    run(opts, 'yarn', ['workspace', workspaceName, 'build'], { cwd: repoRoot });
  }

  const tgzPath = npmPack(absPkgDir, packDir, opts);

  run(opts, 'npm', ['install', '-g', '--prefix', prefixDir, tgzPath], { cwd: repoRoot });

  const binPath = opts.dryRun ? path.join(prefixDir, process.platform === 'win32' ? 'happier.cmd' : 'bin/happier') : resolveInstalledBin(prefixDir);

  const baseEnv = { ...process.env, HAPPIER_HOME_DIR: homeDir };

  run(opts, binPath, ['--help'], { cwd: repoRoot, env: baseEnv, stdio: opts.dryRun ? 'inherit' : ['ignore', 'inherit', 'inherit'], timeoutMs: 30_000 });
  run(opts, binPath, ['--version'], { cwd: repoRoot, env: baseEnv, stdio: opts.dryRun ? 'inherit' : ['ignore', 'inherit', 'inherit'], timeoutMs: 10_000 });

  const doctor = run(opts, binPath, ['doctor', '--help'], { cwd: repoRoot, env: baseEnv, stdio: ['ignore', 'pipe', 'inherit'], timeoutMs: 10_000 });
  if (!opts.dryRun && doctor) {
    process.stdout.write(doctor);
    if (!doctor.endsWith('\n')) process.stdout.write('\n');
  }

  const daemonHelp = run(opts, binPath, ['daemon', '--help'], { cwd: repoRoot, env: baseEnv, stdio: ['ignore', 'pipe', 'inherit'], timeoutMs: 10_000 });
  if (!opts.dryRun) {
    process.stdout.write(daemonHelp);
    if (!daemonHelp.endsWith('\n')) process.stdout.write('\n');
    if (!daemonHelp.includes('Daemon management')) {
      fail('Expected `happier daemon --help` to include "Daemon management"');
    }
  }

  console.log('[smoke] CLI smoke test passed.');
}

main();
