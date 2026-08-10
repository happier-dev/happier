#!/usr/bin/env node

// @ts-check

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import cliDistBuildManifest from '../../../packages/cli-common/cliDistBuildManifest.cjs';
import { createNodeArchive, extractNodeArchive } from './node-archive.mjs';

const THIN_MACH_O_MAGICS = new Map([
  ['feedface', { littleEndian: false }],
  ['cefaedfe', { littleEndian: true }],
  ['feedfacf', { littleEndian: false }],
  ['cffaedfe', { littleEndian: true }],
]);
const FAT_MACH_O_MAGICS = new Map([
  ['cafebabe', { littleEndian: false, is64Bit: false }],
  ['bebafeca', { littleEndian: true, is64Bit: false }],
  ['cafebabf', { littleEndian: false, is64Bit: true }],
  ['bfbafeca', { littleEndian: true, is64Bit: true }],
]);
const PRESERVED_CODESIGN_METADATA = [
  'identifier',
  'entitlements',
  'launch-constraints',
  'library-constraints',
].join(',');
const DEFAULT_CODESIGN_ATTEMPTS = 4;
const DEFAULT_CODESIGN_RETRY_DELAY_MS = 15_000;
const DEFAULT_GATEKEEPER_ATTEMPTS = 10;
const DEFAULT_GATEKEEPER_RETRY_DELAY_MS = 15_000;
const DEFAULT_GATEKEEPER_MAX_RETRY_DELAY_MS = 120_000;

