#!/usr/bin/env node

// @ts-check

import { createReadStream, existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { fileSha256, parseArtifactChecksums } from './lib/artifact-checksums.mjs';
import { parseArtifactFilename } from './lib/manifests.mjs';
import { parseArgs } from './lib/release-script-arguments.mjs';
import { shouldSmokeTestReleaseArtifact } from './publishing/artifact-smoke-compatibility.mjs';
import { terminateProcessTreeByPid } from '../../testing/process/processTree.mjs';

const DEFAULT_BINARY_SMOKE_TIMEOUT_MS = 20_000;
const DEFAULT_SERVER_BINARY_SMOKE_TIMEOUT_MS = 15_000;
const PRIVACY_SCAN_OVERLAP_BYTES = 4_096;
const UTF16_DECODERS = Object.freeze([
  new TextDecoder('utf-16le'),
  new TextDecoder('utf-16be'),
]);
const CANONICAL_DIRECTORY_MODES = new Set([0o755]);
const CANONICAL_NATIVE_FILE_MODES = new Set([0o644, 0o755]);
const CANONICAL_UI_WEB_FILE_MODES = new Set([0o644]);
const RELEASE_ARCHIVE_NAME_PATTERN =
  /^(?<stem>(?<product>happier-ui-web|happier-server|happier|hstack)-v.+-(?<platform>darwin|linux|windows|web)-(?<arch>x64|arm64|any))\.tar\.gz$/u;
// These are deliberately bounded, high-confidence ASCII signatures. Generic
// words such as "token" or "private key", public certificates, and entropy
// heuristics are excluded to keep binaries and license text admissible.
const PRIVACY_RULES = Object.freeze([
  Object.freeze({
    id: 'private-key',
    pattern:
      /-----BEGIN (?:(?:RSA|DSA|EC|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----|-----BEGIN PGP PRIVATE KEY BLOCK-----/u,
  }),
  Object.freeze({
    id: 'credential-token',
    pattern:
      /(?:github_pat_[A-Za-z0-9_]{22,255}|gh[pousr]_[A-Za-z0-9]{36,255}|sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,200}|sk-ant-[A-Za-z0-9_-]{32,200}|sk_(?:live|test)_[A-Za-z0-9]{24,200}|xox[baprs]-[A-Za-z0-9-]{20,200}|AIza[0-9A-Za-z_-]{35})/u,
  }),
  Object.freeze({
    id: 'absolute-user-path',
    pattern:
      /(?:\/(?:Users|home)\/[A-Za-z0-9._-]{1,64}\/(?:[A-Za-z0-9._ -]{1,64}\/){0,6}(?:work|workspace|src|source|repos|projects|Development|build)\/[A-Za-z0-9._~+@%/ -]{1,512}|[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][A-Za-z0-9._ -]{1,64}[\\/](?:[A-Za-z0-9._ -]{1,64}[\\/]){0,6}(?:work|workspace|src|source|repos|projects|Development|build)[\\/][A-Za-z0-9._~+@%\\/ -]{1,512})/iu,
  }),
  Object.freeze({
    id: 'absolute-build-path',
    pattern:
      /(?:\/(?:__w|workspace|builds)\/[A-Za-z0-9._~+@%/-]{2,512}|[A-Za-z]:[\\/](?:a|agent|build|workspace)[\\/][A-Za-z0-9._~+@%\\/ -]{2,512})/iu,
  }),
]);

class ReleaseArchiveAdmissionError extends Error {}

/**
 * @typedef {'ui-web' | 'native-binary'} ReleaseArchiveFamily
 * @typedef {{
 *   stem: string;
 *   product: string;
 *   family: ReleaseArchiveFamily;
 * }} ReleaseArchiveIdentity
 * @typedef {import('@happier-dev/release-runtime/archiveExtraction').InspectedTarArchiveEntry} InspectedTarArchiveEntry
 */

/**
 * @param {string} archiveName
 * @returns {ReleaseArchiveIdentity | null}
 */
function parseReleaseArchiveIdentity(archiveName) {
  const match = RELEASE_ARCHIVE_NAME_PATTERN.exec(String(archiveName ?? ''));
  if (!match?.groups) return null;
  const { stem, product, platform, arch } = match.groups;
  const uiWeb = product === 'happier-ui-web';
  if (uiWeb !== (platform === 'web' && arch === 'any')) return null;
  if (!uiWeb && (platform === 'web' || arch === 'any')) return null;
  return {
    stem,
    product,
    family: uiWeb ? 'ui-web' : 'native-binary',
  };
}

/** @param {Buffer} bytes */
function detectPrivacyRule(bytes) {
  const searchViews = [bytes.toString('latin1')];
  for (const decoder of UTF16_DECODERS) {
    for (const offset of [0, 1]) {
      const availableBytes = bytes.length - offset;
      const evenLength = availableBytes - (availableBytes % 2);
      if (evenLength <= 0) continue;
      searchViews.push(decoder.decode(bytes.subarray(offset, offset + evenLength)));
    }
  }
  for (const searchable of searchViews) {
    const matchedRule = PRIVACY_RULES.find((rule) => rule.pattern.test(searchable));
    if (matchedRule) return matchedRule;
  }
  return null;
}

/** @param {Buffer} bytes */
function assertPrivacySafe(bytes) {
  const matchedRule = detectPrivacyRule(bytes);
  if (!matchedRule) return;
  throw new ReleaseArchiveAdmissionError(
    `[release] archive privacy admission failed (${matchedRule.id})`,
  );
}

/** @param {string} path */
async function scanFileForPrivateMaterial(path) {
  let overlap = Buffer.alloc(0);
  for await (const rawChunk of createReadStream(path)) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    const window = overlap.length > 0 ? Buffer.concat([overlap, chunk]) : chunk;
    assertPrivacySafe(window);
    overlap = Buffer.from(window.subarray(Math.max(0, window.length - PRIVACY_SCAN_OVERLAP_BYTES)));
  }
}

/**
 * @param {{
 *   archiveName: string;
 *   identity: ReleaseArchiveIdentity;
 *   entries: readonly InspectedTarArchiveEntry[];
 * }} params
 */
function assertCanonicalArchiveLayout({ archiveName, identity, entries }) {
  if (entries.length === 0) {
    throw new ReleaseArchiveAdmissionError(`[release] archive payload is empty for ${archiveName}`);
  }

  const roots = new Set(entries.map((entry) => entry.path.split('/')[0]));
  const rootEntry = entries.find((entry) => entry.path === identity.stem);
  if (roots.size !== 1 || !roots.has(identity.stem) || rootEntry?.kind !== 'directory') {
    throw new ReleaseArchiveAdmissionError(
      `[release] archive payload root does not match its artifact name for ${archiveName}`,
    );
  }

  const explicitDirectories = new Set(
    entries.filter((entry) => entry.kind === 'directory').map((entry) => entry.path),
  );
  for (const entry of entries) {
    assertPrivacySafe(Buffer.from(entry.path, 'utf-8'));
    const segments = entry.path.split('/');
    for (let segmentCount = 1; segmentCount < segments.length; segmentCount += 1) {
      const parentPath = segments.slice(0, segmentCount).join('/');
      if (!explicitDirectories.has(parentPath)) {
        throw new ReleaseArchiveAdmissionError(
          `[release] archive entry is missing an explicit parent directory for ${archiveName}`,
        );
      }
    }
    // The portable node-tar producer omits owner fields, while GNU/bsdtar writes
    // the canonical numeric root owner. Both encodings are producer-owned.
    if ((entry.uid !== null && entry.uid !== 0) || (entry.gid !== null && entry.gid !== 0)) {
      throw new ReleaseArchiveAdmissionError(
        `[release] archive metadata admission failed (non-canonical-owner) for ${archiveName}`,
      );
    }

    const permittedModes = entry.kind === 'directory'
      ? CANONICAL_DIRECTORY_MODES
      : identity.family === 'ui-web'
        ? CANONICAL_UI_WEB_FILE_MODES
        : CANONICAL_NATIVE_FILE_MODES;
    if (entry.mode === null || !permittedModes.has(entry.mode & 0o7777)) {
      throw new ReleaseArchiveAdmissionError(
        `[release] archive metadata admission failed (non-canonical-mode) for ${archiveName}`,
      );
    }
  }
}

/** @param {{ archivePath: string; archiveName: string }} params */
export async function verifyReleaseArchiveAdmission({ archivePath, archiveName }) {
  const {
    extractArchivePayloadToDirectory,
    inspectTarArchiveEntries,
  } = await import('@happier-dev/release-runtime/archiveExtraction');
  const identity = parseReleaseArchiveIdentity(archiveName);
  if (!identity) {
    throw new ReleaseArchiveAdmissionError(
      `[release] unsupported release archive family: ${archiveName}`,
    );
  }

  let entries;
  try {
    entries = await inspectTarArchiveEntries({ archivePath });
  } catch {
    throw new ReleaseArchiveAdmissionError(
      `[release] archive topology admission failed for ${archiveName}`,
    );
  }
  assertCanonicalArchiveLayout({ archiveName, identity, entries });

  const scratch = await mkdtemp(join(tmpdir(), 'happier-release-admission-'));
  try {
    try {
      await extractArchivePayloadToDirectory({
        archivePath,
        archiveName,
        extractDir: scratch,
      });
    } catch {
      throw new ReleaseArchiveAdmissionError(
        `[release] archive extraction admission failed for ${archiveName}`,
      );
    }
    for (const entry of entries) {
      if (entry.kind !== 'file') continue;
      await scanFileForPrivateMaterial(join(scratch, ...entry.path.split('/')));
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return entries;
}

/** @param {string} name */
function assertChecksummedArtifactNameSafe(name) {
  const value = String(name ?? '');
  if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\') || basename(value) !== value) {
    throw new Error('[release] checksum manifest contains an unsafe artifact name');
  }
}

function isServerBinaryCandidate(candidate) {
  return String(candidate ?? '').startsWith('happier-server');
}

function formatSmokeOutput(result) {
  const stdout = String(result?.stdout ?? '').trim();
  const stderr = String(result?.stderr ?? '').trim();
  return [stdout, stderr].filter(Boolean).join('\n');
}

function readTimeoutOverride(rawValue, fallbackMs) {
  const parsed = Number.parseInt(String(rawValue ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallbackMs;
}

function resolveArtifactSmokeTimeoutMs({ serverBinary }) {
  return serverBinary
    ? readTimeoutOverride(process.env.HAPPIER_RELEASE_SERVER_SMOKE_TIMEOUT_MS, DEFAULT_SERVER_BINARY_SMOKE_TIMEOUT_MS)
    : readTimeoutOverride(process.env.HAPPIER_RELEASE_BINARY_SMOKE_TIMEOUT_MS, DEFAULT_BINARY_SMOKE_TIMEOUT_MS);
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{
 *   cwd?: string;
 *   stdio?: 'inherit' | 'ignore' | 'pipe';
 *   missingCommandMessage?: string;
 * }} [options]
 */
function runCheckedCommand(
  command,
  args,
  { cwd = process.cwd(), stdio = 'inherit', missingCommandMessage } = {},
) {
  const result = spawnSync(command, args, {
    cwd,
    stdio,
    encoding: 'utf-8',
  });
  if (result.error) {
    const code = result.error && typeof result.error === 'object' && 'code' in result.error
      ? String(result.error.code ?? '')
      : '';
    if (code === 'ENOENT' && missingCommandMessage) {
      throw new Error(missingCommandMessage);
    }
    throw result.error;
  }
  if ((result.status ?? 1) !== 0) {
    const output = [String(result.stdout ?? '').trim(), String(result.stderr ?? '').trim()]
      .filter(Boolean)
      .join('\n');
    throw new Error(
      `[release] ${command} exited with status ${result.status ?? 1}${output ? `: ${output}` : ''}`,
    );
  }
}

async function runSmokeCommand({ command, args, cwd, env, timeoutMs }) {
  return await new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    child.stdout?.setEncoding('utf-8');
    child.stderr?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });

    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };

    child.on('error', (error) => {
      settle({
        status: null,
        signal: null,
        error,
        timedOut,
        stdout,
        stderr,
      });
    });

    child.on('close', (code, signal) => {
      settle({
        status: code,
        signal,
        error: null,
        timedOut,
        stdout,
        stderr,
      });
    });

    const timer = setTimeout(() => {
      timedOut = true;
      const childPid = child.pid;
      if (typeof childPid === 'number' && childPid > 0) {
        void terminateProcessTreeByPid(childPid, {
          graceMs: 250,
          pollMs: 25,
          skipAliveCheck: true,
        })
          .catch(() => {})
          .finally(() => {
            settle({
              status: null,
              signal: null,
              error: null,
              timedOut,
              stdout,
              stderr,
            });
          });
        return;
      }
      settle({
        status: null,
        signal: null,
        error: null,
        timedOut,
        stdout,
        stderr,
      });
    }, timeoutMs);
  });
}

