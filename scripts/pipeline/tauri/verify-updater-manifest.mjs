// @ts-check
// Proves the desktop auto-updater would accept what latest.json points at: every platform entry's
// signature must verify, with the updater public key the app is built with, against the artifact
// the entry names. make-latest-json only checks that a signature is well-formed, and
// artifact-verify covers the CLI/hstack/server products, not the Tauri updater manifest.
//
// Verification is minisign's own (`minisign -V`): Tauri updater signatures are minisign signatures,
// and the prepare job already installs minisign to sign the release envelope. The key is read from
// the checked-out Tauri configs (the job's trusted control checkout), which carry one updater key.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { normalizePublicReleaseChannel } from '../release/lib/public-release-rings.mjs';
import { resolveTauriChannelConfigFile } from './channel-config.mjs';

/**
 * The updater public key (minisign key line) an environment's app embeds.
 * @param {{ tauriDir: string; environment: 'production' | 'preview' | 'publicdev' }} params
 */
export function readUpdaterPublicKey({ tauriDir, environment }) {
  const read = (/** @type {string} */ name) => JSON.parse(fs.readFileSync(path.join(tauriDir, name), 'utf8'))?.plugins?.updater?.pubkey;
  const encoded = read(resolveTauriChannelConfigFile(environment)) ?? read('tauri.conf.json');
  if (typeof encoded !== 'string' || !encoded.trim()) throw new Error(`no updater pubkey configured for ${environment}`);
  const keyLine = Buffer.from(encoded, 'base64').toString('utf8').split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).at(-1);
  if (!keyLine || !/^RW[A-Za-z0-9+/=]{50,}$/u.test(keyLine)) throw new Error(`updater pubkey for ${environment} is not a minisign public key`);
  return keyLine;
}

/** @param {string} root @param {string} name */
function findArtifact(root, name) {
  const stack = [root];
  const found = [];
  while (stack.length) {
    const dir = /** @type {string} */ (stack.pop());
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name === name) found.push(full);
    }
  }
  if (found.length !== 1) throw new Error(`expected exactly one updater artifact named ${name} under ${root}, found ${found.length}`);
  return /** @type {string} */ (found[0]);
}

/**
 * @param {{ artifactPath: string; signatureFile: string; publicKey: string }} params
 */
function verifyWithMinisign({ artifactPath, signatureFile, publicKey }) {
  execFileSync('minisign', ['-V', '-q', '-P', publicKey, '-m', artifactPath, '-x', signatureFile], { stdio: ['ignore', 'ignore', 'pipe'] });
}

/**
 * @param {{
 *   latestJsonPath: string;
 *   artifactsDir: string;
 *   publicKey: string;
 *   verify?: typeof verifyWithMinisign;
 * }} params
 */
export function verifyUpdaterManifestSignatures({ latestJsonPath, artifactsDir, publicKey, verify = verifyWithMinisign }) {
  const manifest = JSON.parse(fs.readFileSync(latestJsonPath, 'utf8'));
  const platforms = Object.entries(manifest?.platforms ?? {});
  if (platforms.length === 0) throw new Error(`${latestJsonPath} lists no platforms`);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-updater-verify-'));
  try {
    return platforms.map(([platform, entry]) => {
      const name = decodeURIComponent(String(/** @type {{ url?: string }} */ (entry)?.url ?? '').split('/').pop() ?? '');
      if (!name) throw new Error(`latest.json ${platform} has no artifact url`);
      const artifactPath = findArtifact(artifactsDir, name);
      const signatureFile = path.join(scratch, `${platform}.minisig`);
      fs.writeFileSync(signatureFile, Buffer.from(String(/** @type {{ signature?: string }} */ (entry)?.signature ?? ''), 'base64'));
      try {
        verify({ artifactPath, signatureFile, publicKey });
      } catch (error) {
        const detail = String(/** @type {{ stderr?: unknown }} */ (error)?.stderr ?? (error instanceof Error ? error.message : error)).trim();
        throw new Error(`latest.json ${platform}: the updater would reject ${name} (signature does not verify with the configured key)${detail ? `: ${detail}` : ''}`);
      }
      return { platform, artifact: name };
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function main() {
  const { values } = parseArgs({
    options: {
      environment: { type: 'string' },
      'latest-json': { type: 'string', default: 'dist/tauri/publish/latest.json' },
      'artifacts-dir': { type: 'string', default: 'dist/tauri/updates' },
      'tauri-dir': { type: 'string', default: 'apps/ui/src-tauri' },
    },
    allowPositionals: false,
  });
  const ring = normalizePublicReleaseChannel(String(values.environment ?? '').trim());
  if (!ring) throw new Error(`--environment must be dev|preview|production (got: ${values.environment ?? '<empty>'})`);
  const environment = ring === 'stable' ? 'production' : ring;
  const verified = verifyUpdaterManifestSignatures({
    latestJsonPath: path.resolve(String(values['latest-json'])),
    artifactsDir: path.resolve(String(values['artifacts-dir'])),
    publicKey: readUpdaterPublicKey({ tauriDir: path.resolve(String(values['tauri-dir'])), environment }),
  });
  console.log(`[pipeline] latest.json updater signatures verified (${environment}): ${verified.map((entry) => entry.platform).join(', ')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