function isDeveloperIdApplicationSigningSelector(value) {
  const selector = String(value ?? '').trim();
  return selector.startsWith('Developer ID Application:') || /^[0-9a-f]{40}$/iu.test(selector);
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeRelativePath(rootPath, entryPath) {
  return path.relative(rootPath, entryPath).split(path.sep).join('/');
}

function fileSha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function readThinMachOFileType(descriptor, offset, endExclusive) {
  if (offset + 16 > endExclusive) return null;
  const header = Buffer.allocUnsafe(16);
  if (fs.readSync(descriptor, header, 0, header.length, offset) !== header.length) {
    return null;
  }
  const thinFormat = THIN_MACH_O_MAGICS.get(header.subarray(0, 4).toString('hex'));
  if (!thinFormat) return null;
  return thinFormat.littleEndian ? header.readUInt32LE(12) : header.readUInt32BE(12);
}

function readMachOFileTypes(filePath) {
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.allocUnsafe(8);
    if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length) {
      return null;
    }
    const magic = header.subarray(0, 4).toString('hex');
    const fileSize = fs.fstatSync(descriptor).size;
    if (THIN_MACH_O_MAGICS.has(magic)) {
      const fileType = readThinMachOFileType(descriptor, 0, fileSize);
      return fileType === null ? null : [fileType];
    }
    const fatFormat = FAT_MACH_O_MAGICS.get(magic);
    if (!fatFormat) {
      return null;
    }

    const readUInt32 = fatFormat.littleEndian
      ? (buffer, offset) => buffer.readUInt32LE(offset)
      : (buffer, offset) => buffer.readUInt32BE(offset);
    const readBigUInt64 = fatFormat.littleEndian
      ? (buffer, offset) => buffer.readBigUInt64LE(offset)
      : (buffer, offset) => buffer.readBigUInt64BE(offset);
    const architectureCount = readUInt32(header, 4);
    if (architectureCount < 1 || architectureCount > 32) {
      return null;
    }
    const architectureSize = fatFormat.is64Bit ? 32 : 20;
    const tableSize = 8 + architectureCount * architectureSize;
    if (tableSize > fileSize) {
      return null;
    }
    const table = Buffer.allocUnsafe(architectureCount * architectureSize);
    if (fs.readSync(descriptor, table, 0, table.length, 8) !== table.length) {
      return null;
    }
    const fileTypes = [];
    for (let index = 0; index < architectureCount; index += 1) {
      const entryOffset = index * architectureSize;
      const rawOffset = fatFormat.is64Bit
        ? readBigUInt64(table, entryOffset + 8)
        : BigInt(readUInt32(table, entryOffset + 8));
      const rawSize = fatFormat.is64Bit
        ? readBigUInt64(table, entryOffset + 16)
        : BigInt(readUInt32(table, entryOffset + 12));
      if (
        rawSize < 16n
        || rawOffset < BigInt(tableSize)
        || rawOffset + rawSize > BigInt(fileSize)
      ) {
        return null;
      }
      const fileType = readThinMachOFileType(
        descriptor,
        Number(rawOffset),
        Number(rawOffset + rawSize),
      );
      if (fileType === null) return null;
      fileTypes.push(fileType);
    }
    return fileTypes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function walkPayloadEntries(payloadPath) {
  const entries = [];
  const walk = (directoryPath) => {
    const children = fs.readdirSync(directoryPath, { withFileTypes: true })
      .sort((left, right) => comparePaths(left.name, right.name));
    for (const child of children) {
      const entryPath = path.join(directoryPath, child.name);
      const relativePath = normalizeRelativePath(payloadPath, entryPath);
      const info = fs.lstatSync(entryPath);
      if (child.isDirectory()) {
        entries.push({ type: 'directory', path: entryPath, relativePath, info });
        walk(entryPath);
      } else if (child.isFile()) {
        entries.push({ type: 'file', path: entryPath, relativePath, info });
      } else if (child.isSymbolicLink()) {
        entries.push({
          type: 'symlink',
          path: entryPath,
          relativePath,
          info,
          target: fs.readlinkSync(entryPath),
        });
      } else {
        throw new Error(`[release] unsupported staged payload entry: ${relativePath}`);
      }
    }
  };
  walk(payloadPath);
  return entries;
}

export function listDarwinPayloadMachOCode(rawPayloadPath) {
  const payloadPath = path.resolve(requireValue(rawPayloadPath, 'payload path'));
  if (!fs.statSync(payloadPath, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`[release] Darwin payload does not exist: ${payloadPath}`);
  }
  return walkPayloadEntries(payloadPath)
    .filter((entry) => entry.type === 'file')
    .map((entry) => ({ entry, fileTypes: readMachOFileTypes(entry.path) }))
    .filter(({ fileTypes }) => fileTypes !== null)
    .map(({ entry, fileTypes }) => {
      const executable = (entry.info.mode & 0o111) !== 0;
      return {
        path: entry.path,
        relativePath: entry.relativePath,
        executable,
        gatekeeperAssessable: executable && fileTypes.every((fileType) => fileType === 2),
      };
    })
    .sort((left, right) => {
      const depthDelta = right.relativePath.split('/').length - left.relativePath.split('/').length;
      return depthDelta || comparePaths(left.relativePath, right.relativePath);
    });
}

export function snapshotDarwinPayload(rawPayloadPath) {
  const payloadPath = path.resolve(requireValue(rawPayloadPath, 'payload path'));
  if (!fs.statSync(payloadPath, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`[release] Darwin payload does not exist: ${payloadPath}`);
  }
  const entries = walkPayloadEntries(payloadPath);
  const payloadHash = createHash('sha256');
  for (const entry of entries) {
    const mode = entry.info.mode & 0o777;
    payloadHash.update(entry.type);
    payloadHash.update('\0');
    payloadHash.update(entry.relativePath);
    payloadHash.update('\0');
    payloadHash.update(String(mode));
    payloadHash.update('\0');
    if (entry.type === 'file') {
      payloadHash.update(String(entry.info.size));
      payloadHash.update('\0');
      payloadHash.update(fileSha256(entry.path));
    } else if (entry.type === 'symlink') {
      payloadHash.update(entry.target);
    }
    payloadHash.update('\0');
  }
  return {
    payloadSha256: payloadHash.digest('hex'),
    entryCount: entries.length,
    machO: listDarwinPayloadMachOCode(payloadPath).map((entry) => ({
      path: entry.relativePath,
      sha256: fileSha256(entry.path),
      executable: entry.executable,
    })),
  };
}

/**
 * Standalone payload Mach-O files receive their notarization tickets from Apple
 * when Gatekeeper checks them online. There is no container to which a ticket
 * can be stapled, so this command intentionally never invokes stapler.
 */
export function resolveDarwinPayloadNotarizationCommands({
  payloadPath,
  identity,
  machOCode,
  zipPath,
  keyPath,
  keyId,
  issuerId,
  submissionId,
  logPath,
}) {
  const authArgs = ['--key', keyPath, '--key-id', keyId, '--issuer', issuerId];
  return {
    codesign: machOCode.map((entry) => [
      'codesign',
      [
        '--force',
        '--sign',
        identity,
        '--options',
        'runtime',
        '--timestamp',
        `--preserve-metadata=${PRESERVED_CODESIGN_METADATA}`,
        entry.path,
      ],
    ]),
    verify: machOCode.map((entry) => [
      'codesign',
      ['--verify', '--strict=all', '--verbose=2', entry.path],
    ]),
    archive: [
      'ditto',
      ['-c', '-k', '--keepParent', payloadPath, zipPath],
    ],
    submit: [
      'xcrun',
      [
        'notarytool',
        'submit',
        zipPath,
        ...authArgs,
        '--wait',
        '--timeout',
        '15m',
        '--output-format',
        'json',
      ],
    ],
    log: [
      'xcrun',
      ['notarytool', 'log', submissionId, logPath, ...authArgs],
    ],
    assess: machOCode
      .filter((entry) => entry.gatekeeperAssessable)
      .map((entry) => [
        'spctl',
        ['--assess', '--type', 'execute', '--verbose=4', entry.path],
      ]),
    ticketDelivery: 'online',
    stapled: false,
  };
}

export function resolveAdHocDarwinPayloadSigningCommands(machOCode) {
  return {
    codesign: machOCode.map((entry) => [
      'codesign',
      [
        '--force',
        '--sign',
        '-',
        `--preserve-metadata=${PRESERVED_CODESIGN_METADATA}`,
        entry.path,
      ],
    ]),
    verify: machOCode.map((entry) => [
      'codesign',
      ['--verify', '--strict=all', '--verbose=2', entry.path],
    ]),
  };
}

function run([command, args], options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    timeout: options.timeoutMs ?? 10 * 60_000,
  });
}

