// @ts-check

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import { ensureTauriSigningKeyFile } from './ensure-signing-key-file.mjs';
import { resolveTauriSigningPrivateKeyPassword } from './resolve-signing-key-password.mjs';
import { resolveYarnInvocation } from './resolve-yarn-invocation.mjs';

const DEFAULT_NOTARYTOOL_SUBMIT_ATTEMPTS = 2;
const DEFAULT_NOTARYTOOL_RETRY_DELAY_MS = 10_000;

function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * Extracts the base64 updater signature from `tauri signer sign` stdout.
 *
 * Tauri CLI may print additional log lines (or prefix the signature with a label), so we can't
 * assume stdout is only the base64 blob.
 *
 * @param {string} stdout
 * @returns {string}
 */
export function extractTauriUpdaterSignature(stdout) {
  const raw = String(stdout ?? '').replaceAll('\r', '');
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  // Prefer explicit "Signature: <base64>" lines when present.
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    const m = /^signature:\s*([A-Za-z0-9+/=]+)$/i.exec(line);
    if (m?.[1]) return m[1];
    if (/^signature:\s*$/i.test(line)) {
      const nextLine = lines[i + 1];
      if (nextLine && /^[A-Za-z0-9+/=]{80,}$/.test(nextLine)) {
        return nextLine;
      }
    }
  }

  // Fallback: pick the last full base64-only line. Signatures can be longer than 256
  // characters, so token chunking would silently publish only the tail of the signature.
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (/^[A-Za-z0-9+/=]{80,}$/.test(line)) {
      return line;
    }
  }

  const matches = raw.match(/[A-Za-z0-9+/=]{80,}/g) ?? [];
  return matches.length > 0 ? matches[matches.length - 1] : '';
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
 * @param {NodeJS.ProcessEnv} env
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function readPositiveIntegerEnv(env, name, fallback) {
  const raw = String(env[name] ?? '').trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stringifyCommandOutput(value) {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return '';
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function stringifyCommandError(error) {
  if (!(error instanceof Error)) return String(error ?? '');
  const commandError = /** @type {Error & { stdout?: unknown; stderr?: unknown }} */ (error);
  return [
    error.message,
    stringifyCommandOutput(commandError.stdout),
    stringifyCommandOutput(commandError.stderr),
  ].filter(Boolean).join('\n');
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
export function shouldRetryNotarytoolSubmitError(error) {
  const text = stringifyCommandError(error);
  if (!/\bnotarytool\s+submit\b/i.test(text)) return false;
  return /NSURLErrorDomain\s+Code=-1001/i.test(text)
    || /HTTPError\(statusCode:\s*nil/i.test(text)
    || /\brequest timed out\b/i.test(text)
    || /\bnetwork connection was lost\b/i.test(text);
}

/**
 * @param {number} ms
 */
function sleepSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.trunc(ms));
}

/**
 * @param {{ dryRun: boolean }} opts
 * @param {string[]} args
 * @param {{ cwd: string; env?: Record<string, string>; timeoutMs?: number }} extra
 * @returns {string}
 */
function runNotarytoolSubmit(opts, args, extra) {
  if (opts.dryRun) {
    return run(opts, 'xcrun', args, { ...extra, stdio: 'inherit' });
  }

  const attempts = readPositiveIntegerEnv(process.env, 'TAURI_NOTARYTOOL_SUBMIT_ATTEMPTS', DEFAULT_NOTARYTOOL_SUBMIT_ATTEMPTS);
  const retryDelayMs = readPositiveIntegerEnv(process.env, 'TAURI_NOTARYTOOL_RETRY_DELAY_MS', DEFAULT_NOTARYTOOL_RETRY_DELAY_MS);
  const printable = `xcrun ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const stdout = execFileSync('xcrun', args, {
        cwd: extra.cwd,
        env: { ...process.env, ...(extra.env ?? {}) },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: extra.timeoutMs ?? 30 * 60_000,
      });
      if (stdout) process.stdout.write(stdout);
      return stdout;
    } catch (error) {
      const commandError = /** @type {Error & { stdout?: unknown; stderr?: unknown }} */ (error);
      const stdout = stringifyCommandOutput(commandError.stdout);
      const stderr = stringifyCommandOutput(commandError.stderr);
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);

      const shouldRetry = attempt < attempts && shouldRetryNotarytoolSubmitError(error);
      if (!shouldRetry) throw error;

      console.warn(`[notarytool] transient submit failure; retrying ${printable} (${attempt + 1}/${attempts})`);
      sleepSync(retryDelayMs);
    }
  }

  return '';
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

/**
 * When caches restore previous bundle outputs, multiple updater signatures can exist under the same
 * `target/<tauri-target>` directory. We prefer the newest signature to ensure we notarize the
 * artifacts produced by the current build run.
 *
 * @param {readonly string[]} paths
 * @param {{ statSync?: typeof fs.statSync }} [opts]
 * @returns {string}
 */
export function pickNewestFile(paths, opts) {
  const statSyncImpl = opts?.statSync ?? fs.statSync;
  if (!Array.isArray(paths) || paths.length === 0) {
    fail('pickNewestFile expected at least one path');
  }

  let bestPath = paths[0];
  let bestMtime = -Infinity;

  for (const p of paths) {
    try {
      const stat = statSyncImpl(p);
      const mtime = Number(stat?.mtimeMs ?? 0);
      if (Number.isFinite(mtime) && mtime >= bestMtime) {
        bestMtime = mtime;
        bestPath = p;
      }
    } catch {
      // ignore missing/stat failures; we'll keep the current best.
    }
  }

  return bestPath;
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
  const signingKeyPassword = resolveTauriSigningPrivateKeyPassword(process.env);
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

  let sigPath = opts.dryRun ? path.join(searchDir, 'DRY_RUN.app.tar.gz.sig') : '';
  if (!opts.dryRun) {
    if (sigMatches.length === 0) {
      fail(`Expected at least one macOS updater signature under ${searchDir}; found 0`);
    }
    sigPath = sigMatches.length === 1 ? sigMatches[0] : pickNewestFile(sigMatches);
    if (sigMatches.length > 1) {
      console.warn(`Found multiple macOS updater signatures under ${searchDir}; using newest: ${sigPath}`);
    }
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

  runNotarytoolSubmit(
    opts,
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

  const yarn = resolveYarnInvocation();
  /** @type {string[]} */
  const signArgs = [...yarn.prefixArgs, '--silent', 'tauri', 'signer', 'sign'];
  if (signingKeyPath) signArgs.push('--private-key-path', signingKeyPath);
  if (signingKeyPassword) signArgs.push('--password', signingKeyPassword);
  signArgs.push(path.resolve(absUiDir, artifactPath));

  const sigRaw = run(opts, yarn.cmd, signArgs, {
    cwd: absUiDir,
    stdio: ['ignore', 'pipe', 'inherit'],
    timeoutMs: 10 * 60_000,
  });

  const sigValue = extractTauriUpdaterSignature(sigRaw);

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
    runNotarytoolSubmit(
      opts,
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
