// @ts-check

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

import { ensureTauriSigningKeyFile } from './ensure-signing-key-file.mjs';

function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * @param {{ dryRun: boolean }} opts
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd: string; env?: Record<string, string>; stdio?: import('node:child_process').StdioOptions; timeoutMs?: number }} extra
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
    timeout: extra.timeoutMs ?? 30 * 60_000,
  });
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function listFilesRecursive(dir) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else if (entry.isFile()) out.push(abs);
    }
  }
  return out;
}

/**
 * @param {string} dir
 * @param {string} filename
 */
function tempFile(dir, filename) {
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, filename);
}

function main() {
  const repoRoot = path.resolve(process.cwd());
  const { values } = parseArgs({
    options: {
      'ui-dir': { type: 'string', default: 'apps/ui' },
      'tauri-target': { type: 'string', default: '' },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const uiDir = String(values['ui-dir'] ?? '').trim() || 'apps/ui';
  const tauriTarget = String(values['tauri-target'] ?? '').trim();
  const dryRun = values['dry-run'] === true;
  const opts = { dryRun };

  const absUiDir = path.resolve(repoRoot, uiDir);
  const baseDir = path.join(absUiDir, 'src-tauri', 'target');
  const searchDir = tauriTarget ? path.join(baseDir, tauriTarget) : baseDir;

  const tmpRoot = String(process.env.RUNNER_TEMP ?? '').trim() || os.tmpdir();
  const keyPath = tempFile(tmpRoot, 'apple-notary.p8');
  const signingKeyValue = String(process.env.TAURI_SIGNING_PRIVATE_KEY ?? '').trim();
  const signingKeyPath = signingKeyValue
    ? ensureTauriSigningKeyFile({ tmpRoot, keyValue: signingKeyValue, dryRun: opts.dryRun })
    : '';

  if (opts.dryRun) {
    console.log(`[dry-run] search: ${path.relative(repoRoot, searchDir)}`);
  }

  const appleKeyId = String(process.env.APPLE_API_KEY_ID ?? '').trim();
  const appleIssuerId = String(process.env.APPLE_API_ISSUER_ID ?? '').trim();
  const applePrivateKeyRaw = String(process.env.APPLE_API_PRIVATE_KEY ?? '').trim();
  if (!opts.dryRun) {
    if (!appleKeyId || !appleIssuerId || !applePrivateKeyRaw) {
      fail('APPLE_API_KEY_ID, APPLE_API_ISSUER_ID, and APPLE_API_PRIVATE_KEY are required to notarize macOS artifacts.');
    }
  }

  if (opts.dryRun) {
    console.log(`[dry-run] write ${keyPath} (Apple notary key)`);
  } else {
    const normalized = applePrivateKeyRaw.includes('\\n') ? applePrivateKeyRaw.replaceAll('\\n', '\n') : applePrivateKeyRaw;
    if (normalized.includes('BEGIN PRIVATE KEY')) {
      fs.writeFileSync(keyPath, normalized, 'utf8');
    } else {
      fs.writeFileSync(keyPath, Buffer.from(normalized, 'base64'));
    }
    try {
      fs.chmodSync(keyPath, 0o600);
    } catch {
      // best effort
    }
  }

  const files = opts.dryRun ? [] : listFilesRecursive(searchDir);
  const sigMatches = files
    .filter((p) => p.replaceAll(path.sep, '/').includes('/release/bundle/') && p.toLowerCase().endsWith('.app.tar.gz.sig'))
    .sort((a, b) => a.localeCompare(b));

  const sigPath = opts.dryRun ? path.join(searchDir, 'DRY_RUN.app.tar.gz.sig') : sigMatches[0];
  if (!opts.dryRun && sigMatches.length !== 1) {
    fail(`Expected exactly one macOS updater signature under ${searchDir}; found ${sigMatches.length}`);
  }

  const artifactPath = sigPath.endsWith('.sig') ? sigPath.slice(0, -'.sig'.length) : sigPath;

  if (!opts.dryRun) {
    if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
      fail(`Missing updater artifact for signature: ${sigPath}`);
    }
  }

  const workDir = opts.dryRun ? path.join(tmpRoot, 'DRY_RUN_WORK') : fs.mkdtempSync(path.join(tmpRoot, 'happier-tauri-notary-'));
  const zipPath = path.join(workDir, 'app.zip');

  run(opts, 'tar', ['-xzf', artifactPath, '-C', workDir], { cwd: absUiDir, timeoutMs: 10 * 60_000 });

  const appPath = opts.dryRun ? path.join(workDir, 'Happier.app') : findAppDir(workDir);
  run(opts, 'ditto', ['-c', '-k', '--keepParent', appPath, zipPath], { cwd: absUiDir, timeoutMs: 10 * 60_000 });

  run(
    opts,
    'xcrun',
    ['notarytool', 'submit', zipPath, '--key', keyPath, '--key-id', appleKeyId || 'DRY_RUN', '--issuer', appleIssuerId || 'DRY_RUN', '--wait', '--timeout', '15m'],
    { cwd: absUiDir, timeoutMs: 30 * 60_000 },
  );
  run(opts, 'xcrun', ['stapler', 'staple', appPath], { cwd: absUiDir, timeoutMs: 10 * 60_000 });

  const appName = path.basename(appPath);
  const appParent = path.dirname(appPath);
  const newTar = path.join(workDir, 'notarized.app.tar.gz');
  run(opts, 'tar', ['-czf', newTar, '-C', appParent, appName], { cwd: absUiDir, timeoutMs: 10 * 60_000 });

  if (opts.dryRun) {
    console.log(`[dry-run] mv ${newTar} -> ${artifactPath}`);
  } else {
    fs.renameSync(newTar, artifactPath);
  }

  const sigValue = run(
    opts,
    'yarn',
    ['--silent', 'tauri', 'signer', 'sign', path.resolve(absUiDir, artifactPath)],
    {
      cwd: absUiDir,
      env: {
        ...(signingKeyPath ? { TAURI_SIGNING_PRIVATE_KEY: signingKeyPath } : {}),
      },
      stdio: ['ignore', 'pipe', 'inherit'],
      timeoutMs: 10 * 60_000,
    },
  )
    .trim()
    .replaceAll('\r', '')
    .replaceAll('\n', '');

  if (opts.dryRun) {
    console.log(`[dry-run] write ${sigPath} (updated signature)`);
  } else {
    if (!sigValue || !/^[A-Za-z0-9+/=]+$/.test(sigValue)) {
      fail(`Generated updater signature is invalid (got ${sigValue.length} chars).`);
    }
    fs.writeFileSync(sigPath, `${sigValue}\n`, 'utf8');
  }

  const dmgCandidates = files
    .filter((p) => p.replaceAll(path.sep, '/').includes('/release/bundle/') && p.toLowerCase().endsWith('.dmg'))
    .sort((a, b) => a.localeCompare(b));
  const dmgPath = opts.dryRun ? path.join(searchDir, 'DRY_RUN.dmg') : dmgCandidates[0];
  if (dmgCandidates.length > 0 || opts.dryRun) {
    run(
      opts,
      'xcrun',
      ['notarytool', 'submit', dmgPath, '--key', keyPath, '--key-id', appleKeyId || 'DRY_RUN', '--issuer', appleIssuerId || 'DRY_RUN', '--wait', '--timeout', '15m'],
      { cwd: absUiDir, timeoutMs: 30 * 60_000 },
    );
    run(opts, 'xcrun', ['stapler', 'staple', dmgPath], { cwd: absUiDir, timeoutMs: 10 * 60_000 });
  }
}

/**
 * @param {string} workDir
 */
function findAppDir(workDir) {
  /** @type {string[]} */
  const stack = [workDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const abs = path.join(current, entry.name);
      if (entry.name.endsWith('.app')) return abs;
      stack.push(abs);
    }
  }
  fail(`Unable to find .app inside updater artifact (work dir: ${workDir})`);
}

main();