function commandFailureOutput(error) {
  return [error?.message, error?.stdout, error?.stderr]
    .map((value) => Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? ''))
    .join('\n');
}

function sleepSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.trunc(ms));
}

export function runCodesignWithRetry(
  command,
  {
    attempts = DEFAULT_CODESIGN_ATTEMPTS,
    retryDelayMs = DEFAULT_CODESIGN_RETRY_DELAY_MS,
    runCommand = run,
    sleep = sleepSync,
    logger = console,
  } = {},
) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return runCommand(command);
    } catch (error) {
      const timestampServiceUnavailable = /timestamp service is not available/iu.test(
        commandFailureOutput(error),
      );
      if (!timestampServiceUnavailable || attempt >= attempts) {
        throw error;
      }
      const nextAttempt = attempt + 1;
      const delayMs = retryDelayMs * (2 ** (attempt - 1));
      logger.warn?.(
        `[release] Apple timestamp service is unavailable; retrying codesign (${nextAttempt}/${attempts})`,
      );
      sleep(delayMs);
    }
  }
  throw new Error('[release] codesign retry loop exhausted unexpectedly');
}

export function runGatekeeperAssessment(
  command,
  {
    attempts = DEFAULT_GATEKEEPER_ATTEMPTS,
    retryDelayMs = DEFAULT_GATEKEEPER_RETRY_DELAY_MS,
    maxRetryDelayMs = DEFAULT_GATEKEEPER_MAX_RETRY_DELAY_MS,
    runCommand = run,
    sleep = sleepSync,
    logger = console,
  } = {},
) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      runCommand(command, { capture: true });
      return true;
    } catch (error) {
      const failureOutput = commandFailureOutput(error);
      if (/does not seem to be an app/iu.test(failureOutput)) {
        logger.warn?.(
          '[release] spctl cannot assess this raw command-line Mach-O as an app; '
          + 'accepted notarization and strict code-signature verification remain authoritative.',
        );
        return false;
      }
      const onlineTicketPending = /source\s*=\s*Unnotarized Developer ID/iu.test(failureOutput);
      if (!onlineTicketPending || attempt >= attempts) {
        throw error;
      }
      const nextAttempt = attempt + 1;
      const delayMs = Math.min(retryDelayMs * (2 ** (attempt - 1)), maxRetryDelayMs);
      logger.warn?.(
        `[release] accepted notarization ticket is not visible to Gatekeeper yet; `
        + `retrying spctl (${nextAttempt}/${attempts})`,
      );
      sleep(delayMs);
    }
  }
  throw new Error('[release] Gatekeeper assessment retry loop exhausted unexpectedly');
}

