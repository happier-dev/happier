// @ts-check

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import { ensureTauriSigningKeyFile } from './ensure-signing-key-file.mjs';
import { extractTauriUpdaterSignature } from './notarize-macos-artifacts.mjs';
import { resolveTauriSigningPrivateKeyPassword } from './resolve-signing-key-password.mjs';
import { resolveYarnInvocation } from './resolve-yarn-invocation.mjs';
import { execFileSyncPortable } from '../lib/exec-file-sync-portable.mjs';

function listSignatureFiles(dir) {
  const output = [];
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile() && entry.name.endsWith('.sig')) output.push(absolute);
    }
  }
  return output.sort();
}

export function signUpdaterArtifacts(options, deps = {}) {
  const signingKeyValue = String(options.env.TAURI_SIGNING_PRIVATE_KEY ?? '').trim();
  if (!signingKeyValue) throw new Error('TAURI_SIGNING_PRIVATE_KEY is required');
  const materializeSigningKey = deps.ensureSigningKeyFile ?? ensureTauriSigningKeyFile;
  const resolveYarn = deps.resolveYarnInvocation ?? resolveYarnInvocation;
  const runSigner = deps.runSigner ?? execFileSyncPortable;
  const signingKeyPath = materializeSigningKey({ tmpRoot: options.tmpRoot, keyValue: signingKeyValue, dryRun: false });
  const password = resolveTauriSigningPrivateKeyPassword(options.env);
  const signatures = listSignatureFiles(options.searchDir);
  if (signatures.length === 0) throw new Error(`expected updater signatures under ${options.searchDir}`);
  for (const signaturePath of signatures) {
    const artifactPath = signaturePath.slice(0, -'.sig'.length);
    if (!fs.existsSync(artifactPath)) throw new Error(`updater artifact must be a regular file: ${artifactPath}`);
    const artifactStat = fs.lstatSync(artifactPath);
    if (!artifactStat.isFile() || artifactStat.isSymbolicLink()) throw new Error(`updater artifact must be a regular file: ${artifactPath}`);
  }
  const yarn = resolveYarn({ platform: options.platform });
  for (const signaturePath of signatures) {
    const artifactPath = signaturePath.slice(0, -'.sig'.length);
    const args = [...yarn.prefixArgs, '--silent', 'tauri', 'signer', 'sign', '--private-key-path', signingKeyPath];
    if (password) args.push('--password', password);
    args.push(artifactPath);
    const stdout = runSigner(yarn.cmd, args, { cwd: options.uiDir, env: { ...options.env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 10 * 60_000 });
    const signature = extractTauriUpdaterSignature(stdout);
    if (!signature || !/^[A-Za-z0-9+/=]+$/u.test(signature)) throw new Error(`invalid updater signature for ${artifactPath}`);
    fs.writeFileSync(signaturePath, `${signature}\n`, 'utf8');
  }
  return signatures.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { 'ui-dir': { type: 'string', default: 'apps/ui' }, 'tauri-target': { type: 'string', default: '' } }, allowPositionals: false });
  const uiDir = path.resolve(String(values['ui-dir']));
  const target = String(values['tauri-target'] ?? '').trim();
  const searchDir = path.join(uiDir, 'src-tauri', 'target', ...(target ? [target] : []), 'release', 'bundle');
  signUpdaterArtifacts({ uiDir, searchDir, tmpRoot: String(process.env.RUNNER_TEMP ?? '').trim() || os.tmpdir(), env: process.env, platform: process.platform });
}
