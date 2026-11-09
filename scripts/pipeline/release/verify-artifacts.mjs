#!/usr/bin/env node

// @ts-check

import { createReadStream, existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolveReleaseAssetBundle } from '@happier-dev/release-runtime/assets';
import { lookupSha256 } from '@happier-dev/release-runtime/checksums';
import { verifyMinisign } from '@happier-dev/release-runtime/minisign';

import { fileSha256, parseArtifactChecksums } from './lib/artifact-checksums.mjs';
import { parseArtifactFilename } from './lib/manifests.mjs';
import { parseArgs } from './lib/release-script-arguments.mjs';
import { isRunnerTargetEligibleForPublication, resolveRunnerPackageLayout, verifyWindowsRunnerPayload } from './lib/runner-packaging.mjs';
import { readDarwinAppBundleNotarizationEvidence, verifyDarwinAppBundleNotarizationEvidence } from './notarize-standalone-binary.mjs';
import { resolveArchiveSymlinkTargets } from '@happier-dev/release-runtime/archiveSymlinkContainment';
import { shouldSmokeTestReleaseArtifact } from './publishing/artifact-smoke-compatibility.mjs';
import { CLI_OPTIONAL_COMPONENT_PRODUCTS } from './publishing/product-specs.mjs';
import { terminateProcessTreeByPid } from '../../testing/process/processTree.mjs';
import { createBaseCliRuntimeSmokeSource } from './base-cli-runtime-smoke.mjs';

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
const RELEASE_ARCHIVE_NAME_PATTERN = new RegExp(
  `^(?<stem>(?<product>happier-ui-web|happier-server|happier-runner|${CLI_OPTIONAL_COMPONENT_PRODUCTS.join('|')}|happier|hstack)-v.+-(?<platform>darwin|linux|windows|web)-(?<arch>x64|arm64|any))\\.(?:tar\\.gz|zip)$`,
  'u',
);
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
 *   platform: string;
 *   arch: string;
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
    platform,
    arch,
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

async function readRunnerClosedZipLayout({ archivePath, archiveName, layout, signal, macOSNotarizationOutput }) {
  const {
    inspectClosedZipArchiveEntries,
  } = await import('@happier-dev/release-runtime/archiveExtraction');
  const archive = await lstat(archivePath);
  if (!archive.isFile() || archive.isSymbolicLink() || archive.size < 1) {
    throw new ReleaseArchiveAdmissionError(
      `[release] Runner archive source is invalid: ${archiveName}`,
    );
  }
  if (layout.payloadKind === 'app-bundle') {
    // Reuse the notarization owner's census of the exact post-staple tree;
    // the ZIP also carries its enclosing app directory. No archive-size or
    // entry-count estimate stands in for that existing evidence.
    const evidence = readDarwinAppBundleNotarizationEvidence({
      payloadName: layout.payloadRootName, evidencePath: macOSNotarizationOutput,
    });
    const entries = await inspectClosedZipArchiveEntries({
      archivePath, archiveSizeBytes: archive.size, expectedEntryCount: evidence.entryCount + 1,
      allowedEntryRoots: [layout.payloadRootName], signal,
    });
    const requiredFiles = [
      layout.executablePath,
      `${layout.payloadRootName}/Contents/MacOS/happier-runner-core`,
      `${layout.payloadRootName}/Contents/Info.plist`,
      `${layout.payloadRootName}/Contents/_CodeSignature/CodeResources`,
    ];
    if (!entries.some(entry => entry.path === layout.payloadRootName && entry.kind === 'directory')
      || !requiredFiles.every(path => entries.some(entry => entry.path === path && entry.kind === 'file'))
      || entries.some(entry => entry.kind === 'directory' ? entry.mode !== 0o755
        : entry.kind === 'symlink' ? entry.mode !== 0o777
          : !CANONICAL_NATIVE_FILE_MODES.has(entry.mode))
      || !entries.some(entry => entry.path === layout.executablePath && entry.mode === 0o755)
      || !entries.some(entry => entry.path === requiredFiles[1] && entry.mode === 0o755)) {
      throw new ReleaseArchiveAdmissionError(`[release] Runner app bundle layout or metadata is invalid: ${archiveName}`);
    }
    return { archiveSizeBytes: archive.size, entries };
  }
  // The payload's own closed entry set: one executable file, or the portable
  // directory root with exactly the shell executable and the core sidecar the
  // shell resolves beside it. Nothing else may be present, renamed or missing.
  const sidecarPath = layout.sidecarPath;
  const expectedEntries = sidecarPath
    ? [
        { path: layout.payloadRootName, kind: 'directory' },
        { path: layout.executablePath, kind: 'file' },
        { path: sidecarPath, kind: 'file' },
      ]
    : [{ path: layout.executablePath, kind: 'file' }];
  // The exact-path check below is stricter than root containment, so the
  // shared extractor must not pre-empt the Runner-specific admission message.
  const entries = await inspectClosedZipArchiveEntries({
    archivePath,
    archiveSizeBytes: archive.size,
    expectedEntryCount: expectedEntries.length,
    signal,
  });
  const admitted = entries.length === expectedEntries.length
    && expectedEntries.every(({ path, kind }) => entries.some((entry) =>
      entry.path === path && entry.kind === kind && entry.mode === 0o755));
  if (!admitted) {
    throw new ReleaseArchiveAdmissionError(
      sidecarPath
        ? `[release] Runner archive must contain exactly the ${layout.payloadRootName} payload directory`
          + ` with ${basename(layout.executablePath)} and ${basename(sidecarPath)}: ${archiveName}`
        : `[release] Runner archive must contain exactly one ${layout.payloadRootName} executable payload: ${archiveName}`,
    );
  }
  return { archiveSizeBytes: archive.size, entries };
}