export function repairAdHocDarwinPayloadSignatures(
  rawPayloadPath,
  { finalizePayloadBeforeSnapshot = () => {} } = {},
) {
  if (process.platform !== 'darwin') {
    throw new Error('[release] ad-hoc Darwin payload signing must run on macOS');
  }
  const payloadPath = path.resolve(requireValue(rawPayloadPath, 'payload path'));
  const machOCode = listDarwinPayloadMachOCode(payloadPath);
  if (machOCode.length === 0) {
    throw new Error(`[release] Darwin payload contains no Mach-O code: ${payloadPath}`);
  }
  const commands = resolveAdHocDarwinPayloadSigningCommands(machOCode);
  commands.codesign.forEach((command) => run(command));
  commands.verify.forEach((command) => run(command));
  finalizePayloadBeforeSnapshot();
  return {
    payload: path.basename(payloadPath),
    signatureType: 'adhoc',
    ...snapshotDarwinPayload(payloadPath),
  };
}

function assertMatchingPayloadSnapshot(evidence, snapshot) {
  if (
    evidence.payloadSha256 !== snapshot.payloadSha256
    || evidence.entryCount !== snapshot.entryCount
    || JSON.stringify(evidence.machO) !== JSON.stringify(snapshot.machO)
  ) {
    throw new Error('[release] Darwin payload evidence does not match the exact staged payload');
  }
}

export function verifyDarwinPayloadNotarizationEvidence({
  payloadPath: rawPayloadPath,
  evidencePath: rawEvidencePath,
  verifyCode = (entryPath) => run([
    'codesign',
    ['--verify', '--strict=all', '--verbose=2', entryPath],
  ]),
  assessCode = (entryPath) => runGatekeeperAssessment([
    'spctl',
    ['--assess', '--type', 'execute', '--verbose=4', entryPath],
  ]),
}) {
  const payloadPath = path.resolve(requireValue(rawPayloadPath, 'payload path'));
  const evidencePath = path.resolve(requireValue(rawEvidencePath, 'notarization evidence path'));
  if (!fs.statSync(payloadPath, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`[release] Darwin payload does not exist: ${payloadPath}`);
  }
  if (!fs.statSync(evidencePath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`[release] Darwin payload notarization evidence does not exist: ${evidencePath}`);
  }

  let evidence;
  try {
    evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  } catch {
    throw new Error('[release] Darwin payload notarization evidence is not valid JSON');
  }
  if (
    evidence?.schemaVersion !== 2
    || evidence?.payload !== path.basename(payloadPath)
    || !/^[a-f0-9]{64}$/u.test(String(evidence?.payloadSha256 ?? ''))
    || !Number.isSafeInteger(evidence?.entryCount)
    || evidence.entryCount < 1
    || !Array.isArray(evidence?.machO)
    || evidence.machO.length < 1
    || evidence.machO.some((entry) => (
      typeof entry?.path !== 'string'
      || path.isAbsolute(entry.path)
      || entry.path.split('/').includes('..')
      || !/^[a-f0-9]{64}$/u.test(String(entry?.sha256 ?? ''))
      || typeof entry?.executable !== 'boolean'
    ))
    || !isDeveloperIdApplicationSigningSelector(evidence?.signingIdentity)
    || !String(evidence?.notarization?.submissionId ?? '').trim()
    || evidence?.notarization?.status !== 'Accepted'
    || !/^[a-f0-9]{64}$/u.test(String(evidence?.notarization?.archiveSha256 ?? ''))
    || evidence?.notarization?.ticketDelivery !== 'online'
    || evidence?.notarization?.stapled !== false
  ) {
    throw new Error('[release] Darwin payload notarization evidence is invalid');
  }

  const snapshot = snapshotDarwinPayload(payloadPath);
  assertMatchingPayloadSnapshot(evidence, snapshot);
  const gatekeeperAssessablePaths = new Set(
    listDarwinPayloadMachOCode(payloadPath)
      .filter((entry) => entry.gatekeeperAssessable)
      .map((entry) => entry.relativePath),
  );
  for (const entry of snapshot.machO) {
    const entryPath = path.join(payloadPath, ...entry.path.split('/'));
    verifyCode(entryPath);
    if (gatekeeperAssessablePaths.has(entry.path)) {
      assessCode(entryPath);
    }
  }
  return evidence;
}

