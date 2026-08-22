#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  exportPackSandboxTarball,
} from '../../../../apps/stack/scripts/pack.mjs';
import {
  resolveCliDistBuildLockPath,
  withCliDistBuildLock,
} from '../../../../apps/stack/scripts/utils/proc/cliDistBuildLock.mjs';
import {
  createPackedAuthorCandidate,
} from './create-packed-author-candidate.mjs';
import {
  assertCandidateChecksumSignature,
  assertPackedAuthorCandidateManifestArtifacts,
} from './run-packed-author-ui-compat.mjs';
import {
  parseArtifactFilename,
} from '../../../../scripts/pipeline/release/lib/manifests.mjs';
import {
  normalizeRollingBaseVersion,
  validateExactRollingPublishVersion,
} from '../../../../scripts/pipeline/release/lib/rolling-version-allocation.mjs';
import {
  normalizePublicReleaseChannel,
} from '../../../../scripts/pipeline/release/lib/public-release-rings.mjs';
import {
  parseArtifactChecksums,
} from '../../../../scripts/pipeline/release/lib/artifact-checksums.mjs';
import {
  verifyReleaseArchiveAdmission,
} from '../../../../scripts/pipeline/release/verify-artifacts.mjs';
import {
  extractArchivePayloadToDirectory,
} from '@happier-dev/release-runtime/archiveExtraction';
import {
  DEFAULT_MINISIGN_PUBLIC_KEY,
  verifyMinisign,
} from '@happier-dev/release-runtime/minisign';
import {
  verifyDarwinPayloadNotarizationEvidence,
} from '../../../../scripts/pipeline/release/notarize-standalone-binary.mjs';

const NATIVE_TARGETS = Object.freeze([
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
  'windows-x64',
]);
const DARWIN_NATIVE_TARGETS = Object.freeze([
  'darwin-x64',
  'darwin-arm64',
]);
const NATIVE_TARGET_SET = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'windows-x64',
]);
const CANDIDATE_RELEASE_CHANNEL = 'dev';
const PACKED_AUTHOR_NPM_PACKAGES = Object.freeze([
  Object.freeze({
    field: 'sdk',
    packageRelDir: 'packages/plugin-sdk',
    packageName: '@happier-dev/plugin-sdk',
    tarballPrefix: 'happier-dev-plugin-sdk',
  }),
  Object.freeze({
    field: 'pluginUi',
    packageRelDir: 'packages/plugin-ui',
    packageName: '@happier-dev/plugin-ui',
    tarballPrefix: 'happier-dev-plugin-ui',
  }),
  Object.freeze({
    field: 'channelsProtocol',
    packageRelDir: 'packages/channels-protocol',
    packageName: '@happier-dev/channels-protocol',
    tarballPrefix: 'happier-dev-channels-protocol',
  }),
  Object.freeze({
    field: 'cli',
    packageRelDir: 'apps/cli',
    packageName: '@happier-dev/cli',
    tarballPrefix: 'happier-dev-cli',
  }),
]);
function fail(message) {
  throw new Error(message);
}

function readFlag(argv, flag) {
  const index = argv.indexOf(flag);
  const value = index < 0 ? null : argv[index + 1];
  if (!value || value.startsWith('--')) fail(`Missing ${flag} <value>`);
  return value;
}

function readOptionalFlag(argv, flag) {
  const index = argv.indexOf(flag);
  if (index < 0) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) fail(`Missing ${flag} <value>`);
  return value;
}

function validateRunId(runId) {
  if (!/^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*$/u.test(runId) || runId.length > 64) {
    fail('Candidate run id must be a bounded lower-case identifier');
  }
  return runId;
}

function validateNativeTarget(nativeTarget) {
  if (nativeTarget === null || nativeTarget === undefined || nativeTarget === '') {
    return null;
  }
  const normalized = String(nativeTarget).trim().toLowerCase();
  if (!NATIVE_TARGET_SET.has(normalized)) {
    fail(`Unsupported native target: ${nativeTarget}`);
  }
  return normalized;
}

