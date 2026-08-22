import assert from 'node:assert/strict';
import {
  createHash,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import {
  buildPackedAuthorNaturalArtifacts,
  buildPackedAuthorCandidate,
  createCandidateInstallerArtifacts,
  importOwnedStandaloneCliMatrix,
  main,
  parsePackedAuthorCandidateBuilderArgs,
  parsePackedAuthorNaturalBuilderArgs,
  resolveOwnedStandaloneCliMatrixVersion,
  verifyDarwinNotarizationEvidenceAgainstArchive,
} from './build-packed-author-candidate.mjs';
import {
  loadPackedAuthorCandidateManifest,
} from './run-packed-author-ui-compat.mjs';
import {
  snapshotDarwinPayload,
} from '../../../../scripts/pipeline/release/notarize-standalone-binary.mjs';

const RELEASED_NATIVE_TARGETS = Object.freeze([
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
  'windows-x64',
]);

const TEST_MINISIGN_KEY_ID = Buffer.from('0102030405060708', 'hex');
const TEST_MINISIGN_KEY_PAIR = generateKeyPairSync('ed25519');
const TEST_MINISIGN_RAW_PUBLIC_KEY = Buffer.from(
  TEST_MINISIGN_KEY_PAIR.publicKey.export({ format: 'der', type: 'spki' }),
).subarray(-32);
const TEST_MINISIGN_PUBLIC_KEY = [
  'untrusted comment: candidate fixture minisign public key',
  Buffer.concat([
    Buffer.from('Ed'),
    TEST_MINISIGN_KEY_ID,
    TEST_MINISIGN_RAW_PUBLIC_KEY,
  ]).toString('base64'),
  '',
].join('\n');

function signTestMinisign(message) {
  const signature = sign(null, message, TEST_MINISIGN_KEY_PAIR.privateKey);
  const trustedSuffix = Buffer.from('timestamp:0', 'utf8');
  const globalSignature = sign(
    null,
    Buffer.concat([signature, trustedSuffix]),
    TEST_MINISIGN_KEY_PAIR.privateKey,
  );
  return [
    'untrusted comment: candidate fixture signature',
    Buffer.concat([
      Buffer.from('Ed'),
      TEST_MINISIGN_KEY_ID,
      signature,
    ]).toString('base64'),
    `trusted comment: ${trustedSuffix.toString('utf8')}`,
    globalSignature.toString('base64'),
    '',
  ].join('\n');
}

function writeTarString(header, offset, length, value) {
  Buffer.from(value, 'utf8').copy(header, offset, 0, length);
}

function writeTarOctal(header, offset, length, value) {
  writeTarString(header, offset, length, value.toString(8).padStart(length - 1, '0'));
}

function createTarGzip(entries) {
  const blocks = [];
  for (const entry of entries) {
    const contents = Buffer.from(entry.contents ?? '', 'utf8');
    const header = Buffer.alloc(512);
    writeTarString(header, 0, 100, entry.name);
    writeTarOctal(header, 100, 8, 0o755);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, contents.length);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    writeTarString(header, 156, 1, entry.type ?? '0');
    writeTarString(header, 157, 100, entry.linkpath ?? '');
    writeTarString(header, 257, 6, 'ustar');
    writeTarString(header, 263, 2, '00');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeTarString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
    blocks.push(header, contents);
    if (contents.length % 512 !== 0) {
      blocks.push(Buffer.alloc(512 - (contents.length % 512)));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function candidateFor({
  runId,
  sdkTarballPath,
  pluginUiTarballPath,
  channelsProtocolTarballPath,
  cliTarballPath,
  standaloneCliArtifactPath = null,
  cliVersion = '0.2.10',
}) {
  return {
    schemaVersion: 1,
    runId,
    sdk: {
      packageName: '@happier-dev/plugin-sdk',
      version: '0.0.0',
      integrity: `sha512-${createHash('sha512')
        .update('exact:packages/plugin-sdk')
        .digest('base64')}`,
      tarballPath: sdkTarballPath,
    },
    pluginUi: {
      packageName: '@happier-dev/plugin-ui',
      version: '0.0.0',
      pluginSdkVersion: '0.0.0',
      integrity: `sha512-${createHash('sha512')
        .update('exact:packages/plugin-ui')
        .digest('base64')}`,
      tarballPath: pluginUiTarballPath,
    },
    ...(channelsProtocolTarballPath
      ? {
          channelsProtocol: {
            packageName: '@happier-dev/channels-protocol',
            version: '0.0.0',
            integrity: `sha512-${createHash('sha512')
              .update('exact:packages/channels-protocol')
              .digest('base64')}`,
            tarballPath: channelsProtocolTarballPath,
          },
        }
      : {}),
    cli: {
      packageName: '@happier-dev/cli',
      version: cliVersion,
      entrypoint: 'package/bin/happier.mjs',
      integrity: `sha512-${createHash('sha512')
        .update('exact:apps/cli')
        .digest('base64')}`,
      tarballPath: cliTarballPath,
    },
    ...(standaloneCliArtifactPath
      ? {
          standaloneCli: {
            product: 'happier',
            version: cliVersion,
            os: 'darwin',
            arch: 'arm64',
            sha256: createHash('sha256')
              .update('exact-native-bytes')
              .digest('hex'),
            archivePath: standaloneCliArtifactPath,
          },
        }
      : {}),
  };
}

function packedArtifactMetadata(packageRelDir, packageVersion = null) {
  if (packageRelDir === 'packages/plugin-sdk') {
    return {
      packageName: '@happier-dev/plugin-sdk',
      version: '0.0.0',
      tarballName: 'happier-dev-plugin-sdk-0.0.0.tgz',
    };
  }
  if (packageRelDir === 'packages/plugin-ui') {
    return {
      packageName: '@happier-dev/plugin-ui',
      version: '0.0.0',
      tarballName: 'happier-dev-plugin-ui-0.0.0.tgz',
    };
  }
  if (packageRelDir === 'packages/channels-protocol') {
    return {
      packageName: '@happier-dev/channels-protocol',
      version: '0.0.0',
      tarballName: 'happier-dev-channels-protocol-0.0.0.tgz',
    };
  }
  if (packageRelDir === 'apps/cli') {
    const version = packageVersion ?? '0.2.10';
    return {
      packageName: '@happier-dev/cli',
      version,
      tarballName: `happier-dev-cli-${version}.tgz`,
    };
  }
  throw new Error(`Unknown packed artifact fixture: ${packageRelDir}`);
}

async function writeTestInstallerArtifacts({ destinationDir }) {
  await mkdir(destinationDir, { recursive: true });
  const definitions = [
    ['shell', 'shell', 'install-dev.sh', 'candidate shell installer\n'],
    ['powershell', 'powershell', 'install-dev.ps1', 'candidate powershell installer\n'],
    ['publicKey', 'minisign-public-key', 'happier-release.pub', 'candidate public key\n'],
  ];
  const installers = {
    releaseChannel: 'dev',
  };
  for (const [field, kind, fileName, contents] of definitions) {
    const bytes = Buffer.from(contents);
    const filePath = join(destinationDir, fileName);
    await writeFile(filePath, bytes);
    installers[field] = {
      kind,
      fileName,
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      filePath,
    };
  }
  return installers;
}

async function writeTestPackedArtifact({
  packageRelDir,
  destinationDir,
  packageVersion = null,
}) {
  const { packageName, version, tarballName } = packedArtifactMetadata(packageRelDir, packageVersion);
  const bytes = `exact:${packageRelDir}`;
  await writeFile(join(destinationDir, tarballName), bytes);
  return {
    ok: true,
    package: { name: packageName, version },
    tarball: { name: tarballName, sizeBytes: bytes.length },
  };
}

async function writeAttestableTestPackedArtifact({
  packageRelDir,
  destinationDir,
  packageVersion = null,
}) {
  const { packageName, version, tarballName } = packedArtifactMetadata(packageRelDir, packageVersion);
  const bytes = createTarGzip([
    { name: 'package', type: '5' },
    {
      name: 'package/package.json',
      contents: JSON.stringify({
        name: packageName,
        version,
        ...(packageRelDir === 'packages/plugin-ui'
          ? { dependencies: { '@happier-dev/plugin-sdk': '0.0.0' } }
          : {}),
        ...(packageRelDir === 'packages/channels-protocol'
          ? {
              main: './dist/index.js',
              types: './dist/index.d.ts',
              exports: {
                '.': {
                  types: './dist/index.d.ts',
                  default: './dist/index.js',
                },
                './v1': {
                  types: './dist/v1/index.d.ts',
                  default: './dist/v1/index.js',
                },
                './testing/v1': {
                  types: './dist/testing/v1/index.d.ts',
                  default: './dist/testing/v1/index.js',
                },
              },
            }
          : {}),
        ...(packageRelDir === 'apps/cli' ? { bin: { happier: './bin/happier.mjs' } } : {}),
      }),
    },
    ...(packageRelDir === 'apps/cli'
      ? [
          { name: 'package/bin', type: '5' },
          {
            name: 'package/bin/happier.mjs',
            contents: '#!/usr/bin/env node\n',
          },
        ]
      : []),
  ]);
  await writeFile(join(destinationDir, tarballName), bytes);
  return {
    ok: true,
    package: { name: packageName, version },
    tarball: { name: tarballName, sizeBytes: bytes.length },
  };
}

async function writeTestNativeMatrix({
  destinationDir,
  version = '0.2.10',
  targets = RELEASED_NATIVE_TARGETS,
  includeDarwinNotarizationEvidence = false,
  includeSignature = true,
  archiveEntriesForTarget = (target) => [
    {
      name: `happier-v${version}-${target}`,
      type: '5',
    },
    {
      name: `happier-v${version}-${target}/happier${target.startsWith('windows-') ? '.exe' : ''}`,
      contents: `exact-native:${target}`,
    },
  ],
}) {
  await mkdir(destinationDir, { recursive: true });
  const entries = [];
  for (const target of targets) {
    const fileName = `happier-v${version}-${target}.tar.gz`;
    const bytes = createTarGzip(archiveEntriesForTarget(target));
    await writeFile(join(destinationDir, fileName), bytes);
    entries.push({
      target,
      fileName,
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  if (includeDarwinNotarizationEvidence) {
    for (const target of ['darwin-x64', 'darwin-arm64']) {
      const fileName = `${target}.cli.json`;
      const bytes = Buffer.from(
        `${JSON.stringify({
          schemaVersion: 2,
          payload: `happier-v${version}-${target}`,
          payloadSha256: target === 'darwin-x64' ? 'a'.repeat(64) : 'b'.repeat(64),
          entryCount: 2,
          machO: [{
            path: 'happier',
            sha256: target === 'darwin-x64' ? 'c'.repeat(64) : 'd'.repeat(64),
            executable: true,
          }],
          signingIdentity: 'Developer ID Application: Happier Dev (TEAMID)',
          notarization: {
            submissionId: `${target}-submission`,
            status: 'Accepted',
            archiveSha256: target === 'darwin-x64' ? 'e'.repeat(64) : 'f'.repeat(64),
            ticketDelivery: 'online',
            stapled: false,
          },
        }, null, 2)}\n`,
      );
      await writeFile(
        join(destinationDir, fileName),
        bytes,
      );
      entries.push({
        target,
        fileName,
        bytes,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
  }
  const checksumsBytes = Buffer.from(
    entries.map((entry) => `${entry.sha256}  ${entry.fileName}`).join('\n').concat('\n'),
  );
  await writeFile(
    join(destinationDir, `checksums-happier-v${version}.txt`),
    checksumsBytes,
  );
  if (includeSignature) {
    await writeFile(
      join(destinationDir, `checksums-happier-v${version}.txt.minisig`),
      signTestMinisign(checksumsBytes),
    );
  }
  return entries.filter((entry) => entry.fileName.endsWith('.tar.gz'));
}

async function rewriteTestNativeChecksums({
  sourceDir,
  version = '0.2.10',
  transform,
}) {
  const checksumsPath = join(sourceDir, `checksums-happier-v${version}.txt`);
  const lines = (await readFile(checksumsPath, 'utf8')).trim().split('\n');
  await writeFile(checksumsPath, `${transform(lines).join('\n')}\n`);
}

function nativeChecksumSetInvalidCases() {
  return [
    {
      name: 'missing',
      transform: (lines) => lines.filter((line) => !line.endsWith('darwin-x64.cli.json')),
    },
    {
      name: 'extra',
      transform: (lines) => [...lines, `${'1'.repeat(64)}  extra.cli.json`],
    },
    {
      name: 'wrong-name',
      transform: (lines) => lines.map((line) => (
        line.endsWith('darwin-x64.cli.json')
          ? line.replace('darwin-x64.cli.json', 'darwin-x86_64.cli.json')
          : line
      )),
    },
    {
      name: 'duplicate',
      transform: (lines) => [...lines.slice(0, -1), lines[0]],
    },
    {
      name: 'wrong-digest',
      transform: (lines) => lines.map((line) => (
        line.endsWith('darwin-arm64.cli.json')
          ? `${'2'.repeat(64)}  darwin-arm64.cli.json`
          : line
      )),
    },
  ];
}

test('native candidate version identity rejects mixed and duplicate release matrices', async () => {
  const root = await mkdtemp(join(tmpdir(), 'packed-candidate-version-identity-'));
  const mixedDir = join(root, 'mixed');
  const duplicateDir = join(root, 'duplicate');
  const invalidNameDir = join(root, 'invalid-name');
  const invalidSemverDir = join(root, 'invalid-semver');
  try {
    await writeTestNativeMatrix({ destinationDir: mixedDir });
    await rename(
      join(mixedDir, 'happier-v0.2.10-linux-x64.tar.gz'),
      join(mixedDir, 'happier-v0.2.10-dev.1770000000.42-linux-x64.tar.gz'),
    );
    await assert.rejects(
      resolveOwnedStandaloneCliMatrixVersion(mixedDir),
      /all five release archives at one exact version/u,
    );

    await writeTestNativeMatrix({ destinationDir: duplicateDir });
    await cp(
      join(duplicateDir, 'happier-v0.2.10-linux-x64.tar.gz'),
      join(duplicateDir, 'happier-v0.2.10-dev.1770000000.42-linux-x64.tar.gz'),
    );
    await assert.rejects(
      resolveOwnedStandaloneCliMatrixVersion(duplicateDir),
      /all five release archives at one exact version/u,
    );

    await writeTestNativeMatrix({ destinationDir: invalidNameDir });
    await writeFile(join(invalidNameDir, 'not-a-release-archive.tar.gz'), 'invalid-name');
    await assert.rejects(
      resolveOwnedStandaloneCliMatrixVersion(invalidNameDir),
      /all five release archives at one exact version/u,
    );

    await writeTestNativeMatrix({
      destinationDir: invalidSemverDir,
      version: '0.2.10-dev.01',
    });
    await assert.rejects(
      resolveOwnedStandaloneCliMatrixVersion(invalidSemverDir),
      /exact stable or allocated dev CLI version/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native candidate import requires the finalized matrix minisign artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'packed-candidate-required-signature-'));
  const sourceDir = join(root, 'source');
  const destinationDir = join(root, 'destination');
  try {
    await writeTestNativeMatrix({
      destinationDir: sourceDir,
      includeDarwinNotarizationEvidence: true,
      includeSignature: false,
    });
    await assert.rejects(
      importOwnedStandaloneCliMatrix({
        sourceDir,
        destinationDir,
        version: '0.2.10',
        target: 'darwin-arm64',
      }, {
        verifyReleaseArchiveAdmissionImpl: async () => [],
        verifyDarwinNotarizationEvidenceImpl: async () => {},
      }),
      /signature/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native candidate import rejects an unauthenticated minisign artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'packed-candidate-invalid-signature-'));
  const sourceDir = join(root, 'source');
  const destinationDir = join(root, 'destination');
  try {
    await writeTestNativeMatrix({
      destinationDir: sourceDir,
      includeDarwinNotarizationEvidence: true,
    });
    await writeFile(
      join(sourceDir, 'checksums-happier-v0.2.10.txt.minisig'),
      'candidate-minisign-signature\n',
    );
    await assert.rejects(
      importOwnedStandaloneCliMatrix({
        sourceDir,
        destinationDir,
        version: '0.2.10',
        target: 'darwin-arm64',
      }, {
        verifyReleaseArchiveAdmissionImpl: async () => [],
        verifyDarwinNotarizationEvidenceImpl: async () => {},
        trustedMinisignPublicKey: TEST_MINISIGN_PUBLIC_KEY,
      }),
      /signature/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native candidate import accepts only the canonical seven-entry checksum set', async () => {
  const root = await mkdtemp(join(tmpdir(), 'packed-candidate-checksum-envelope-'));
  const version = '0.2.10';
  const importMatrix = async (sourceDir, destinationName) => await importOwnedStandaloneCliMatrix({
    sourceDir,
    destinationDir: join(root, destinationName),
    version,
    target: 'darwin-arm64',
  }, {
    verifyReleaseArchiveAdmissionImpl: async () => [],
    verifyDarwinNotarizationEvidenceImpl: async () => {},
    trustedMinisignPublicKey: TEST_MINISIGN_PUBLIC_KEY,
  });
  try {
    const canonicalSourceDir = join(root, 'canonical-source');
    await writeTestNativeMatrix({
      destinationDir: canonicalSourceDir,
      includeDarwinNotarizationEvidence: true,
    });
    await assert.doesNotReject(importMatrix(canonicalSourceDir, 'canonical-destination'));

    for (const invalidCase of nativeChecksumSetInvalidCases()) {
      const sourceDir = join(root, `${invalidCase.name}-source`);
      await cp(canonicalSourceDir, sourceDir, { recursive: true });
      await rewriteTestNativeChecksums({
        sourceDir,
        version,
        transform: invalidCase.transform,
      });
      await assert.rejects(
        importMatrix(sourceDir, `${invalidCase.name}-destination`),
        /exact seven-artifact release envelope/u,
        invalidCase.name,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ordinary natural builder exports the exact SDK/Plugin UI/Channels protocol/CLI set under one canonical lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'packed-natural-builder-'));
  const monorepoRoot = join(root, 'repo');
  const outputRoot = join(root, 'output');
  const lockCalls = [];
  const packCalls = [];
  try {
    await mkdir(monorepoRoot, { recursive: true });
    const result = await buildPackedAuthorNaturalArtifacts({
      monorepoRoot,
      outputRoot,
      runId: 'natural-pair-1',
    }, {
      withCliDistBuildLockImpl: async (callback, options) => {
        lockCalls.push(options);
        return await callback({
          waited: false,
          heldLockValue: 'natural-pair-lease',
          inherited: false,
        });
      },
      exportPackSandboxTarballImpl: async ({
        packageRelDir,
        destinationDir,
        env,
      }) => {
        packCalls.push({ packageRelDir, destinationDir });
        assert.equal(
          env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD,
          'natural-pair-lease',
        );
        return await writeTestPackedArtifact({ packageRelDir, destinationDir });
      },
    });

    const runRoot = join(outputRoot, 'natural-pair-1');
    const npmRoot = join(runRoot, 'npm');
    assert.equal(lockCalls.length, 1);
    assert.deepEqual(
      packCalls.map(({ packageRelDir }) => packageRelDir),
      [
        'packages/plugin-sdk',
        'packages/plugin-ui',
        'packages/channels-protocol',
        'apps/cli',
      ],
    );
    assert.deepEqual(await readdir(runRoot), ['npm']);
    assert.deepEqual((await readdir(npmRoot)).sort(), [
      'happier-dev-channels-protocol-0.0.0.tgz',
      'happier-dev-cli-0.2.10.tgz',
      'happier-dev-plugin-sdk-0.0.0.tgz',
      'happier-dev-plugin-ui-0.0.0.tgz',
    ]);
    assert.deepEqual(result, {
      runId: 'natural-pair-1',
      sdkTarballPath: join(
        npmRoot,
        'happier-dev-plugin-sdk-0.0.0.tgz',
      ),
      pluginUiTarballPath: join(
        npmRoot,
        'happier-dev-plugin-ui-0.0.0.tgz',
      ),
      channelsProtocolTarballPath: join(
        npmRoot,
        'happier-dev-channels-protocol-0.0.0.tgz',
      ),
      cliTarballPath: join(npmRoot, 'happier-dev-cli-0.2.10.tgz'),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ordinary natural builder removes its run root when canonical pack identity is wrong', async () => {
  const root = await mkdtemp(join(tmpdir(), 'packed-natural-builder-wrong-identity-'));
  const monorepoRoot = join(root, 'repo');
  const outputRoot = join(root, 'output');
  try {
    await mkdir(monorepoRoot, { recursive: true });
    await assert.rejects(
      buildPackedAuthorNaturalArtifacts({
        monorepoRoot,
        outputRoot,
        runId: 'natural-wrong-identity',
      }, {
        withCliDistBuildLockImpl: async (callback) => await callback({
          waited: false,
          heldLockValue: 'natural-pair-lease',
          inherited: false,
        }),
        exportPackSandboxTarballImpl: async (params) => {
          const metadata = await writeTestPackedArtifact(params);
          return params.packageRelDir === 'apps/cli'
            ? {
                ...metadata,
                package: {
                  ...metadata.package,
                  version: '0.2.9',
                },
              }
            : metadata;
        },
      }),
      /wrong CLI artifact identity/u,
    );
    assert.equal(
      existsSync(join(outputRoot, 'natural-wrong-identity')),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('buildPackedAuthorCandidate rejects missing native-matrix arguments before output mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'packed-candidate-builder-'));
  const monorepoRoot = join(root, 'repo');
  const outputRoot = join(root, 'output');
  try {
    await mkdir(monorepoRoot, { recursive: true });
    await mkdir(outputRoot);
    let lockAcquired = false;
    await assert.rejects(
      buildPackedAuthorCandidate({
        monorepoRoot,
        outputRoot,
        runId: 'r447-g9-assigned',
      }, {
        withCliDistBuildLockImpl: async () => {
          lockAcquired = true;
          throw new Error('must not acquire candidate build lock');
        },
      }),
      /complete native matrix/u,
    );
    assert.equal(lockAcquired, false);
    assert.deepEqual(await readdir(outputRoot), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('buildPackedAuthorCandidate uses the downloaded qualified native candidate version for the packed CLI and canonical release envelope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'packed-candidate-native-matrix-'));
  const monorepoRoot = join(root, 'repo');
  const outputRoot = join(root, 'output');
  const suppliedArtifactsDir = join(root, 'supplied-native');
  const candidateVersion = '0.2.10-dev.1770000000.42';
  try {
    await mkdir(join(monorepoRoot, 'apps', 'cli'), { recursive: true });
    await writeFile(
      join(monorepoRoot, 'apps', 'cli', 'package.json'),
      JSON.stringify({ name: '@happier-dev/cli', version: '0.2.10' }),
    );
    await mkdir(outputRoot);
    const supplied = await writeTestNativeMatrix({
      destinationDir: suppliedArtifactsDir,
      version: candidateVersion,
      includeDarwinNotarizationEvidence: true,
    });
    const verifiedDarwinEvidence = [];

    const result = await buildPackedAuthorCandidate({
      monorepoRoot,
      outputRoot,
      runId: 'r447-g9-matrix',
      nativeTarget: 'darwin-arm64',
      nativeArtifactsDir: suppliedArtifactsDir,
    }, {
      withCliDistBuildLockImpl: async (callback) => await callback({
        heldLockValue: 'authenticated-inherited-lease',
      }),
      exportPackSandboxTarballImpl: writeAttestableTestPackedArtifact,
      createCandidateInstallerArtifactsImpl: writeTestInstallerArtifacts,
      verifyDarwinNotarizationEvidenceImpl: async (params) => {
        verifiedDarwinEvidence.push({
          archiveName: params.archiveName,
          evidenceFileName: params.evidenceFileName,
          target: params.target,
        });
      },
      trustedMinisignPublicKey: TEST_MINISIGN_PUBLIC_KEY,
    });

    assert.deepEqual(
      result.candidate.standaloneCli.archives.map(
        ({ os, arch }) => `${os}-${arch}`,
      ),
      RELEASED_NATIVE_TARGETS,
    );
    for (const entry of supplied) {
      const [os, arch] = entry.target.split('-');
      const bound = result.candidate.standaloneCli.archives.find(
        (artifact) => artifact.os === os && artifact.arch === arch,
      );
      assert.ok(bound);
      assert.equal(bound.sha256, entry.sha256);
      assert.equal(
        await readFile(bound.archivePath, 'utf8'),
        entry.bytes.toString('utf8'),
      );
      assert.equal(
        bound.archivePath,
        join(outputRoot, 'r447-g9-matrix', 'native', entry.fileName),
      );
    }
    assert.equal(
      result.candidate.standaloneCli.archivePath,
      join(
        outputRoot,
        'r447-g9-matrix',
        'native',
        `happier-v${candidateVersion}-darwin-arm64.tar.gz`,
      ),
    );
    assert.deepEqual(verifiedDarwinEvidence, [
      {
        archiveName: `happier-v${candidateVersion}-darwin-x64.tar.gz`,
        evidenceFileName: 'darwin-x64.cli.json',
        target: 'darwin-x64',
      },
      {
        archiveName: `happier-v${candidateVersion}-darwin-arm64.tar.gz`,
        evidenceFileName: 'darwin-arm64.cli.json',
        target: 'darwin-arm64',
      },
    ]);
    assert.deepEqual(
      result.candidate.standaloneCli.notarization.map(({ target, evidence }) => ({
        target,
        fileName: evidence.fileName,
        kind: evidence.kind,
      })),
      [
        {
          target: 'darwin-x64',
          fileName: 'darwin-x64.cli.json',
          kind: 'apple-notarization-evidence',
        },
        {
          target: 'darwin-arm64',
          fileName: 'darwin-arm64.cli.json',
          kind: 'apple-notarization-evidence',
        },
      ],
    );

    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    assert.equal(manifest.sdk.tarballPath, 'npm/happier-dev-plugin-sdk-0.0.0.tgz');
    assert.equal(manifest.pluginUi.tarballPath, 'npm/happier-dev-plugin-ui-0.0.0.tgz');
    assert.equal(manifest.pluginUi.pluginSdkVersion, manifest.sdk.version);
    assert.equal(
      manifest.cli.tarballPath,
      `npm/happier-dev-cli-${candidateVersion}.tgz`,
    );
    assert.equal(manifest.cli.version, candidateVersion);
    assert.equal(
      manifest.standaloneCli.archivePath,
      `native/happier-v${candidateVersion}-darwin-arm64.tar.gz`,
    );
    assert.equal(
      manifest.standaloneCli.notarization[0].evidence.filePath,
      'native/darwin-x64.cli.json',
    );
    const transferredRunRoot = join(root, 'transferred-run-root');
    await cp(join(outputRoot, 'r447-g9-matrix'), transferredRunRoot, {
      recursive: true,
    });
    const transferredCandidate = await loadPackedAuthorCandidateManifest(
      ['--candidate', join(transferredRunRoot, 'candidate.json')],
      {
        cwd: root,
        trustedMinisignPublicKey: TEST_MINISIGN_PUBLIC_KEY,
      },
    );
    assert.equal(
      transferredCandidate.standaloneCli.archivePath,
      join(
        transferredRunRoot,
        'native',
        `happier-v${candidateVersion}-darwin-arm64.tar.gz`,
      ),
    );
    assert.equal(
      transferredCandidate.standaloneCli.notarization[0].evidence.filePath,
      join(transferredRunRoot, 'native', 'darwin-x64.cli.json'),
    );
    for (const invalidCase of nativeChecksumSetInvalidCases()) {
      const invalidRunRoot = join(root, `transferred-${invalidCase.name}`);
      await cp(join(outputRoot, 'r447-g9-matrix'), invalidRunRoot, {
        recursive: true,
      });
      await rewriteTestNativeChecksums({
        sourceDir: join(invalidRunRoot, 'native'),
        version: candidateVersion,
        transform: invalidCase.transform,
      });
      const invalidChecksumsPath = join(
        invalidRunRoot,
        'native',
        `checksums-happier-v${candidateVersion}.txt`,
      );
      const invalidChecksumsBytes = await readFile(invalidChecksumsPath);
      const invalidManifest = JSON.parse(
        await readFile(join(invalidRunRoot, 'candidate.json'), 'utf8'),
      );
      invalidManifest.standaloneCli.checksums = {
        ...invalidManifest.standaloneCli.checksums,
        sizeBytes: invalidChecksumsBytes.length,
        sha256: createHash('sha256').update(invalidChecksumsBytes).digest('hex'),
      };
      await writeFile(
        join(invalidRunRoot, 'candidate.json'),
        `${JSON.stringify(invalidManifest, null, 2)}\n`,
      );
      await assert.rejects(
        loadPackedAuthorCandidateManifest(
          ['--candidate', join(invalidRunRoot, 'candidate.json')],
          {
            cwd: root,
            trustedMinisignPublicKey: TEST_MINISIGN_PUBLIC_KEY,
          },
        ),
        /exact seven-artifact release envelope/u,
        invalidCase.name,
      );
    }
    const renamedArchiveRunRoot = join(root, 'transferred-renamed-archive');
    await cp(join(outputRoot, 'r447-g9-matrix'), renamedArchiveRunRoot, {
      recursive: true,
    });
    const canonicalArchiveName = `happier-v${candidateVersion}-linux-x64.tar.gz`;
    const renamedArchiveName = `happier-v${candidateVersion}-linux-x86_64.tar.gz`;
    await rename(
      join(renamedArchiveRunRoot, 'native', canonicalArchiveName),
      join(renamedArchiveRunRoot, 'native', renamedArchiveName),
    );
    await rewriteTestNativeChecksums({
      sourceDir: join(renamedArchiveRunRoot, 'native'),
      version: candidateVersion,
      transform: (lines) => lines.map((line) => (
        line.endsWith(canonicalArchiveName)
          ? line.replace(canonicalArchiveName, renamedArchiveName)
          : line
      )),
    });
    const renamedArchiveChecksumsPath = join(
      renamedArchiveRunRoot,
      'native',
      `checksums-happier-v${candidateVersion}.txt`,
    );
    const renamedArchiveChecksumsBytes = await readFile(renamedArchiveChecksumsPath);
    const renamedArchiveManifest = JSON.parse(
      await readFile(join(renamedArchiveRunRoot, 'candidate.json'), 'utf8'),
    );
    renamedArchiveManifest.standaloneCli.archives[0].archivePath =
      `native/${renamedArchiveName}`;
    renamedArchiveManifest.standaloneCli.checksums = {
      ...renamedArchiveManifest.standaloneCli.checksums,
      sizeBytes: renamedArchiveChecksumsBytes.length,
      sha256: createHash('sha256').update(renamedArchiveChecksumsBytes).digest('hex'),
    };
    await writeFile(
      join(renamedArchiveRunRoot, 'candidate.json'),
      `${JSON.stringify(renamedArchiveManifest, null, 2)}\n`,
    );
    await assert.rejects(
      loadPackedAuthorCandidateManifest(
        ['--candidate', join(renamedArchiveRunRoot, 'candidate.json')],
        {
          cwd: root,
          trustedMinisignPublicKey: TEST_MINISIGN_PUBLIC_KEY,
        },
      ),
      /exact canonical archive name/u,
    );
    await writeFile(
      join(transferredRunRoot, 'candidate.json'),
      `${JSON.stringify({
        ...manifest,
        standaloneCli: {
          ...manifest.standaloneCli,
          signature: null,
        },
      }, null, 2)}\n`,
    );
    await assert.rejects(
      loadPackedAuthorCandidateManifest(
        ['--candidate', join(transferredRunRoot, 'candidate.json')],
        {
          cwd: root,
          trustedMinisignPublicKey: TEST_MINISIGN_PUBLIC_KEY,
        },
      ),
      /signature/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('candidate Darwin evidence admission matches accepted evidence to the exact archived payload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'packed-candidate-darwin-evidence-'));
  try {
    const payloadName = 'happier-v0.2.10-darwin-x64';
    const stagedPayload = join(root, payloadName);
    const executableBytes = Buffer.concat([
      Buffer.from('feedfacf', 'hex'),
      Buffer.from('candidate-darwin-executable'),
    ]);
    await mkdir(stagedPayload);
    await writeFile(join(stagedPayload, 'happier'), executableBytes);
    await chmod(join(stagedPayload, 'happier'), 0o755);
    const snapshot = snapshotDarwinPayload(stagedPayload);
    const archiveName = `${payloadName}.tar.gz`;
    const archivePath = join(root, archiveName);
    await writeFile(archivePath, createTarGzip([
      { name: payloadName, type: '5' },
      { name: `${payloadName}/happier`, contents: executableBytes },
    ]));
    const evidenceFileName = 'darwin-x64.cli.json';
    const evidencePath = join(root, evidenceFileName);
    await writeFile(evidencePath, `${JSON.stringify({
      schemaVersion: 2,
      payload: payloadName,
      ...snapshot,
      signingIdentity: 'Developer ID Application: Happier Dev (TEAMID)',
      notarization: {
        submissionId: 'candidate-darwin-x64',
        status: 'Accepted',
        archiveSha256: 'a'.repeat(64),
        ticketDelivery: 'online',
        stapled: false,
      },
    }, null, 2)}\n`);

    await verifyDarwinNotarizationEvidenceAgainstArchive({
      archivePath,
      archiveName,
      evidencePath,
      evidenceFileName,
      target: 'darwin-x64',
    });
    const tampered = JSON.parse(await readFile(evidencePath, 'utf8'));
    tampered.payloadSha256 = 'b'.repeat(64);
    await writeFile(evidencePath, `${JSON.stringify(tampered, null, 2)}\n`);
    await assert.rejects(
      verifyDarwinNotarizationEvidenceAgainstArchive({
        archivePath,
        archiveName,
        evidencePath,
        evidenceFileName,
        target: 'darwin-x64',
      }),
      /does not match the exact staged payload/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('buildPackedAuthorCandidate rejects and removes a partial supplied native matrix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'packed-candidate-partial-native-matrix-'));
  const monorepoRoot = join(root, 'repo');
  const outputRoot = join(root, 'output');
  const suppliedArtifactsDir = join(root, 'supplied-native');
  try {
    await mkdir(join(monorepoRoot, 'apps', 'cli'), { recursive: true });
    await writeFile(
      join(monorepoRoot, 'apps', 'cli', 'package.json'),
      JSON.stringify({ name: '@happier-dev/cli', version: '0.2.10' }),
    );
    await mkdir(outputRoot);
    await writeTestNativeMatrix({
      destinationDir: suppliedArtifactsDir,
      targets: RELEASED_NATIVE_TARGETS.slice(0, -1),
    });

    await assert.rejects(
      buildPackedAuthorCandidate({
        monorepoRoot,
        outputRoot,
        runId: 'r447-g9-partial-matrix',
        nativeTarget: 'darwin-arm64',
        nativeArtifactsDir: suppliedArtifactsDir,
      }, {
        withCliDistBuildLockImpl: async (callback) => await callback({
          heldLockValue: 'authenticated-inherited-lease',
        }),
        exportPackSandboxTarballImpl: writeTestPackedArtifact,
      }),
      /all five release archives/u,
    );
    assert.equal(
      existsSync(join(outputRoot, 'r447-g9-partial-matrix')),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('buildPackedAuthorCandidate rejects traversal in an unselected native matrix member', async () => {
  const root = await mkdtemp(join(tmpdir(), 'packed-candidate-unsafe-native-matrix-'));
  const monorepoRoot = join(root, 'repo');
  const outputRoot = join(root, 'output');
  const suppliedArtifactsDir = join(root, 'supplied-native');
  try {
    await mkdir(join(monorepoRoot, 'apps', 'cli'), { recursive: true });
    await writeFile(
      join(monorepoRoot, 'apps', 'cli', 'package.json'),
      JSON.stringify({ name: '@happier-dev/cli', version: '0.2.10' }),
    );
    await mkdir(outputRoot);
    await writeTestNativeMatrix({
      destinationDir: suppliedArtifactsDir,
      includeDarwinNotarizationEvidence: true,
      archiveEntriesForTarget: (target) => target === 'linux-x64'
        ? [{
            name: 'happier-v0.2.10-linux-x64/../outside',
            contents: 'escape',
          }]
        : [{
            name: `happier-v0.2.10-${target}`,
            type: '5',
          }, {
            name: `happier-v0.2.10-${target}/happier${target.startsWith('windows-') ? '.exe' : ''}`,
            contents: `exact-native:${target}`,
          }],
    });

    await assert.rejects(
      buildPackedAuthorCandidate({
        monorepoRoot,
        outputRoot,
        runId: 'r447-g9-unsafe-matrix',
        nativeTarget: 'darwin-arm64',
        nativeArtifactsDir: suppliedArtifactsDir,
      }, {
        withCliDistBuildLockImpl: async (callback) => await callback({
          heldLockValue: 'authenticated-inherited-lease',
        }),
        exportPackSandboxTarballImpl: writeTestPackedArtifact,
        createPackedAuthorCandidateImpl: async (params) => {
          const candidate = candidateFor(params);
          const archiveBytes = await readFile(params.standaloneCliArtifactPath);
          candidate.standaloneCli.sha256 = createHash('sha256')
            .update(archiveBytes)
            .digest('hex');
          return candidate;
        },
        createCandidateInstallerArtifactsImpl: writeTestInstallerArtifacts,
      }),
      /archive topology admission failed/iu,
    );
    assert.equal(
      existsSync(join(outputRoot, 'r447-g9-unsafe-matrix')),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('buildPackedAuthorCandidate rejects foreign target layout in an unselected matrix member', async () => {
  const root = await mkdtemp(join(tmpdir(), 'packed-candidate-foreign-native-matrix-'));
  const monorepoRoot = join(root, 'repo');
  const outputRoot = join(root, 'output');
  const suppliedArtifactsDir = join(root, 'supplied-native');
  try {
    await mkdir(join(monorepoRoot, 'apps', 'cli'), { recursive: true });
    await writeFile(
      join(monorepoRoot, 'apps', 'cli', 'package.json'),
      JSON.stringify({ name: '@happier-dev/cli', version: '0.2.10' }),
    );
    await mkdir(outputRoot);
    await writeTestNativeMatrix({
      destinationDir: suppliedArtifactsDir,
      includeDarwinNotarizationEvidence: true,
      archiveEntriesForTarget: (target) => {
        const payloadTarget = target === 'linux-x64' ? 'darwin-arm64' : target;
        return [
          {
            name: `happier-v0.2.10-${payloadTarget}`,
            type: '5',
          },
          {
            name: `happier-v0.2.10-${payloadTarget}/happier`,
            contents: `exact-native:${payloadTarget}`,
          },
        ];
      },
    });

    await assert.rejects(
      buildPackedAuthorCandidate({
        monorepoRoot,
        outputRoot,
        runId: 'r447-g9-foreign-matrix',
        nativeTarget: 'darwin-arm64',
        nativeArtifactsDir: suppliedArtifactsDir,
      }, {
        withCliDistBuildLockImpl: async (callback) => await callback({
          heldLockValue: 'authenticated-inherited-lease',
        }),
        exportPackSandboxTarballImpl: writeTestPackedArtifact,
        createPackedAuthorCandidateImpl: async (params) => {
          const candidate = candidateFor(params);
          const archiveBytes = await readFile(params.standaloneCliArtifactPath);
          candidate.standaloneCli.sha256 = createHash('sha256')
            .update(archiveBytes)
            .digest('hex');
          return candidate;
        },
        createCandidateInstallerArtifactsImpl: writeTestInstallerArtifacts,
      }),
      /payload root does not match its artifact name/iu,
    );
    assert.equal(
      existsSync(join(outputRoot, 'r447-g9-foreign-matrix')),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('buildPackedAuthorCandidate rejects a borrowed standalone archive before lock or output mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'packed-candidate-builder-borrowed-native-'));
  const monorepoRoot = join(root, 'repo');
  const outputRoot = join(root, 'output');
  const borrowedArchivePath = join(root, 'older-run', 'happier-v0.2.10-darwin-arm64.tar.gz');
  let acquired = false;
  try {
    await mkdir(monorepoRoot, { recursive: true });
    await mkdir(dirname(borrowedArchivePath), { recursive: true });
    await writeFile(borrowedArchivePath, 'stale but same-version');

    await assert.rejects(
      buildPackedAuthorCandidate({
        monorepoRoot,
        outputRoot,
        runId: 'r447-no-borrow',
        standaloneCliArtifactPath: borrowedArchivePath,
      }, {
        withCliDistBuildLockImpl: async () => {
          acquired = true;
        },
      }),
      /complete native matrix, not a borrowed standalone archive/i,
    );

    assert.equal(acquired, false);
    assert.equal(existsSync(outputRoot), false);
    assert.equal(await readFile(borrowedArchivePath, 'utf8'), 'stale but same-version');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('buildPackedAuthorCandidate refuses an old run root without acquiring the shared lock or deleting it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'packed-candidate-builder-old-run-'));
  const monorepoRoot = join(root, 'repo');
  const outputRoot = join(root, 'output');
  const runRoot = join(outputRoot, 'r447-existing');
  const sentinelPath = join(runRoot, 'old-candidate.txt');
  let acquired = false;
  try {
    await mkdir(monorepoRoot, { recursive: true });
    await mkdir(runRoot, { recursive: true });
    await writeFile(sentinelPath, 'old candidate');

    await assert.rejects(
      buildPackedAuthorCandidate({
        monorepoRoot,
        outputRoot,
        runId: 'r447-existing',
        nativeTarget: 'darwin-arm64',
        nativeArtifactsDir: join(root, 'unused-native-matrix'),
      }, {
        withCliDistBuildLockImpl: async () => {
          acquired = true;
        },
      }),
      /run root already exists/i,
    );

    assert.equal(acquired, false);
    assert.equal(await readFile(sentinelPath, 'utf8'), 'old candidate');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('buildPackedAuthorCandidate rejects a mixed-root manifest before announcement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'packed-candidate-builder-mixed-'));
  const monorepoRoot = join(root, 'repo');
  const outputRoot = join(root, 'output');
  const nativeArtifactsDir = join(root, 'native-matrix');
  try {
    await mkdir(monorepoRoot, { recursive: true });
    await mkdir(outputRoot);
    await writeTestNativeMatrix({
      destinationDir: nativeArtifactsDir,
      includeDarwinNotarizationEvidence: true,
    });

    await assert.rejects(
      buildPackedAuthorCandidate({
        monorepoRoot,
        outputRoot,
        runId: 'r447-mixed-root',
        nativeTarget: 'darwin-arm64',
        nativeArtifactsDir,
      }, {
        withCliDistBuildLockImpl: async (callback) => await callback({
          waited: false,
          heldLockValue: 'lease',
          inherited: false,
        }),
        exportPackSandboxTarballImpl: writeTestPackedArtifact,
        createPackedAuthorCandidateImpl: async (params) => ({
          ...candidateFor(params),
          cli: {
            ...candidateFor(params).cli,
            tarballPath: join(root, 'older-run', 'cli.tgz'),
          },
        }),
        createCandidateInstallerArtifactsImpl: writeTestInstallerArtifacts,
        verifyDarwinNotarizationEvidenceImpl: async () => {},
        trustedMinisignPublicKey: TEST_MINISIGN_PUBLIC_KEY,
      }),
      /outside the current run root/i,
    );

    assert.equal(existsSync(join(outputRoot, 'r447-mixed-root')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createCandidateInstallerArtifacts copies and binds only exact published dev projections', async () => {
  const root = await mkdtemp(join(tmpdir(), 'packed-candidate-installers-'));
  const monorepoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  const destinationDir = join(root, 'installers');
  try {
    const installers = await createCandidateInstallerArtifacts({
      monorepoRoot,
      destinationDir,
      runId: 'r447-installer-projections',
    });
    for (const [field, fileName] of [
      ['shell', 'install-dev.sh'],
      ['powershell', 'install-dev.ps1'],
      ['publicKey', 'happier-release.pub'],
    ]) {
      const [publishedBytes, candidateBytes] = await Promise.all([
        readFile(join(monorepoRoot, 'apps', 'website', 'public', fileName)),
        readFile(installers[field].filePath),
      ]);
      assert.deepEqual(candidateBytes, publishedBytes);
      assert.equal(installers[field].fileName, fileName);
      assert.equal(
        installers[field].sha256,
        createHash('sha256').update(publishedBytes).digest('hex'),
      );
      assert.equal(installers[field].sizeBytes, publishedBytes.length);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('parsePackedAuthorCandidateBuilderArgs requires explicit assigned inputs', () => {
  assert.deepEqual(
    parsePackedAuthorCandidateBuilderArgs([
      '--run-id',
      'r447-g9',
      '--output-root',
      '../candidate-root',
      '--native-target',
      'darwin-arm64',
      '--native-artifacts-dir',
      '../native-matrix',
    ], {
      cwd: '/workspace/packages/tests',
    }),
    {
      runId: 'r447-g9',
      outputRoot: '/workspace/packages/candidate-root',
      nativeTarget: 'darwin-arm64',
      nativeArtifactsDir: '/workspace/packages/native-matrix',
    },
  );
  assert.throws(
    () => parsePackedAuthorCandidateBuilderArgs([
      '--run-id',
      'r447-g9',
    ]),
    /--output-root/u,
  );
  assert.throws(
    () => parsePackedAuthorCandidateBuilderArgs([
      '--run-id',
      'r447-g9',
      '--output-root',
      '../candidate-root',
    ]),
    /native-target/u,
  );
  assert.throws(
    () => parsePackedAuthorCandidateBuilderArgs([
      '--run-id',
      'r447-g9',
      '--output-root',
      '../candidate-root',
      '--native-target',
      'darwin-arm64',
    ]),
    /native-artifacts-dir/u,
  );
});

test('natural builder CLI mode exposes only run/output inputs and delegates to the paired owner', async () => {
  assert.deepEqual(
    parsePackedAuthorNaturalBuilderArgs([
      '--mode',
      'natural',
      '--run-id',
      'natural-cli-1',
      '--output-root',
      '../natural-root',
    ], {
      cwd: '/workspace/packages/tests',
    }),
    {
      runId: 'natural-cli-1',
      outputRoot: '/workspace/packages/natural-root',
    },
  );
  assert.throws(
    () => parsePackedAuthorNaturalBuilderArgs([
      '--mode',
      'natural',
      '--run-id',
      'natural-cli-1',
      '--output-root',
      '/tmp/natural-root',
      '--native-target',
      'darwin-arm64',
    ]),
    /SDK, Plugin UI, Channels protocol, and CLI npm/u,
  );

  const testsPackageManifest = JSON.parse(await readFile(
    new URL('../../package.json', import.meta.url),
    'utf8',
  ));
  assert.equal(
    testsPackageManifest.scripts['build:plugin-platform:natural'],
    'node scripts/plugin-platform/build-packed-author-candidate.mjs --mode natural',
  );

  const calls = [];
  const output = [];
  await main([
    '--mode',
    'natural',
    '--run-id',
    'natural-cli-1',
    '--output-root',
    '/tmp/natural-root',
  ], {
    monorepoRoot: '/workspace/happier',
    buildPackedAuthorNaturalArtifactsImpl: async (params) => {
      calls.push(params);
      return {
        runId: params.runId,
        sdkTarballPath:
          '/tmp/natural-root/natural-cli-1/npm/happier-dev-plugin-sdk-0.0.0.tgz',
        pluginUiTarballPath:
          '/tmp/natural-root/natural-cli-1/npm/happier-dev-plugin-ui-0.0.0.tgz',
        channelsProtocolTarballPath:
          '/tmp/natural-root/natural-cli-1/npm/happier-dev-channels-protocol-0.0.0.tgz',
        cliTarballPath:
          '/tmp/natural-root/natural-cli-1/npm/happier-dev-cli-0.2.10.tgz',
      };
    },
    buildPackedAuthorCandidateImpl: async () => {
      throw new Error('candidate builder must not run in natural mode');
    },
    writeStdoutImpl: (value) => output.push(value),
  });

  assert.deepEqual(calls, [{
    monorepoRoot: '/workspace/happier',
    outputRoot: '/tmp/natural-root',
    runId: 'natural-cli-1',
  }]);
  assert.deepEqual(JSON.parse(output.join('')), {
    ok: true,
    runId: 'natural-cli-1',
    sdkTarballPath:
      '/tmp/natural-root/natural-cli-1/npm/happier-dev-plugin-sdk-0.0.0.tgz',
    pluginUiTarballPath:
      '/tmp/natural-root/natural-cli-1/npm/happier-dev-plugin-ui-0.0.0.tgz',
    channelsProtocolTarballPath:
      '/tmp/natural-root/natural-cli-1/npm/happier-dev-channels-protocol-0.0.0.tgz',
    cliTarballPath:
      '/tmp/natural-root/natural-cli-1/npm/happier-dev-cli-0.2.10.tgz',
  });
});

test('main forwards the selected native target and exact matrix to the candidate-builder entrypoint', async () => {
  const calls = [];
  const output = [];
  await main([
    '--run-id',
    'r447-g9-main',
    '--output-root',
    '/tmp/r447-main-output',
    '--native-target',
    'darwin-arm64',
    '--native-artifacts-dir',
    '/tmp/r447-native-matrix',
  ], {
    monorepoRoot: '/workspace/happier',
    buildPackedAuthorCandidateImpl: async (params) => {
      calls.push(params);
      return {
        manifestPath: '/tmp/r447-main-output/r447-g9-main/candidate.json',
        candidate: candidateFor({
          runId: params.runId,
          sdkTarballPath: '/tmp/r447-main-output/r447-g9-main/npm/sdk.tgz',
          pluginUiTarballPath: '/tmp/r447-main-output/r447-g9-main/npm/plugin-ui.tgz',
          cliTarballPath: '/tmp/r447-main-output/r447-g9-main/npm/cli.tgz',
          standaloneCliArtifactPath:
            '/tmp/r447-main-output/r447-g9-main/native/happier-v0.2.10-darwin-arm64.tar.gz',
        }),
      };
    },
    writeStdoutImpl: (value) => output.push(value),
  });

  assert.deepEqual(calls, [{
    monorepoRoot: '/workspace/happier',
    outputRoot: '/tmp/r447-main-output',
    runId: 'r447-g9-main',
    nativeTarget: 'darwin-arm64',
    nativeArtifactsDir: '/tmp/r447-native-matrix',
  }]);
  assert.equal(JSON.parse(output.join('')).ok, true);
});