export function verifyDarwinPayloadNotarizationEvidenceMain(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'verify-evidence': { type: 'boolean' },
      payload: { type: 'string' },
      evidence: { type: 'string' },
    },
    allowPositionals: false,
  });
  if (values['verify-evidence'] !== true) {
    throw new Error('[release] --verify-evidence is required');
  }
  const evidence = verifyDarwinPayloadNotarizationEvidence({
    payloadPath: values.payload,
    evidencePath: values.evidence,
  });
  console.log(JSON.stringify({
    payload: evidence.payload,
    payloadSha256: evidence.payloadSha256,
    machOCount: evidence.machO.length,
    signingIdentity: evidence.signingIdentity,
    notarizationStatus: evidence.notarization.status,
  }));
  return evidence;
}

export function finalizeMacOSPayloadForArchive({
  target,
  stageDir,
  platform = process.platform,
  signingIdentity = '',
  notarizationOutputPath = '',
  repairSignature = repairAdHocDarwinPayloadSignatures,
  notarizePayload = notarizeDarwinPayloadMain,
  refreshRuntimeAssetManifest = () => {},
}) {
  const identity = String(signingIdentity ?? '').trim();
  const evidencePath = String(notarizationOutputPath ?? '').trim();
  if (Boolean(identity) !== Boolean(evidencePath)) {
    throw new Error(
      '[release] --macos-signing-identity and --macos-notarization-output must be provided together',
    );
  }
  if (target?.os !== 'darwin') {
    if (identity || evidencePath) {
      throw new Error('[release] macOS signing options require exactly one Darwin target');
    }
    return null;
  }
  if (platform !== 'darwin') {
    throw new Error('[release] Darwin payload signing must run on macOS');
  }

  if (!identity) {
    return repairSignature(stageDir, {
      finalizePayloadBeforeSnapshot: refreshRuntimeAssetManifest,
    });
  }
  return notarizePayload([
    '--payload',
    stageDir,
    '--identity',
    identity,
    '--out',
    evidencePath,
  ], {
    finalizePayloadBeforeSnapshot: refreshRuntimeAssetManifest,
  });
}

function assertExactExtractedPayload(extractDir, expectedPayloadName) {
  const entries = fs.readdirSync(extractDir).filter((entry) => !entry.startsWith('._')).sort();
  if (entries.length !== 1 || entries[0] !== expectedPayloadName) {
    throw new Error(
      `[release] Darwin archive must contain exactly ${expectedPayloadName} (found: ${entries.join(', ') || '<empty>'})`,
    );
  }
  const payloadPath = path.join(extractDir, expectedPayloadName);
  if (!fs.statSync(payloadPath, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`[release] Darwin archive payload is not a directory: ${expectedPayloadName}`);
  }
  return payloadPath;
}