export async function resolveOwnedStandaloneCliMatrixVersion(sourceDir) {
  const resolvedSourceDir = resolve(String(sourceDir ?? ''));
  const sourceStats = await lstat(resolvedSourceDir);
  if (sourceStats.isSymbolicLink() || !sourceStats.isDirectory()) {
    fail('Supplied native artifacts root must be a real directory');
  }
  const archiveEntries = (await readdir(resolvedSourceDir))
    .filter((entry) => entry.endsWith('.tar.gz'));
  const parsedArchiveIdentities = archiveEntries
    .map((entry) => parseArtifactFilename(entry));
  const archiveIdentities = parsedArchiveIdentities
    .filter((identity) => identity?.product === 'happier');
  const identitiesByTarget = new Map(
    archiveIdentities.map((identity) => [
      `${identity.os}-${identity.arch}`,
      identity,
    ]),
  );
  const versions = new Set(
    NATIVE_TARGETS.map((target) => identitiesByTarget.get(target)?.version),
  );
  if (
    archiveEntries.length !== NATIVE_TARGETS.length
    || archiveIdentities.length !== archiveEntries.length
    || identitiesByTarget.size !== NATIVE_TARGETS.length
    || NATIVE_TARGETS.some((target) => !identitiesByTarget.has(target))
    || versions.size !== 1
  ) {
    fail('Supplied native matrix must contain all five release archives at one exact version');
  }
  const [version] = versions;
  try {
    const baseVersion = normalizeRollingBaseVersion(version);
    if (version !== baseVersion) {
      validateExactRollingPublishVersion({
        productId: 'cli',
        channel: normalizePublicReleaseChannel(CANDIDATE_RELEASE_CHANNEL),
        baseVersion,
        version,
      });
    }
  } catch {
    fail('Supplied native matrix version must be an exact stable or allocated dev CLI version');
  }
  return version;
}

export function parsePackedAuthorCandidateBuilderArgs(
  argv,
  { cwd = process.cwd() } = {},
) {
  if (argv.includes('--standalone-cli-artifact')) {
    fail(
      'This builder consumes the complete native matrix through --native-artifacts-dir, not a borrowed standalone archive',
    );
  }
  const runId = validateRunId(readFlag(argv, '--run-id'));
  const outputRoot = resolve(cwd, readFlag(argv, '--output-root'));
  const nativeTarget = validateNativeTarget(readFlag(argv, '--native-target'));
  const nativeArtifactsDirArgument = readFlag(argv, '--native-artifacts-dir');
  return {
    runId,
    outputRoot,
    nativeTarget,
    nativeArtifactsDir: resolve(cwd, nativeArtifactsDirArgument),
  };
}

export function parsePackedAuthorNaturalBuilderArgs(
  argv,
  { cwd = process.cwd() } = {},
) {
  if (
    argv.includes('--native-target')
    || argv.includes('--native-artifacts-dir')
    || argv.includes('--standalone-cli-artifact')
  ) {
    fail('Natural artifact mode accepts only the SDK, Plugin UI, Channels protocol, and CLI npm set');
  }
  return {
    runId: validateRunId(readFlag(argv, '--run-id')),
    outputRoot: resolve(cwd, readFlag(argv, '--output-root')),
  };
}