/** Validate a built Runner candidate; publication separately requires target eligibility. */
export async function verifyRunnerArchiveAdmission({ archivePath, archiveName, signal, ...nativeTrust }) {
  const { extractArchivePayloadToDirectory } = await import('@happier-dev/release-runtime/archiveExtraction');
  const identity = parseReleaseArchiveIdentity(archiveName);
  if (identity?.product !== 'happier-runner' || !archiveName.endsWith('.zip')) {
    throw new ReleaseArchiveAdmissionError(`[release] unsupported Runner archive: ${archiveName}`);
  }
  const targetId = `${identity.platform}-${identity.arch}`;
  const layout = resolveRunnerPackageLayout(targetId);
  const scratch = await mkdtemp(join(tmpdir(), 'happier-runner-release-admission-'));
  try {
    const closedZipLayout = await readRunnerClosedZipLayout({
      archivePath, archiveName, layout, signal, macOSNotarizationOutput: nativeTrust.macOSNotarizationOutput,
    });
    await extractArchivePayloadToDirectory({ archivePath, archiveName, closedZipLayout, extractDir: scratch, signal });
    const names = await readdir(scratch);
    if (names.length !== 1 || names[0] !== layout.payloadRootName) {
      throw new ReleaseArchiveAdmissionError(
        `[release] Runner archive must contain exactly one ${layout.payloadRootName} payload: ${archiveName}`,
      );
    }
    const entries = await Promise.all(closedZipLayout.entries.map(async ({ path, kind, sizeBytes, mode }) => {
      assertPrivacySafe(Buffer.from(path, 'utf8'));
      if (kind === 'file') await scanFileForPrivateMaterial(join(scratch, path));
      return { path, kind, sizeBytes, mode, ...(kind === 'symlink' ? { linkTarget: await readlink(join(scratch, path)) } : {}) };
    }));
    if (layout.payloadKind === 'app-bundle') {
      const targets = new Map(entries.filter(entry => entry.kind === 'symlink').map(entry => [entry.path, entry.linkTarget]));
      for (const target of resolveArchiveSymlinkTargets(targets).values()) {
        if (target !== layout.payloadRootName && !target.startsWith(`${layout.payloadRootName}/`)) {
          throw new ReleaseArchiveAdmissionError(`[release] Runner app bundle symlink leaves the bundle: ${archiveName}`);
        }
      }
      verifyDarwinAppBundleNotarizationEvidence({
        bundlePath: join(scratch, layout.payloadRootName), evidencePath: nativeTrust.macOSNotarizationOutput,
        runCommand: nativeTrust.runCommand,
      });
    } else if (layout.sidecarPath) {
      await verifyWindowsRunnerPayload({
        payloadPath: join(scratch, layout.payloadRootName), windowsSigningIdentity: nativeTrust.windowsSigningIdentity,
        platform: nativeTrust.platform, runCommand: nativeTrust.runCommand,
      });
    } else {
      const executable = await lstat(join(scratch, layout.executablePath));
      if (!executable.isFile() || (executable.mode & 0o7777) !== 0o755) {
        throw new ReleaseArchiveAdmissionError(
          `[release] Runner archive executable metadata is invalid: ${archiveName}`,
        );
      }
    }
    return entries;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** @param {{ archivePath: string; archiveName: string; signal?: AbortSignal }} params */
export async function verifyReleaseArchiveAdmission({ archivePath, archiveName, signal, ...nativeTrust }) {
  const { extractArchivePayloadToDirectory, inspectTarArchiveEntries } = await import('@happier-dev/release-runtime/archiveExtraction');
  const identity = parseReleaseArchiveIdentity(archiveName);
  if (!identity) throw new ReleaseArchiveAdmissionError(`[release] unsupported release archive family: ${archiveName}`);
  if (identity.product === 'happier-runner') {
    if (!archiveName.endsWith('.zip') || !isRunnerTargetEligibleForPublication(`${identity.platform}-${identity.arch}`)) {
      throw new ReleaseArchiveAdmissionError(`[release] Runner target is not eligible for publication: ${archiveName}`);
    }
    return verifyRunnerArchiveAdmission({ archivePath, archiveName, signal, ...nativeTrust });
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


async function assertPathsAbsent(paths, message) {
  const present = (await Promise.all(paths.map(async (path) => {
    try {
      await stat(path);
      return path;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }))).filter(Boolean);
  if (present.length > 0) throw new Error(`${message}: ${present.join(', ')}`);
}

async function assertBaseCliProjection({ root, targetOs, targetArch }) {
  await assertPathsAbsent(
    [
      join(root, 'node_modules', '@huggingface', 'transformers'),
      join(root, 'node_modules', 'sherpa-onnx-node'),
      ...['darwin', 'linux', 'win'].flatMap((os) => ['arm64', 'x64'].map((arch) => join(root, 'node_modules', `sherpa-onnx-${os}-${arch}`))),
      join(root, 'tools', 'archives', `voice-inference-runtime-${targetOs}-${targetArch}.tar.gz`),
      join(root, 'scripts', 'runtime', 'loadVoiceInferenceRuntime.mjs'),
    ],
    'optional inference runtime survived base CLI projection',
  );
  await assertPathsAbsent(
    [join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk')],
    'unused Claude Agent SDK survived projection',
  );
  await assertPathsAbsent(
    [join(root, 'tools', 'unpacked', 'ripgrep.node')],
    'unused ripgrep native addon survived projection',
  );
  if (targetOs === 'windows') {
    await assertPathsAbsent(
      [
        join(root, 'tools', 'unpacked', 'zellij'),
        join(root, 'tools', 'unpacked', 'zellij.exe'),
      ],
      'zellij survived Windows base CLI projection',
    );
    return;
  }
  const ptyRoots = [
    join(root, 'node_modules', 'node-pty'),
    join(root, 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch'),
  ];
  await assertPathsAbsent(
    ptyRoots.flatMap((packageRoot) => ['third_party/conpty', 'deps/winpty', 'src/win']
      .map((relativePath) => join(packageRoot, relativePath))),
    'Windows-only PTY input survived non-Windows projection',
  );
}

async function verifyChecksumSignature({ checksumsPath, pubkeyFile }) {
  const message = await readFile(checksumsPath);
  const sigFile = await readFile(`${checksumsPath}.minisig`, 'utf8');
  if (!verifyMinisign({ message, sigFile, pubkeyFile })) {
    throw new Error(`[release] signature verification failed for ${checksumsPath}`);
  }
  return message.toString('utf8');
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

async function runBaseCliRuntimeSmoke({ root, scratch, artifact, archivePath, env }) {
  const timeoutMs = resolveArtifactSmokeTimeoutMs({ serverBinary: false });
  // Version dispatch can succeed before the command catalog and its packaged
  // metadata load. Exercise that native startup path before accepting a CLI.
  const nativeHelp = await runSmokeCommand({
    command: join(root, artifact.os === 'windows' ? 'happier.exe' : 'happier'),
    args: ['--help'],
    cwd: root,
    env,
    timeoutMs,
  });
  if (nativeHelp.timedOut === true) {
    throw new Error(`[release] native CLI help smoke timed out for ${archivePath}: ${formatSmokeOutput(nativeHelp)}`);
  }
  if ((nativeHelp.status ?? 1) !== 0) {
    throw new Error(`[release] native CLI help smoke failed for ${archivePath}: ${formatSmokeOutput(nativeHelp)}`);
  }
  const packageDistEntrypoint = join(root, 'package-dist', 'index.mjs');
  try {
    if (!(await stat(packageDistEntrypoint)).isFile()) {
      throw new Error(`[release] missing base CLI package-dist entrypoint in ${archivePath}`);
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`[release] missing base CLI package-dist entrypoint in ${archivePath}`);
    }
    throw error;
  }
  const packageDistVersion = await runSmokeCommand({
    command: process.execPath,
    args: [packageDistEntrypoint, '--version'],
    cwd: root,
    env,
    timeoutMs,
  });
  if (packageDistVersion.timedOut === true) {
    throw new Error(`[release] package-dist version smoke timed out for ${archivePath}: ${formatSmokeOutput(packageDistVersion)}`);
  }
  if ((packageDistVersion.status ?? 1) !== 0) {
    throw new Error(`[release] package-dist version smoke failed for ${archivePath}: ${formatSmokeOutput(packageDistVersion)}`);
  }
  const actualPackageDistVersion = String(packageDistVersion.stdout ?? '').trim();
  if (actualPackageDistVersion !== artifact.version) {
    throw new Error(
      `[release] package-dist version mismatch for ${archivePath}: expected ${artifact.version}, got ${actualPackageDistVersion || '<empty>'}`,
    );
  }

  const runRequiredTool = async ({ label, command, args, expectedOutput }) => {
    try {
      if (!(await stat(command)).isFile()) {
        throw new Error(`[release] missing packaged ${label} in ${archivePath}`);
      }
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(`[release] missing packaged ${label} in ${archivePath}`);
      }
      throw error;
    }
    const result = await runSmokeCommand({ command, args, cwd: root, env, timeoutMs });
    if (result.timedOut === true) {
      throw new Error(`[release] packaged ${label} smoke timed out for ${archivePath}: ${formatSmokeOutput(result)}`);
    }
    if ((result.status ?? 1) !== 0) {
      throw new Error(`[release] packaged ${label} smoke failed for ${archivePath}: ${formatSmokeOutput(result)}`);
    }
    const output = formatSmokeOutput(result);
    if (!output.includes(expectedOutput)) {
      throw new Error(`[release] packaged ${label} smoke returned unexpected output for ${archivePath}: ${output || '<empty>'}`);
    }
  };

  const rgPath = join(root, 'tools', 'unpacked', artifact.os === 'windows' ? 'rg.exe' : 'rg');
  await runRequiredTool({
    label: 'rg --version',
    command: rgPath,
    args: ['--version'],
    expectedOutput: 'ripgrep',
  });
  const rgNeedle = 'happier-release-rg-smoke';
  const rgFixturePath = join(scratch, 'rg-smoke.txt');
  await writeFile(rgFixturePath, `${rgNeedle}\n`);
  await runRequiredTool({
    label: 'rg search',
    command: rgPath,
    args: ['--fixed-strings', rgNeedle, rgFixturePath],
    expectedOutput: rgNeedle,
  });
  if (artifact.os !== 'windows') {
    await runRequiredTool({
      label: 'zellij --version',
      command: join(root, 'tools', 'unpacked', 'zellij'),
      args: ['--version'],
      expectedOutput: 'zellij',
    });
  }

  const runtime = await runSmokeCommand({
    command: process.execPath,
    args: [
      '--input-type=module',
      '-e',
      createBaseCliRuntimeSmokeSource({ root, targetOs: artifact.os }),
    ],
    cwd: root,
    env,
    timeoutMs,
  });
  if (runtime.timedOut === true) {
    throw new Error(`[release] base CLI runtime smoke timed out for ${archivePath}: ${formatSmokeOutput(runtime)}`);
  }
  if ((runtime.status ?? 1) !== 0) {
    throw new Error(`[release] base CLI runtime smoke failed for ${archivePath}: ${formatSmokeOutput(runtime)}`);
  }
}

export async function smokeTestArchive({ archivePath, signal, execute = true, macOSNotarizationOutput }) {
  const artifact = parseArtifactFilename(basename(archivePath));
  const {
    extractArchivePayloadToDirectory,
  } = await import('@happier-dev/release-runtime/archiveExtraction');
  const scratch = await mkdtemp(join(tmpdir(), 'happier-release-smoke-'));
  try {
    const archiveName = basename(archivePath);
    const runnerLayout = artifact?.product === 'happier-runner'
      ? resolveRunnerPackageLayout(`${artifact.os}-${artifact.arch}`)
      : undefined;
    const closedZipLayout = runnerLayout
      ? await readRunnerClosedZipLayout({ archivePath, archiveName, layout: runnerLayout, signal, macOSNotarizationOutput })
      : undefined;
    const firstPartyRuntime = !runnerLayout ? await import('@happier-dev/cli-common/firstPartyRuntime') : null;
    const component = firstPartyRuntime?.getFirstPartyComponentCatalogEntry(artifact.product === 'happier' ? 'happier-cli' : artifact.product);
    let root;
    if (firstPartyRuntime) {
      root = await firstPartyRuntime.extractReleasePayloadRootFromArchive({ archivePath, archiveName, extractDir: scratch, signal });
    } else {
      await extractArchivePayloadToDirectory({
        archivePath,
        archiveName,
        ...(closedZipLayout ? { closedZipLayout } : {}),
        extractDir: scratch,
        signal,
      });
      // Runner's closed layout declares whether the executable is at the root
      // or in its portable product directory.
      root = dirname(join(scratch, runnerLayout.executablePath));
    }
    // The Runner's entry point comes from its canonical package layout, never
    // from a name heuristic: a portable payload holds two executables and only
    // the shell is the product the endpoint launches.
    const candidate = runnerLayout
      ? basename(runnerLayout.executablePath)
      : component.binaryRelativePath
        ? `${component.binaryRelativePath}${artifact.os === 'windows' ? '.exe' : ''}`
        : component.nodeEntrypointRelativePath;
    if (!candidate || !(await stat(join(root, candidate))).isFile()) {
      throw new Error(`[release] missing component entrypoint ${candidate} in ${archivePath}`);
    }
    if (artifact?.product === 'happier') {
      await assertBaseCliProjection({ root, targetOs: artifact.os, targetArch: artifact.arch });
    }
    if (!execute || (!runnerLayout && !shouldSmokeTestReleaseArtifact({ archiveName }))) return;
    if (candidate.endsWith('.exe') && process.platform !== 'win32') {
      return;
    }
    const binPath = runnerLayout ? join(scratch, runnerLayout.executablePath) : join(root, candidate);
    const serverBinary = isServerBinaryCandidate(candidate);
    const memoryRuntime = artifact.product === 'happier-memory-runtime';
    const voiceRuntime = artifact.product === 'happier-voice-runtime';
    const args = memoryRuntime ? ['--input-type=module', '-e', `
      const { Tensor, env } = await import(${JSON.stringify(pathToFileURL(binPath).href)});
      env.allowRemoteModels = false;
      const tensor = new Tensor('float32', new Float32Array([1, 2]), [2]);
      if (tensor.data[1] !== 2 || tensor.dims[0] !== 2) throw new Error('Invalid Transformers/ONNX tensor');
    `] : voiceRuntime ? ['--input-type=module', '-e', `
      const imported = await import(${JSON.stringify(pathToFileURL(binPath).href)});
      const sherpa = imported.default ?? imported;
      if (!['OfflineRecognizer', 'OnlineRecognizer', 'OfflineTts'].some((name) => typeof sherpa[name] === 'function')) {
        throw new Error('Invalid Sherpa native runtime exports');
      }
    `] : serverBinary ? [] : ['--version'];
    // The Runner payload is an AppImage, which self-mounts through FUSE. Asking
    // it to extract instead keeps the smoke honest on images without FUSE; the
    // shell still sees the same arguments and still resolves its activation file
    // beside the AppImage through `$APPIMAGE`.
    const runnerEnv = artifact?.product === 'happier-runner'
      ? { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' }
      : process.env;
    const env = serverBinary
      ? {
          ...process.env,
          PORT: '0',
          METRICS_PORT: '0',
          HAPPIER_SERVER_LIGHT_DATA_DIR: join(scratch, 'server-light-data'),
        }
      : { ...runnerEnv };
    delete env.NODE_PATH;
    const result = await runSmokeCommand({
      command: memoryRuntime || voiceRuntime ? process.execPath : binPath,
      args,
      cwd: root,
      env,
      timeoutMs: resolveArtifactSmokeTimeoutMs({ serverBinary }),
    });
    const timedOut = result.timedOut === true;
    if (timedOut) {
      const output = formatSmokeOutput(result);
      if (serverBinary) {
        if (/ERR_MODULE_NOT_FOUND|Cannot find module/i.test(output)) {
          throw new Error(`[release] smoke test failed for ${archivePath}: ${output.trim()}`);
        }
        return;
      }
      throw new Error(`[release] smoke test timed out for ${archivePath}: ${output.trim()}`);
    }
    if ((result.status ?? 1) !== 0) {
      throw new Error(`[release] smoke test failed for ${archivePath}: ${formatSmokeOutput(result)}`);
    }
    if (serverBinary) {
      throw new Error(`[release] server binary exited before the smoke window for ${archivePath}`);
    }
    if (artifact?.product === 'happier' || artifact?.product === 'happier-runner') {
      const actualVersion = String(result.stdout ?? '').trim();
      const expectedVersion = artifact.product === 'happier-runner'
        ? `happier-runner ${artifact.version}`
        : artifact.version;
      if (actualVersion !== expectedVersion) {
        throw new Error(
          `[release] binary version mismatch for ${archivePath}: expected ${expectedVersion}, got ${actualVersion || '<empty>'}`,
        );
      }
    }
    if (artifact?.product === 'happier') {
      await runBaseCliRuntimeSmoke({ root, scratch, artifact, archivePath, env });
    }
    if (artifact?.product === 'happier-runner') {
      const hostileCwd = join(scratch, 'ambient-project');
      await mkdir(hostileCwd);
      await writeFile(
        join(hostileCwd, '.env'),
        'HAPPIER_RUNNER_AMBIENT_DOTENV_MUST_NOT_LOAD=1\n',
        'utf8',
      );
      await writeFile(
        join(hostileCwd, 'ambient-preload.mjs'),
        'process.stdout.write("HAPPIER_RUNNER_AMBIENT_PRELOAD_EXECUTED\\n");\n',
        'utf8',
      );
      await writeFile(
        join(hostileCwd, 'bunfig.toml'),
        'preload = ["./ambient-preload.mjs"]\n',
        'utf8',
      );

      const startupEnv = { ...runnerEnv };
      delete startupEnv.BUN_BE_BUN;
      const startup = await runSmokeCommand({
        command: binPath,
        args: [],
        cwd: hostileCwd,
        env: startupEnv,
        timeoutMs: 20_000,
      });
      const startupOutput = formatSmokeOutput(startup);
      if (startup.timedOut) {
        throw new Error(`[release] Runner startup smoke timed out before the activation-file boundary: ${startupOutput.trim()}`);
      }
      if ((startup.status ?? 0) === 0
        || !String(startup.stderr ?? '').includes('Happier Runner could not continue. Open Happier for details.')
        || startupOutput.includes('HAPPIER_RUNNER_AMBIENT_PRELOAD_EXECUTED')) {
        throw new Error(`[release] Runner startup smoke did not fail at the activation-file boundary: ${startupOutput.trim()}`);
      }

      // Bun 1.3.5 standalone executables can expose the embedded Bun CLI when
      // BUN_BE_BUN is inherited. JavaScript cannot sanitize an environment
      // variable before Bun's native dispatcher runs, so release admission
      // must reject any candidate that reaches the embedded dispatcher.
      const bunDispatcherProbe = await runSmokeCommand({
        command: binPath,
        args: ['--eval', 'process.stdout.write("HAPPIER_RUNNER_BUN_DISPATCH_EXECUTED\\n")'],
        cwd: hostileCwd,
        env: { ...startupEnv, BUN_BE_BUN: '1' },
        timeoutMs: 20_000,
      });
      const bunDispatcherOutput = formatSmokeOutput(bunDispatcherProbe);
      if (bunDispatcherProbe.timedOut
        || (bunDispatcherProbe.status ?? 0) === 0
        || bunDispatcherOutput.includes('HAPPIER_RUNNER_BUN_DISPATCH_EXECUTED')
        || !String(bunDispatcherProbe.stderr ?? '').includes('Happier Runner could not continue. Open Happier for details.')) {
        throw new Error(`[release] Runner candidate permits ambient Bun executable dispatch: ${bunDispatcherOutput.trim()}`);
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function main() {
  const { kv, flags } = parseArgs(process.argv.slice(2));
  const macOSNotarizationOutput = String(kv.get('--macos-notarization-output') ?? '').trim();
  const windowsSigningIdentity = String(kv.get('--windows-signing-identity') ?? '').trim();
  const artifactsDir = resolve(String(kv.get('--artifacts-dir') ?? '').trim() || join(process.cwd(), 'dist', 'release-assets'));
  const checksumsPathInput = String(kv.get('--checksums') ?? '').trim();
  const checksumCandidates = checksumsPathInput ? [] : (await readdir(artifactsDir, { withFileTypes: true }).catch((error) => {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code ?? '') : '';
    if (code === 'ENOENT') return [];
    throw error;
  }))
    .filter((entry) => entry.isFile() && /^checksums-.+\.txt$/.test(entry.name));
  if (checksumCandidates.length > 1) {
    throw new Error(`[release] multiple checksums files found in ${artifactsDir}; specify --checksums`);
  }
  const checksumsPath = checksumsPathInput || (checksumCandidates[0] && join(artifactsDir, checksumCandidates[0].name));
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
      .filter((name) => name.endsWith('.tar.gz') || name.endsWith('.zip'))
      .sort((left, right) => left.localeCompare(right));
    const presentArchives = (await readdir(artifactsDir))
      .filter((name) => name.endsWith('.tar.gz') || name.endsWith('.zip'))
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
  const requireSignature = flags.has('--require-signature');
  if (requireSignature && !existsSync(minisigPath)) {
    throw new Error('[release] required checksum signature is missing');
  }
  const verifySignedEnvelopes = requireSignature || existsSync(minisigPath);
  const pubkeyFile = pubKeyPath ? await readFile(pubKeyPath, 'utf8') : '';
  if (existsSync(minisigPath)) {
    if (!pubKeyPath) {
      throw new Error('[release] signature found but no --public-key/MINISIGN_PUBLIC_KEY provided');
    }
    await verifyChecksumSignature({ checksumsPath, pubkeyFile });
  }

  if (!flags.has('--skip-archive-admission')) {
    for (const entry of entries) {
      if (!entry.name.endsWith('.tar.gz') && !entry.name.startsWith('happier-runner-v')) continue;
      await verifyReleaseArchiveAdmission({
        archivePath: join(artifactsDir, entry.name),
        archiveName: entry.name,
        macOSNotarizationOutput,
        windowsSigningIdentity,
      });
    }
  }

  const skipOptionalSmoke = flags.has('--skip-smoke');
  const cliVersionAttestations = [];
  const baseCliRuntimeSmokes = [];
  const componentEnvelopes = new Map();
  const assets = entries.map((entry) => ({ name: entry.name, url: pathToFileURL(join(artifactsDir, entry.name)).href }));
  for (const entry of entries) {
    if (!entry.name.endsWith('.tar.gz') && !entry.name.endsWith('.zip')) continue;
    const artifact = parseArtifactFilename(entry.name);
    if (!artifact) continue;
    const optionalComponent = CLI_OPTIONAL_COMPONENT_PRODUCTS.includes(artifact.product);
    if (optionalComponent) {
      const bundle = resolveReleaseAssetBundle({
        assets,
        product: artifact.product,
        os: artifact.os,
        arch: artifact.arch,
        requireChecksumsSignature: verifySignedEnvelopes,
      });
      if (bundle.archive.name !== entry.name) throw new Error(`[release] component bundle mismatch for ${entry.name}`);
      if (!componentEnvelopes.has(bundle.checksums.name)) {
        const componentChecksumsPath = join(artifactsDir, bundle.checksums.name);
        const text = verifySignedEnvelopes
          ? await verifyChecksumSignature({ checksumsPath: componentChecksumsPath, pubkeyFile })
          : await readFile(componentChecksumsPath, 'utf8');
        componentEnvelopes.set(bundle.checksums.name, text);
      }
      const expected = lookupSha256({ checksumsText: componentEnvelopes.get(bundle.checksums.name), filename: entry.name });
      if (expected !== entry.sha256) throw new Error(`[release] component checksum mismatch for ${entry.name}`);
    }
    const compatible = shouldSmokeTestReleaseArtifact({ archiveName: entry.name });
    const requiresCliVersionAttestation = compatible && artifact.product === 'happier';
    const execute = compatible && (!skipOptionalSmoke || requiresCliVersionAttestation);
    // Preserve Runner's separate closed-ZIP admission and startup contract.
    if (execute || optionalComponent || artifact.product === 'happier') {
      await smokeTestArchive({ archivePath: join(artifactsDir, entry.name), execute, macOSNotarizationOutput });
    }
    if (requiresCliVersionAttestation) {
      cliVersionAttestations.push(entry.name);
      baseCliRuntimeSmokes.push(entry.name);
    }
  }

  console.log(JSON.stringify({
    ok: true,
    artifactsDir,
    checksumsPath,
    verified: entries.map((entry) => entry.name),
    smoke: !skipOptionalSmoke,
    cliVersionAttestations,
    baseCliRuntimeSmokes,
    verifiedComponentEnvelopes: [...componentEnvelopes.keys()],
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