export async function finalizeDarwinReleaseArchive({
  archivePath: rawArchivePath,
  expectedPayloadName: rawExpectedPayloadName,
  identity: rawIdentity,
  evidencePath: rawEvidencePath,
  platform = process.platform,
  extractArchiveImpl = extractNodeArchive,
  createArchiveImpl = createNodeArchive,
  notarizePayloadImpl = notarizeDarwinPayloadMain,
  verifyEvidenceImpl = verifyDarwinPayloadNotarizationEvidence,
  finalizePayloadBeforeSnapshot = () => {},
  makeWorkDirImpl = () => fs.mkdtempSync(
    path.join(path.dirname(path.resolve(rawArchivePath)), `.${path.basename(rawArchivePath)}.notary-`),
  ),
}) {
  if (platform !== 'darwin') {
    throw new Error('[release] Darwin archive finalization must run on macOS');
  }
  const archivePath = path.resolve(requireValue(rawArchivePath, 'Darwin archive path'));
  const expectedPayloadName = requireValue(rawExpectedPayloadName, 'Darwin archive payload name');
  if (path.basename(expectedPayloadName) !== expectedPayloadName || expectedPayloadName === '.' || expectedPayloadName === '..') {
    throw new Error('[release] Darwin archive payload name must be one directory name');
  }
  const identity = requireValue(rawIdentity, 'Darwin signing identity');
  if (!isDeveloperIdApplicationSigningSelector(identity)) {
    throw new Error('[release] Darwin signing identity must be a Developer ID Application identity');
  }
  const evidencePath = path.resolve(requireValue(rawEvidencePath, 'Darwin notarization evidence path'));
  if (!fs.statSync(archivePath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`[release] Darwin archive does not exist: ${archivePath}`);
  }

  const workDir = makeWorkDirImpl();
  const sourceDir = path.join(workDir, 'source');
  const verificationDir = path.join(workDir, 'verification');
  const finalizedArchivePath = path.join(workDir, path.basename(archivePath));
  try {
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.mkdirSync(verificationDir, { recursive: true });
    await extractArchiveImpl({ archivePath, extractDir: sourceDir });
    const sourcePayloadPath = assertExactExtractedPayload(sourceDir, expectedPayloadName);
    notarizePayloadImpl(
      [
        '--payload',
        sourcePayloadPath,
        '--identity',
        identity,
        '--out',
        evidencePath,
      ],
      {
        finalizePayloadBeforeSnapshot: () => finalizePayloadBeforeSnapshot(sourcePayloadPath),
      },
    );
    await createArchiveImpl({
      sourcePath: sourceDir,
      sourceName: expectedPayloadName,
      artifactPath: finalizedArchivePath,
    });
    await extractArchiveImpl({ archivePath: finalizedArchivePath, extractDir: verificationDir });
    const verificationPayloadPath = assertExactExtractedPayload(verificationDir, expectedPayloadName);
    const evidence = verifyEvidenceImpl({
      payloadPath: verificationPayloadPath,
      evidencePath,
    });
    fs.renameSync(finalizedArchivePath, archivePath);
    return {
      archivePath,
      payload: evidence.payload,
      payloadSha256: evidence.payloadSha256,
      signingIdentity: evidence.signingIdentity,
      notarizationStatus: evidence.notarization?.status,
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

export async function finalizeDarwinReleaseArchiveMain(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      archive: { type: 'string' },
      'expected-payload': { type: 'string' },
      identity: { type: 'string' },
      out: { type: 'string' },
      'refresh-cli-runtime-asset-manifest': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  const result = await finalizeDarwinReleaseArchive({
    archivePath: values.archive,
    expectedPayloadName: values['expected-payload'],
    identity: values.identity,
    evidencePath: values.out,
    finalizePayloadBeforeSnapshot: values['refresh-cli-runtime-asset-manifest'] === true
      ? (payloadPath) => {
        cliDistBuildManifest.refreshCliRuntimeAssetBuildManifest({
          runtimeRoot: payloadPath,
          entrypoint: path.join(payloadPath, 'package-dist', 'index.mjs'),
        });
      }
      : undefined,
  });
  console.log(JSON.stringify(result));
  return result;
}

function writePrivateKey(pathname, rawValue) {
  const normalized = rawValue.includes('\\n') ? rawValue.replaceAll('\\n', '\n') : rawValue;
  const contents = normalized.includes('BEGIN PRIVATE KEY')
    ? normalized
    : Buffer.from(normalized, 'base64');
  fs.writeFileSync(pathname, contents);
  fs.chmodSync(pathname, 0o600);
}

function requireValue(value, name) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new Error(`[release] ${name} is required`);
  }
  return normalized;
}

export function notarizeDarwinPayload({
  payloadPath,
  identity,
  outPath,
  githubOutput,
  environment = process.env,
  runCommand = run,
  logger = console,
  finalizePayloadBeforeSnapshot = () => {},
}) {
  if (!fs.statSync(payloadPath, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`[release] Darwin payload does not exist: ${payloadPath}`);
  }

  const keyId = requireValue(environment.APPLE_API_KEY_ID, 'APPLE_API_KEY_ID');
  const issuerId = requireValue(environment.APPLE_API_ISSUER_ID, 'APPLE_API_ISSUER_ID');
  const privateKey = requireValue(environment.APPLE_API_PRIVATE_KEY, 'APPLE_API_PRIVATE_KEY');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-darwin-payload-notary-'));
  const keyPath = path.join(workDir, `AuthKey_${keyId}.p8`);
  const zipPath = path.join(workDir, `${path.basename(payloadPath)}.zip`);
  const logFileName = `${path.basename(outPath)}.notary-log.json`;
  const logPath = path.join(path.dirname(outPath), logFileName);

  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    writePrivateKey(keyPath, privateKey);
    const machOCode = listDarwinPayloadMachOCode(payloadPath);
    if (machOCode.length === 0) {
      throw new Error(`[release] Darwin payload contains no Mach-O code: ${payloadPath}`);
    }
    const provisional = resolveDarwinPayloadNotarizationCommands({
      payloadPath,
      identity,
      machOCode,
      zipPath,
      keyPath,
      keyId,
      issuerId,
      submissionId: 'PENDING',
      logPath,
    });
    provisional.codesign.forEach((command) => runCodesignWithRetry(command, { runCommand, logger }));
    provisional.verify.forEach((command) => runCommand(command));
    finalizePayloadBeforeSnapshot();
    const signedSnapshot = snapshotDarwinPayload(payloadPath);
    runCommand(provisional.archive);
    const archiveSha256 = fileSha256(zipPath);
    const submitOutput = runCommand(provisional.submit, { capture: true, timeoutMs: 30 * 60_000 });
    const submission = JSON.parse(submitOutput);
    const submissionId = requireValue(submission.id, 'notarytool submission id');
    const status = requireValue(submission.status, 'notarytool submission status');
    const commands = resolveDarwinPayloadNotarizationCommands({
      payloadPath,
      identity,
      machOCode: listDarwinPayloadMachOCode(payloadPath),
      zipPath,
      keyPath,
      keyId,
      issuerId,
      submissionId,
      logPath,
    });
    runCommand(commands.log, { timeoutMs: 10 * 60_000 });
    if (status !== 'Accepted') {
      throw new Error(`[release] Apple notarization was not accepted (${status}); log: ${logFileName}`);
    }
    commands.assess.forEach((command) => runGatekeeperAssessment(command, { runCommand, logger }));
    assertMatchingPayloadSnapshot(signedSnapshot, snapshotDarwinPayload(payloadPath));

    const evidence = {
      schemaVersion: 2,
      payload: path.basename(payloadPath),
      ...signedSnapshot,
      signingIdentity: identity,
      notarization: {
        submissionId,
        status,
        archiveSha256,
        ticketDelivery: commands.ticketDelivery,
        stapled: commands.stapled,
      },
    };
    fs.writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    if (githubOutput) {
      fs.appendFileSync(githubOutput, `submission_id=${submissionId}\nevidence_path=${outPath}\n`, 'utf8');
    }
    logger.log(JSON.stringify(evidence, null, 2));
    return evidence;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

export function notarizeDarwinPayloadMain(
  argv = process.argv.slice(2),
  { finalizePayloadBeforeSnapshot = () => {} } = {},
) {
  if (process.platform !== 'darwin') {
    throw new Error('[release] Darwin payload notarization must run on macOS');
  }
  const { values } = parseArgs({
    args: argv,
    options: {
      payload: { type: 'string' },
      identity: { type: 'string' },
      out: { type: 'string' },
      'github-output': { type: 'string', default: '' },
    },
    allowPositionals: false,
  });
  const payloadPath = path.resolve(requireValue(values.payload, '--payload'));
  const identity = requireValue(values.identity, '--identity');
  const outPath = path.resolve(requireValue(values.out, '--out'));
  if (!isDeveloperIdApplicationSigningSelector(identity)) {
    throw new Error('[release] --identity must be a Developer ID Application identity');
  }
  return notarizeDarwinPayload({
    payloadPath,
    identity,
    outPath,
    githubOutput: String(values['github-output'] ?? '').trim(),
    finalizePayloadBeforeSnapshot,
  });
}

const isEntrypoint = (() => {
  const entry = String(process.argv[1] ?? '');
  return entry.endsWith('/scripts/pipeline/release/notarize-standalone-binary.mjs')
    || entry.endsWith('\\scripts\\pipeline\\release\\notarize-standalone-binary.mjs');
})();

if (isEntrypoint) {
  Promise.resolve().then(async () => {
    if (process.argv.slice(2).includes('--verify-evidence')) {
      return verifyDarwinPayloadNotarizationEvidenceMain();
    }
    if (process.argv.slice(2).includes('--archive')) {
      return await finalizeDarwinReleaseArchiveMain();
    } else {
      return notarizeDarwinPayloadMain();
    }
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