function pathIsInside(rootPath, candidatePath) {
  const rel = relative(resolve(rootPath), resolve(candidatePath));
  return rel === ''
    || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

async function ensureRegularOwnedArchive({
  archivePath,
  ownedRoot,
}) {
  const ownedRootStats = await lstat(ownedRoot);
  if (ownedRootStats.isSymbolicLink() || !ownedRootStats.isDirectory()) {
    fail('Native output root must be a real directory');
  }
  const stats = await lstat(archivePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    fail('Native owner must return a regular freshly-built standalone CLI archive');
  }
  const [physicalOwnedRoot, physicalArchivePath] = await Promise.all([
    realpath(ownedRoot),
    realpath(archivePath),
  ]);
  if (!pathIsInside(physicalOwnedRoot, physicalArchivePath)) {
    fail('Native owner returned an archive outside the physical native output root');
  }
}

export async function verifyDarwinNotarizationEvidenceAgainstArchive({
  archivePath,
  archiveName,
  evidencePath,
  evidenceFileName,
  target,
}) {
  const expectedEvidenceFileName = `${target}.cli.json`;
  if (
    !DARWIN_NATIVE_TARGETS.includes(target)
    || evidenceFileName !== expectedEvidenceFileName
    || basename(evidencePath) !== expectedEvidenceFileName
  ) {
    fail(`Darwin notarization evidence has an unexpected target identity: ${evidenceFileName}`);
  }
  const scratch = await mkdtemp(join(tmpdir(), 'happier-candidate-notary-'));
  try {
    await extractArchivePayloadToDirectory({
      archivePath,
      archiveName,
      extractDir: scratch,
    });
    const payloadName = archiveName.slice(0, -'.tar.gz'.length);
    verifyDarwinPayloadNotarizationEvidence({
      payloadPath: join(scratch, payloadName),
      evidencePath,
      // Candidate assembly can run on any platform. Native Darwin binary smoke
      // repeats this verification with codesign and Gatekeeper on the host.
      verifyCode: () => {},
      assessCode: () => {},
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function importOwnedStandaloneCliMatrix(
  {
    sourceDir,
    destinationDir,
    version,
    target,
  },
  {
    verifyReleaseArchiveAdmissionImpl = verifyReleaseArchiveAdmission,
    verifyDarwinNotarizationEvidenceImpl =
      verifyDarwinNotarizationEvidenceAgainstArchive,
    trustedMinisignPublicKey = DEFAULT_MINISIGN_PUBLIC_KEY,
    verifyMinisignImpl = verifyMinisign,
  } = {},
) {
  const resolvedSourceDir = resolve(String(sourceDir ?? ''));
  const resolvedDestinationDir = resolve(String(destinationDir ?? ''));
  const sourceStats = await lstat(resolvedSourceDir);
  if (sourceStats.isSymbolicLink() || !sourceStats.isDirectory()) {
    fail('Supplied native artifacts root must be a real directory');
  }
  const physicalSourceDir = await realpath(resolvedSourceDir);
  await mkdir(resolvedDestinationDir);

  const expectedArchives = NATIVE_TARGETS.map((nativeTarget) => {
    const [os, arch] = nativeTarget.split('-');
    return {
      target: nativeTarget,
      os,
      arch,
      fileName: `happier-v${version}-${nativeTarget}.tar.gz`,
    };
  });
  const expectedChecksumsFileName = `checksums-happier-v${version}.txt`;
  const expectedSignatureFileName = `${expectedChecksumsFileName}.minisig`;
  const expectedDarwinEvidence = DARWIN_NATIVE_TARGETS.map((target) => ({
    target,
    fileName: `${target}.cli.json`,
  }));
  const actualEntries = (await readdir(resolvedSourceDir))
    .sort((left, right) => left.localeCompare(right));
  const allowedEntries = new Set([
    ...expectedArchives.map((artifact) => artifact.fileName),
    expectedChecksumsFileName,
    expectedSignatureFileName,
    ...expectedDarwinEvidence.map(({ fileName }) => fileName),
  ]);
  const unexpectedEntries = actualEntries.filter((entry) => !allowedEntries.has(entry));
  if (unexpectedEntries.length > 0) {
    fail(`Supplied native matrix contains unexpected artifacts: ${unexpectedEntries.join(', ')}`);
  }
  const missingArchives = expectedArchives.filter(
    (artifact) => !actualEntries.includes(artifact.fileName),
  );
  const missingDarwinEvidence = expectedDarwinEvidence.filter(
    ({ fileName }) => !actualEntries.includes(fileName),
  );
  if (
    missingArchives.length > 0
    || !actualEntries.includes(expectedChecksumsFileName)
    || !actualEntries.includes(expectedSignatureFileName)
    || missingDarwinEvidence.length > 0
  ) {
    fail(
      'Supplied native matrix must contain all five release archives, their checksum and signature files, and both Darwin notarization evidence files',
    );
  }

  async function importRegularFile(fileName) {
    const sourcePath = join(resolvedSourceDir, fileName);
    const stats = await lstat(sourcePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      fail(`Supplied native artifact must be a regular file: ${fileName}`);
    }
    const physicalSourcePath = await realpath(sourcePath);
    if (!pathIsInside(physicalSourceDir, physicalSourcePath)) {
      fail(`Supplied native artifact escaped its physical root: ${fileName}`);
    }
    const bytes = await readFile(sourcePath);
    const destinationPath = join(resolvedDestinationDir, fileName);
    await writeFile(destinationPath, bytes, { flag: 'wx' });
    return { bytes, destinationPath };
  }

  const importedArchives = [];
  for (const expected of expectedArchives) {
    const imported = await importRegularFile(expected.fileName);
    await verifyReleaseArchiveAdmissionImpl({
      archivePath: imported.destinationPath,
      archiveName: expected.fileName,
    });
    const identity = parseArtifactFilename(expected.fileName);
    if (
      !identity
      || identity.product !== 'happier'
      || identity.version !== version
      || identity.os !== expected.os
      || identity.arch !== expected.arch
    ) {
      fail(`Supplied native archive has inconsistent identity: ${expected.fileName}`);
    }
    importedArchives.push({
      product: 'happier',
      version,
      os: expected.os,
      arch: expected.arch,
      sha256: createHash('sha256').update(imported.bytes).digest('hex'),
      archivePath: imported.destinationPath,
    });
  }

  const notarization = [];
  const importedDarwinEvidence = [];
  for (const expected of expectedDarwinEvidence) {
    const imported = await importRegularFile(expected.fileName);
    const archive = importedArchives.find(
      (artifact) => `${artifact.os}-${artifact.arch}` === expected.target,
    );
    if (!archive) {
      fail(`Supplied native matrix is missing Darwin archive for ${expected.target}`);
    }
    await verifyDarwinNotarizationEvidenceImpl({
      archivePath: archive.archivePath,
      archiveName: basename(archive.archivePath),
      evidencePath: imported.destinationPath,
      evidenceFileName: expected.fileName,
      target: expected.target,
    });
    notarization.push({
      target: expected.target,
      evidence: createBoundFileRecord({
        kind: 'apple-notarization-evidence',
        fileName: expected.fileName,
        filePath: imported.destinationPath,
        bytes: imported.bytes,
      }),
    });
    importedDarwinEvidence.push({
      fileName: expected.fileName,
      sha256: createHash('sha256').update(imported.bytes).digest('hex'),
    });
  }

  const importedChecksums = await importRegularFile(expectedChecksumsFileName);
  const checksumsPath = importedChecksums.destinationPath;
  const checksumsBytes = importedChecksums.bytes;
  const checksumEntries = parseArtifactChecksums(checksumsBytes.toString('utf8'));
  const checksumsByName = new Map(
    checksumEntries.map((entry) => [entry.name, entry.sha256]),
  );
  const checksumBoundArtifacts = [
    ...importedArchives.map((artifact) => ({
      fileName: basename(artifact.archivePath),
      sha256: artifact.sha256,
    })),
    ...importedDarwinEvidence,
  ];
  if (
    checksumEntries.length !== checksumBoundArtifacts.length
    || checksumsByName.size !== checksumEntries.length
    || checksumBoundArtifacts.some((artifact) => (
      checksumsByName.get(artifact.fileName) !== artifact.sha256
    ))
  ) {
    fail('Native checksums artifact does not bind the exact seven-artifact release envelope');
  }

  const importedSignature = await importRegularFile(expectedSignatureFileName);
  assertCandidateChecksumSignature({
    checksumsBytes,
    signatureBytes: importedSignature.bytes,
  }, {
    trustedMinisignPublicKey,
    verifyMinisignImpl,
  });
  const signature = createBoundFileRecord({
    kind: 'minisign-signature',
    fileName: expectedSignatureFileName,
    filePath: importedSignature.destinationPath,
    bytes: importedSignature.bytes,
  });

  const [selectedOs, selectedArch] = target.split('-');
  const selectedArchive = importedArchives.find(
    (artifact) => artifact.os === selectedOs && artifact.arch === selectedArch,
  );
  if (!selectedArchive) {
    fail(`Supplied native matrix is missing selected target: ${target}`);
  }
  return {
    archivePath: selectedArchive.archivePath,
    archives: importedArchives,
    checksums: createBoundFileRecord({
      kind: 'sha256-checksums',
      fileName: expectedChecksumsFileName,
      filePath: checksumsPath,
      bytes: checksumsBytes,
    }),
    signature,
    notarization,
  };
}

async function writeFileAtomicallyWithoutOverwrite(destinationPath, bytes) {
  const stagingPath = join(
    dirname(destinationPath),
    `.${basename(destinationPath)}.stage-${process.pid}-${randomUUID()}`,
  );
  try {
    await writeFile(stagingPath, bytes, { flag: 'wx' });
    try {
      await link(stagingPath, destinationPath);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        fail(`Candidate output already exists: ${destinationPath}`);
      }
      throw error;
    }
  } finally {
    await unlink(stagingPath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }
}

function createBoundFileRecord({
  kind,
  fileName,
  filePath,
  bytes,
}) {
  return {
    kind,
    fileName,
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    filePath: resolve(filePath),
  };
}

async function readRegularCandidateSourceFile(filePath) {
  const stats = await lstat(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    fail(`Candidate installer source must be a regular file: ${filePath}`);
  }
  return await readFile(filePath);
}

export async function createCandidateInstallerArtifacts({
  monorepoRoot,
  destinationDir,
}) {
  const publishedDir = join(monorepoRoot, 'apps', 'website', 'public');
  const artifactDefinitions = [
    {
      field: 'shell',
      kind: 'shell',
      fileName: 'install-dev.sh',
    },
    {
      field: 'powershell',
      kind: 'powershell',
      fileName: 'install-dev.ps1',
    },
    {
      field: 'publicKey',
      kind: 'minisign-public-key',
      fileName: 'happier-release.pub',
    },
  ];
  const installerArtifacts = {
    releaseChannel: CANDIDATE_RELEASE_CHANNEL,
  };
  await mkdir(destinationDir);
  for (const definition of artifactDefinitions) {
    const publishedPath = join(publishedDir, definition.fileName);
    const publishedBytes = await readRegularCandidateSourceFile(publishedPath);
    const destinationPath = join(destinationDir, definition.fileName);
    await writeFileAtomicallyWithoutOverwrite(destinationPath, publishedBytes);
    installerArtifacts[definition.field] = createBoundFileRecord({
      kind: definition.kind,
      fileName: definition.fileName,
      filePath: destinationPath,
      bytes: publishedBytes,
    });
  }
  return installerArtifacts;
}

async function assertCurrentRunInstallerArtifacts({
  installers,
  runRoot,
}) {
  if (
    !installers
    || installers.releaseChannel !== CANDIDATE_RELEASE_CHANNEL
  ) {
    fail('Candidate installer artifacts must bind the assigned release channel');
  }
  const expected = [
    ['shell', 'shell', 'install-dev.sh'],
    ['powershell', 'powershell', 'install-dev.ps1'],
    ['publicKey', 'minisign-public-key', 'happier-release.pub'],
  ];
  for (const [field, kind, fileName] of expected) {
    const artifact = installers[field];
    if (
      !artifact
      || artifact.kind !== kind
      || artifact.fileName !== fileName
      || typeof artifact.filePath !== 'string'
      || !pathIsInside(runRoot, artifact.filePath)
      || basename(artifact.filePath) !== fileName
      || !Number.isSafeInteger(artifact.sizeBytes)
      || artifact.sizeBytes <= 0
      || typeof artifact.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/u.test(artifact.sha256)
    ) {
      fail(`Candidate installer artifact record is invalid: ${field}`);
    }
    const stats = await lstat(artifact.filePath);
    if (stats.isSymbolicLink() || !stats.isFile() || stats.size !== artifact.sizeBytes) {
      fail(`Candidate installer artifact is not a regular exact-size file: ${field}`);
    }
    const [physicalRunRoot, physicalArtifactPath, bytes] = await Promise.all([
      realpath(runRoot),
      realpath(artifact.filePath),
      readFile(artifact.filePath),
    ]);
    if (
      !pathIsInside(physicalRunRoot, physicalArtifactPath)
      || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256
    ) {
      fail(`Candidate installer artifact failed physical custody verification: ${field}`);
    }
  }
}

function assertCurrentRunCandidate({
  candidate,
  runId,
  runRoot,
  expectsStandaloneCli,
  nativeTarget,
  ownedStandaloneCliArtifactPath,
}) {
  if (candidate?.runId !== runId) {
    fail('Candidate manifest run id does not match the assigned run');
  }
  const artifactPaths = [
    candidate?.sdk?.tarballPath,
    candidate?.pluginUi?.tarballPath,
    candidate?.channelsProtocol?.tarballPath,
    candidate?.cli?.tarballPath,
    ...(candidate?.standaloneCli?.archives
      ? candidate.standaloneCli.archives.map((artifact) => artifact.archivePath)
      : []),
  ];
  if (artifactPaths.some((artifactPath) => (
    typeof artifactPath !== 'string'
    || !pathIsInside(runRoot, artifactPath)
  ))) {
    fail('Candidate manifest contains an artifact outside the current run root');
  }
  if (expectsStandaloneCli !== Boolean(candidate?.standaloneCli?.archivePath)) {
    fail('Candidate manifest standalone CLI identity does not match the explicit assigned input');
  }
  if (expectsStandaloneCli) {
    const [expectedOs, expectedArch] = nativeTarget.split('-');
    const expectedMatrixTargets = NATIVE_TARGETS.join(',');
    const actualMatrixTargets = candidate.standaloneCli.archives
      ?.map((artifact) => `${artifact.os}-${artifact.arch}`)
      .join(',');
    const selectedMatrixArtifact = candidate.standaloneCli.archives?.find(
      (artifact) => artifact.os === expectedOs && artifact.arch === expectedArch,
    );
    if (
      candidate.standaloneCli.product !== 'happier'
      || candidate.standaloneCli.version !== candidate.cli.version
      || candidate.standaloneCli.os !== expectedOs
      || candidate.standaloneCli.arch !== expectedArch
      || resolve(candidate.standaloneCli.archivePath)
        !== resolve(ownedStandaloneCliArtifactPath)
      || actualMatrixTargets !== expectedMatrixTargets
      || selectedMatrixArtifact?.sha256 !== candidate.standaloneCli.sha256
      || resolve(String(selectedMatrixArtifact?.archivePath ?? ''))
        !== resolve(candidate.standaloneCli.archivePath)
      || candidate.standaloneCli.notarization?.length !== DARWIN_NATIVE_TARGETS.length
      || candidate.standaloneCli.notarization.some((record, index) => (
        record?.target !== DARWIN_NATIVE_TARGETS[index]
        || record?.evidence?.kind !== 'apple-notarization-evidence'
        || record?.evidence?.fileName !== `${DARWIN_NATIVE_TARGETS[index]}.cli.json`
        || !pathIsInside(runRoot, record?.evidence?.filePath)
      ))
    ) {
      fail('Candidate manifest standalone CLI does not bind the full matrix and assigned target');
    }
  }
}

function createPortableCandidateManifest(candidate, runRoot) {
  const portablePath = (absolutePath) => {
    const path = relative(runRoot, resolve(absolutePath));
    if (
      !path
      || path === '..'
      || path.startsWith(`..${sep}`)
      || isAbsolute(path)
    ) {
      fail('Candidate manifest artifact path must stay inside its run root');
    }
    return path.split(sep).join('/');
  };
  const portableBoundFile = (artifact) => ({
    ...artifact,
    filePath: portablePath(artifact.filePath),
  });
  return {
    ...candidate,
    sdk: {
      ...candidate.sdk,
      tarballPath: portablePath(candidate.sdk.tarballPath),
    },
    pluginUi: {
      ...candidate.pluginUi,
      tarballPath: portablePath(candidate.pluginUi.tarballPath),
    },
    channelsProtocol: {
      ...candidate.channelsProtocol,
      tarballPath: portablePath(candidate.channelsProtocol.tarballPath),
    },
    cli: {
      ...candidate.cli,
      tarballPath: portablePath(candidate.cli.tarballPath),
    },
    installers: {
      ...candidate.installers,
      shell: portableBoundFile(candidate.installers.shell),
      powershell: portableBoundFile(candidate.installers.powershell),
      publicKey: portableBoundFile(candidate.installers.publicKey),
    },
    ...(candidate.standaloneCli
      ? {
          standaloneCli: {
            ...candidate.standaloneCli,
            archivePath: portablePath(candidate.standaloneCli.archivePath),
            archives: candidate.standaloneCli.archives.map((artifact) => ({
              ...artifact,
              archivePath: portablePath(artifact.archivePath),
            })),
            checksums: portableBoundFile(candidate.standaloneCli.checksums),
            signature: portableBoundFile(candidate.standaloneCli.signature),
            notarization: candidate.standaloneCli.notarization.map((record) => ({
              target: record.target,
              evidence: portableBoundFile(record.evidence),
            })),
          },
        }
      : {}),
  };
}

function resolveExportedTarballPath(destinationDir, metadata) {
  const tarballName = String(metadata?.tarball?.name ?? '').trim();
  if (
    !tarballName
    || tarballName !== basename(tarballName)
    || !tarballName.endsWith('.tgz')
  ) {
    fail('Canonical pack export returned an unsafe tarball name');
  }
  return join(destinationDir, tarballName);
}

async function exportPackedAuthorNpmArtifactsUnderLease({
  monorepoRoot,
  npmOutputDir,
  cliVersion = null,
  env,
  exportPackSandboxTarballImpl,
}) {
  const paths = {};
  const fileNames = [];
  for (const artifact of PACKED_AUTHOR_NPM_PACKAGES) {
    const expectedVersion = artifact.field === 'cli' ? cliVersion : null;
    const metadata = await exportPackSandboxTarballImpl({
      monorepoRoot,
      packageRelDir: artifact.packageRelDir,
      destinationDir: npmOutputDir,
      ...(expectedVersion ? { packageVersion: expectedVersion } : {}),
      env,
    });
    const actualVersion = String(metadata?.package?.version ?? '').trim();
    const expectedTarballName = `${artifact.tarballPrefix}-${actualVersion}.tgz`;
    if (
      metadata?.package?.name !== artifact.packageName
      || !actualVersion
      || actualVersion.length > 128
      || (expectedVersion !== null && actualVersion !== expectedVersion)
      || metadata?.tarball?.name !== expectedTarballName
    ) {
      fail(
        `Canonical pack export returned the wrong ${artifact.field.toUpperCase()} artifact identity`,
      );
    }
    paths[artifact.field] = resolveExportedTarballPath(npmOutputDir, metadata);
    fileNames.push(expectedTarballName);
  }
  return Object.freeze({
    paths: Object.freeze(paths),
    fileNames: Object.freeze(fileNames),
  });
}

export async function buildPackedAuthorNaturalArtifacts(
  {
    monorepoRoot,
    outputRoot,
    runId,
  },
  {
    exportPackSandboxTarballImpl = exportPackSandboxTarball,
    withCliDistBuildLockImpl = withCliDistBuildLock,
  } = {},
) {
  const normalizedRunId = validateRunId(String(runId ?? '').trim());
  const resolvedMonorepoRoot = resolve(String(monorepoRoot ?? '').trim());
  const resolvedOutputRoot = resolve(String(outputRoot ?? '').trim());
  if (!String(monorepoRoot ?? '').trim()) fail('Natural artifact monorepo root is required');
  if (!String(outputRoot ?? '').trim()) fail('Natural artifact output root is required');

  await mkdir(resolvedOutputRoot, { recursive: true });
  const outputRootStats = await lstat(resolvedOutputRoot);
  if (outputRootStats.isSymbolicLink() || !outputRootStats.isDirectory()) {
    fail('Natural artifact output root must be a real directory');
  }

  const runRoot = join(resolvedOutputRoot, normalizedRunId);
  let ownsRunRoot = false;
  try {
    try {
      await mkdir(runRoot);
      ownsRunRoot = true;
    } catch (error) {
      if (error?.code === 'EEXIST') {
        fail(`Natural artifact run root already exists: ${runRoot}`);
      }
      throw error;
    }

    const npmOutputDir = join(runRoot, 'npm');
    await mkdir(npmOutputDir);
    const lockPath = resolveCliDistBuildLockPath(resolvedMonorepoRoot);
    const exported = await withCliDistBuildLockImpl(
      async ({ heldLockValue }) => await exportPackedAuthorNpmArtifactsUnderLease({
        monorepoRoot: resolvedMonorepoRoot,
        npmOutputDir,
        env: {
          ...process.env,
          HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue,
        },
        exportPackSandboxTarballImpl,
      }),
      {
        lockPath,
        env: process.env,
      },
    );
    const actualNpmEntries = (await readdir(npmOutputDir))
      .sort((left, right) => left.localeCompare(right));
    const expectedNpmEntries = [...exported.fileNames]
      .sort((left, right) => left.localeCompare(right));
    if (
      actualNpmEntries.length !== expectedNpmEntries.length
      || actualNpmEntries.some((entry, index) => entry !== expectedNpmEntries[index])
    ) {
      fail('Natural artifact output must contain exactly the SDK, Plugin UI, Channels protocol, and CLI npm tarballs');
    }
    return {
      runId: normalizedRunId,
      sdkTarballPath: exported.paths.sdk,
      pluginUiTarballPath: exported.paths.pluginUi,
      channelsProtocolTarballPath: exported.paths.channelsProtocol,
      cliTarballPath: exported.paths.cli,
    };
  } catch (error) {
    if (ownsRunRoot) {
      await rm(runRoot, { recursive: true, force: true });
    }
    throw error;
  }
}

export async function buildPackedAuthorCandidate(
  {
    monorepoRoot,
    outputRoot,
    runId,
    nativeTarget = null,
    nativeArtifactsDir = null,
    standaloneCliArtifactPath = null,
  },
  {
    createPackedAuthorCandidateImpl = createPackedAuthorCandidate,
    createCandidateInstallerArtifactsImpl = createCandidateInstallerArtifacts,
    exportPackSandboxTarballImpl = exportPackSandboxTarball,
    importOwnedStandaloneCliMatrixImpl = importOwnedStandaloneCliMatrix,
    verifyReleaseArchiveAdmissionImpl = verifyReleaseArchiveAdmission,
    verifyDarwinNotarizationEvidenceImpl =
      verifyDarwinNotarizationEvidenceAgainstArchive,
    trustedMinisignPublicKey = DEFAULT_MINISIGN_PUBLIC_KEY,
    verifyMinisignImpl = verifyMinisign,
    withCliDistBuildLockImpl = withCliDistBuildLock,
  } = {},
) {
  const normalizedRunId = validateRunId(String(runId ?? '').trim());
  const resolvedMonorepoRoot = resolve(String(monorepoRoot ?? '').trim());
  const resolvedOutputRoot = resolve(String(outputRoot ?? '').trim());
  if (!String(monorepoRoot ?? '').trim()) fail('Candidate monorepo root is required');
  if (!String(outputRoot ?? '').trim()) fail('Candidate output root is required');
  if (standaloneCliArtifactPath) {
    fail(
      'This builder consumes the complete native matrix, not a borrowed standalone archive',
    );
  }
  const normalizedNativeTarget = validateNativeTarget(nativeTarget);
  const resolvedNativeArtifactsDir = nativeArtifactsDir
    ? resolve(String(nativeArtifactsDir))
    : null;
  if (!normalizedNativeTarget || !resolvedNativeArtifactsDir) {
    fail('Candidate assembly requires a selected native target and the complete native matrix');
  }
  if (typeof importOwnedStandaloneCliMatrixImpl !== 'function') {
    fail('Native matrix requires the exact supplied-artifact import owner');
  }

  await mkdir(resolvedOutputRoot, { recursive: true });
  const outputRootStats = await lstat(resolvedOutputRoot);
  if (outputRootStats.isSymbolicLink() || !outputRootStats.isDirectory()) {
    fail('Candidate output root must be a real directory');
  }

  const runRoot = join(resolvedOutputRoot, normalizedRunId);
  let ownsRunRoot = false;
  try {
    try {
      await mkdir(runRoot);
      ownsRunRoot = true;
    } catch (error) {
      if (error?.code === 'EEXIST') {
        fail(`Candidate run root already exists: ${runRoot}`);
      }
      throw error;
    }

    const npmOutputDir = join(runRoot, 'npm');
    const nativeOutputDir = join(runRoot, 'native');
    await mkdir(npmOutputDir);

    const lockPath = resolveCliDistBuildLockPath(resolvedMonorepoRoot);
    return await withCliDistBuildLockImpl(
      async ({ heldLockValue }) => {
        const inheritedEnv = {
          ...process.env,
          HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue,
        };
        const standaloneCliVersion = await resolveOwnedStandaloneCliMatrixVersion(
          resolvedNativeArtifactsDir,
        );
        const npmArtifacts = await exportPackedAuthorNpmArtifactsUnderLease({
          monorepoRoot: resolvedMonorepoRoot,
          npmOutputDir,
          cliVersion: standaloneCliVersion,
          env: inheritedEnv,
          exportPackSandboxTarballImpl,
        });
        const sdkTarballPath = npmArtifacts.paths.sdk;
        const pluginUiTarballPath = npmArtifacts.paths.pluginUi;
        const channelsProtocolTarballPath = npmArtifacts.paths.channelsProtocol;
        const cliTarballPath = npmArtifacts.paths.cli;

        const ownedStandaloneCliMatrix = await importOwnedStandaloneCliMatrixImpl({
          sourceDir: resolvedNativeArtifactsDir,
          destinationDir: nativeOutputDir,
          version: standaloneCliVersion,
          target: normalizedNativeTarget,
        }, {
          verifyReleaseArchiveAdmissionImpl,
          verifyDarwinNotarizationEvidenceImpl,
          trustedMinisignPublicKey,
          verifyMinisignImpl,
        });
        const ownedStandaloneCliArtifactPath = resolve(
          String(ownedStandaloneCliMatrix?.archivePath ?? ''),
        );
        if (
          !pathIsInside(nativeOutputDir, ownedStandaloneCliArtifactPath)
          || ownedStandaloneCliArtifactPath === resolve(nativeOutputDir)
        ) {
          fail('Native owner returned an archive outside the current run native output');
        }
        await ensureRegularOwnedArchive({
          archivePath: ownedStandaloneCliArtifactPath,
          ownedRoot: nativeOutputDir,
        });

        const attestedCandidate = await createPackedAuthorCandidateImpl({
          runId: normalizedRunId,
          sdkTarballPath,
          pluginUiTarballPath,
          channelsProtocolTarballPath,
          cliTarballPath,
        });
        const installers = await createCandidateInstallerArtifactsImpl({
          monorepoRoot: resolvedMonorepoRoot,
          destinationDir: join(runRoot, 'installers'),
          runId: normalizedRunId,
        });
        await assertCurrentRunInstallerArtifacts({
          installers,
          runRoot,
        });

        const candidate = {
          ...attestedCandidate,
          schemaVersion: 1,
          runId: normalizedRunId,
          standaloneCli: {
            ...ownedStandaloneCliMatrix.archives.find(
              (artifact) => resolve(artifact.archivePath)
                === ownedStandaloneCliArtifactPath,
            ),
            archivePath: ownedStandaloneCliArtifactPath,
            archives: ownedStandaloneCliMatrix.archives,
            checksums: ownedStandaloneCliMatrix.checksums,
            signature: ownedStandaloneCliMatrix.signature,
            notarization: ownedStandaloneCliMatrix.notarization,
          },
          installers,
        };
        assertCurrentRunCandidate({
          candidate,
          runId: normalizedRunId,
          runRoot,
          expectsStandaloneCli: true,
          nativeTarget: normalizedNativeTarget,
          ownedStandaloneCliArtifactPath,
        });

        const manifestPath = join(runRoot, 'candidate.json');
        await assertPackedAuthorCandidateManifestArtifacts(candidate, {
          manifestPath,
          trustedMinisignPublicKey,
          verifyMinisignImpl,
        });
        const portableCandidate = createPortableCandidateManifest(candidate, runRoot);
        await writeFileAtomicallyWithoutOverwrite(
          manifestPath,
          `${JSON.stringify(portableCandidate, null, 2)}\n`,
        );
        return {
          manifestPath,
          candidate,
        };
      },
      {
        lockPath,
        env: process.env,
      },
    );
  } catch (error) {
    if (ownsRunRoot) {
      await rm(runRoot, { recursive: true, force: true });
    }
    throw error;
  }
}

export async function main(
  argv = process.argv.slice(2),
  {
    buildPackedAuthorNaturalArtifactsImpl = buildPackedAuthorNaturalArtifacts,
    buildPackedAuthorCandidateImpl = buildPackedAuthorCandidate,
    monorepoRoot = fileURLToPath(new URL('../../../../', import.meta.url)),
    writeStdoutImpl = (value) => process.stdout.write(value),
    writeStderrImpl = (value) => process.stderr.write(value),
  } = {},
) {
  try {
    const mode = readOptionalFlag(argv, '--mode');
    if (mode !== null && mode !== 'natural') {
      fail(`Unsupported packed-author build mode: ${mode}`);
    }
    if (mode === 'natural') {
      const result = await buildPackedAuthorNaturalArtifactsImpl({
        monorepoRoot,
        ...parsePackedAuthorNaturalBuilderArgs(argv),
      });
      writeStdoutImpl(`${JSON.stringify({
        ok: true,
        ...result,
      }, null, 2)}\n`);
      return;
    }
    const result = await buildPackedAuthorCandidateImpl({
      monorepoRoot,
      ...parsePackedAuthorCandidateBuilderArgs(argv),
    });
    writeStdoutImpl(`${JSON.stringify({
      ok: true,
      manifestPath: result.manifestPath,
      candidate: result.candidate,
    }, null, 2)}\n`);
  } catch (error) {
    writeStderrImpl(
      `${basename(process.argv[1] ?? 'build-packed-author-candidate')}: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) await main();