async function smokeTestArchive({ archivePath }) {
  const artifact = parseArtifactFilename(basename(archivePath));
  const {
    extractArchivePayloadToDirectory,
  } = await import('@happier-dev/release-runtime/archiveExtraction');
  const scratch = await mkdtemp(join(tmpdir(), 'happier-release-smoke-'));
  try {
    await extractArchivePayloadToDirectory({
      archivePath,
      archiveName: basename(archivePath),
      extractDir: scratch,
    });
    const roots = await readdir(scratch);
    if (roots.length === 0) {
      throw new Error(`[release] extracted archive is empty: ${archivePath}`);
    }
    const root = join(scratch, roots[0]);
    const entries = await readdir(root, { withFileTypes: true });
    const candidate = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .find((name) => !name.endsWith('.txt') && !name.endsWith('.json'));
    if (!candidate) {
      throw new Error(`[release] no executable found in archive: ${archivePath}`);
    }
    if (candidate.endsWith('.exe') && process.platform !== 'win32') {
      return;
    }
    const binPath = join(root, candidate);
    const serverBinary = isServerBinaryCandidate(candidate);
    const args = serverBinary ? [] : ['--version'];
    const env = serverBinary
      ? {
          ...process.env,
          PORT: '0',
          METRICS_PORT: '0',
          HAPPIER_SERVER_LIGHT_DATA_DIR: join(scratch, 'server-light-data'),
        }
      : process.env;
    const result = await runSmokeCommand({
      command: binPath,
      args,
      cwd: root,
      env,
      timeoutMs: resolveArtifactSmokeTimeoutMs({ serverBinary }),
    });
    const timedOut = result.timedOut === true;
    if (timedOut) {
      const output = formatSmokeOutput(result);
      if (artifact?.product === 'happier') {
        throw new Error(`[release] smoke test timed out for ${archivePath}: ${output.trim()}`);
      }
      if (serverBinary) {
        if (/ERR_MODULE_NOT_FOUND|Cannot find module/i.test(output)) {
          throw new Error(`[release] smoke test failed for ${archivePath}: ${output.trim()}`);
        }
        return;
      }
      if (/version/i.test(output)) {
        return;
      }
      throw new Error(`[release] smoke test timed out for ${archivePath}: ${output.trim()}`);
    }
    if ((result.status ?? 1) !== 0) {
      throw new Error(`[release] smoke test failed for ${archivePath}: ${formatSmokeOutput(result)}`);
    }
    if (artifact?.product === 'happier') {
      const actualVersion = String(result.stdout ?? '').trim();
      if (actualVersion !== artifact.version) {
        throw new Error(
          `[release] CLI version mismatch for ${archivePath}: expected ${artifact.version}, got ${actualVersion || '<empty>'}`,
        );
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function main() {
  const { kv, flags } = parseArgs(process.argv.slice(2));
  const artifactsDir = resolve(String(kv.get('--artifacts-dir') ?? '').trim() || join(process.cwd(), 'dist', 'release-assets'));
  const checksumsPathInput = String(kv.get('--checksums') ?? '').trim();
  const checksumsPath = checksumsPathInput || (await readdir(artifactsDir).catch((error) => {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code ?? '') : '';
    if (code === 'ENOENT') return [];
    throw error;
  }))
    .filter((name) => name.startsWith('checksums-') && name.endsWith('.txt'))
    .sort((left, right) => left.localeCompare(right))
    .map((name) => join(artifactsDir, name))[0];
  if (!checksumsPath) {
    throw new Error(`[release] no checksums file found in ${artifactsDir}`);
  }

  const checksumsRaw = await readFile(checksumsPath, 'utf-8');
  const entries = parseArtifactChecksums(checksumsRaw);
  for (const entry of entries) {
    assertChecksummedArtifactNameSafe(entry.name);
  }
  if (flags.has('--require-all-archives-checksummed')) {
    const checksummedArchives = entries
      .map((entry) => entry.name)
      .filter((name) => name.endsWith('.tar.gz'))
      .sort((left, right) => left.localeCompare(right));
    const presentArchives = (await readdir(artifactsDir))
      .filter((name) => name.endsWith('.tar.gz'))
      .sort((left, right) => left.localeCompare(right));
    if (
      checksummedArchives.length !== presentArchives.length
      || checksummedArchives.some((name, index) => name !== presentArchives[index])
    ) {
      throw new Error('[release] archive set does not match the checksum manifest');
    }
  }
  if (flags.has('--require-all-artifacts-checksummed')) {
    const checksumName = basename(checksumsPath);
    const signatureName = `${checksumName}.minisig`;
    const checksummedArtifacts = entries
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
    const presentArtifacts = (await readdir(artifactsDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name !== checksumName && entry.name !== signatureName)
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
    if (
      checksummedArtifacts.length !== presentArtifacts.length
      || checksummedArtifacts.some((name, index) => name !== presentArtifacts[index])
    ) {
      throw new Error('[release] artifact set does not match the checksum manifest');
    }
  }
  for (const entry of entries) {
    const path = join(artifactsDir, entry.name);
    const hash = await fileSha256(path);
    if (hash !== entry.sha256) {
      throw new Error(`[release] checksum mismatch for ${entry.name}`);
    }
  }

  const minisigPath = `${checksumsPath}.minisig`;
  const pubKeyPath = String(kv.get('--public-key') ?? process.env.MINISIGN_PUBLIC_KEY ?? '').trim();
  if (flags.has('--require-signature') && !existsSync(minisigPath)) {
    throw new Error('[release] required checksum signature is missing');
  }
  if (existsSync(minisigPath)) {
    if (!pubKeyPath) {
      throw new Error('[release] signature found but no --public-key/MINISIGN_PUBLIC_KEY provided');
    }
    runCheckedCommand(
      'minisign',
      ['-Vm', checksumsPath, '-p', pubKeyPath],
      {
        stdio: 'inherit',
        missingCommandMessage: '[release] minisign required to verify signatures',
      },
    );
  }

  if (!flags.has('--skip-archive-admission')) {
    for (const entry of entries) {
      if (!entry.name.endsWith('.tar.gz')) continue;
      await verifyReleaseArchiveAdmission({
        archivePath: join(artifactsDir, entry.name),
        archiveName: entry.name,
      });
    }
  }

  const skipOptionalSmoke = flags.has('--skip-smoke');
  const cliVersionAttestations = [];
  for (const entry of entries) {
    if (!entry.name.endsWith('.tar.gz')) continue;
    if (!shouldSmokeTestReleaseArtifact({ archiveName: entry.name })) continue;
    const artifact = parseArtifactFilename(entry.name);
    const requiresCliVersionAttestation = artifact?.product === 'happier';
    if (skipOptionalSmoke && !requiresCliVersionAttestation) continue;
    await smokeTestArchive({ archivePath: join(artifactsDir, entry.name) });
    if (requiresCliVersionAttestation) cliVersionAttestations.push(entry.name);
  }

  console.log(JSON.stringify({
    ok: true,
    artifactsDir,
    checksumsPath,
    verified: entries.map((entry) => entry.name),
    smoke: !skipOptionalSmoke,
    cliVersionAttestations,
  }, null, 2));
}

const isMain =
  process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
