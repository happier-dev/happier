import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
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
  captureCandidateBuildBasis,
  createCandidateInstallerArtifacts,
  main,
  parsePackedAuthorCandidateBuilderArgs,
  parsePackedAuthorNaturalBuilderArgs,
  resolveCandidateBuildBasisPaths,
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
  cliTarballPath,
  standaloneCliArtifactPath = null,
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
    cli: {
      packageName: '@happier-dev/cli',
      version: '0.2.10',
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
            version: '0.2.10',
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

async function writeTestPackedArtifact({ packageRelDir, destinationDir }) {
  const isSdk = packageRelDir === 'packages/plugin-sdk';
  const packageName = isSdk
    ? '@happier-dev/plugin-sdk'
    : '@happier-dev/cli';
  const version = isSdk ? '0.0.0' : '0.2.10';
  const tarballName = isSdk
    ? 'happier-dev-plugin-sdk-0.0.0.tgz'
    : 'happier-dev-cli-0.2.10.tgz';
  const bytes = `exact:${packageRelDir}`;
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
  await writeFile(
    join(destinationDir, `checksums-happier-v${version}.txt`),
    entries.map((entry) => `${entry.sha256}  ${entry.fileName}`).join('\n').concat('\n'),
  );
  if (includeDarwinNotarizationEvidence) {
    for (const target of ['darwin-x64', 'darwin-arm64']) {
      await writeFile(
        join(destinationDir, `${target}.cli.json`),
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
    }
  }
  return entries;
}

test('ordinary natural builder exports only the exact SDK/CLI pair under one canonical lease', async () => {
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
      ['packages/plugin-sdk', 'apps/cli'],
    );
    assert.deepEqual(await readdir(runRoot), ['npm']);
    assert.deepEqual((await readdir(npmRoot)).sort(), [
      'happier-dev-cli-0.2.10.tgz',
      'happier-dev-plugin-sdk-0.0.0.tgz',
    ]);
    assert.deepEqual(result, {
      runId: 'natural-pair-1',
      sdkTarballPath: join(
        npmRoot,
        'happier-dev-plugin-sdk-0.0.0.tgz',
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

test('buildPackedAuthorCandidate exports one leased SDK/CLI basis and publishes one npm/installers manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'packed-candidate-builder-'));
  const monorepoRoot = join(root, 'repo');
  const outputRoot = join(root, 'output');
  const events = [];
  try {
    await mkdir(monorepoRoot, { recursive: true });
    await mkdir(join(monorepoRoot, 'apps', 'cli'), { recursive: true });
    await writeFile(
      join(monorepoRoot, 'apps', 'cli', 'package.json'),
      JSON.stringify({ name: '@happier-dev/cli', version: '0.2.10' }),
    );
    await mkdir(outputRoot);

    const result = await buildPackedAuthorCandidate({
      monorepoRoot,
      outputRoot,
      runId: 'r447-g9-assigned',
    }, {
      captureCandidateBuildBasisImpl: async () => {
        events.push('basis');
        return 'a'.repeat(64);
      },
      withCliDistBuildLockImpl: async (callback, options) => {
        events.push(`lock:${options.lockPath}`);
        return await callback({
          waited: true,
          heldLockValue: 'authenticated-inherited-lease',
          inherited: false,
        });
      },
      exportPackSandboxTarballImpl: async ({
        packageRelDir,
        destinationDir,
        env,
      }) => {
        events.push(`pack:${packageRelDir}`);
        assert.equal(
          env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD,
          'authenticated-inherited-lease',
        );
        return await writeTestPackedArtifact({ packageRelDir, destinationDir });
      },
      createPackedAuthorCandidateImpl: async (params) => {
        events.push('attest');
        return candidateFor(params);
      },
      createCandidateInstallerArtifactsImpl: async (params) => {
        events.push('installers');
        return await writeTestInstallerArtifacts(params);
      },
    });

    const runRoot = join(outputRoot, 'r447-g9-assigned');
    assert.deepEqual(
      events.filter((event) => event === 'basis'),
      ['basis', 'basis'],
    );
    assert.deepEqual(
      events.filter((event) => event.startsWith('pack:')),
      ['pack:packages/plugin-sdk', 'pack:apps/cli'],
    );
    assert.equal(events.indexOf('basis') < events.indexOf('pack:packages/plugin-sdk'), true);
    assert.equal(events.lastIndexOf('basis') > events.indexOf('attest'), true);
    assert.equal(result.manifestPath, join(runRoot, 'candidate.json'));
    const writtenManifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    assert.equal(
      writtenManifest.sdk.tarballPath,
      'npm/happier-dev-plugin-sdk-0.0.0.tgz',
    );
    assert.equal(
      writtenManifest.cli.tarballPath,
      'npm/happier-dev-cli-0.2.10.tgz',
    );
    assert.deepEqual(result.candidate.sourceBasis, {
      algorithm: 'sha256',
      digest: 'a'.repeat(64),
    });
    assert.equal(result.candidate.sdk.tarballPath.startsWith(`${runRoot}/`), true);
    assert.equal(result.candidate.cli.tarballPath.startsWith(`${runRoot}/`), true);
    assert.equal(result.candidate.standaloneCli, undefined);
    assert.equal(
      await readFile(result.candidate.installers.shell.filePath, 'utf8'),
      'candidate shell installer\n',
    );
    assert.equal(result.candidate.installers.releaseChannel, 'dev');
    assert.equal(result.candidate.installers.powershell.fileName, 'install-dev.ps1');
    assert.equal(result.candidate.installers.publicKey.fileName, 'happier-release.pub');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('buildPackedAuthorCandidate imports and binds the exact five-archive native matrix without rebuilding it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'packed-candidate-native-matrix-'));
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
    const supplied = await writeTestNativeMatrix({
      destinationDir: suppliedArtifactsDir,
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
      captureCandidateBuildBasisImpl: async () => 'a'.repeat(64),
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
      verifyDarwinNotarizationEvidenceImpl: async (params) => {
        verifiedDarwinEvidence.push({
          archiveName: params.archiveName,
          evidenceFileName: params.evidenceFileName,
          target: params.target,
        });
      },
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
        'happier-v0.2.10-darwin-arm64.tar.gz',
      ),
    );
    assert.deepEqual(verifiedDarwinEvidence, [
      {
        archiveName: 'happier-v0.2.10-darwin-x64.tar.gz',
        evidenceFileName: 'darwin-x64.cli.json',
        target: 'darwin-x64',
      },
      {
        archiveName: 'happier-v0.2.10-darwin-arm64.tar.gz',
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
    assert.equal(manifest.cli.tarballPath, 'npm/happier-dev-cli-0.2.10.tgz');
    assert.equal(
      manifest.standaloneCli.archivePath,
      'native/happier-v0.2.10-darwin-arm64.tar.gz',
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
      { cwd: root },
    );
    assert.equal(
      transferredCandidate.standaloneCli.archivePath,
      join(
        transferredRunRoot,
        'native',
        'happier-v0.2.10-darwin-arm64.tar.gz',
      ),
    );
    assert.equal(
      transferredCandidate.standaloneCli.notarization[0].evidence.filePath,
      join(transferredRunRoot, 'native', 'darwin-x64.cli.json'),
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
        captureCandidateBuildBasisImpl: async () => 'a'.repeat(64),
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
        captureCandidateBuildBasisImpl: async () => 'a'.repeat(64),
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
        captureCandidateBuildBasisImpl: async () => 'a'.repeat(64),
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

test('buildPackedAuthorCandidate withholds the manifest and removes only its run root when the basis moves', async () => {
  const root = await mkdtemp(join(tmpdir(), 'packed-candidate-builder-moving-'));
  const monorepoRoot = join(root, 'repo');
  const outputRoot = join(root, 'output');
  const preservedSiblingPath = join(outputRoot, 'preserved-sibling.txt');
  const bases = ['a'.repeat(64), 'b'.repeat(64)];
  try {
    await mkdir(monorepoRoot, { recursive: true });
    await mkdir(outputRoot);
    await writeFile(preservedSiblingPath, 'preserve me');

    await assert.rejects(
      buildPackedAuthorCandidate({
        monorepoRoot,
        outputRoot,
        runId: 'r447-moving-basis',
      }, {
        captureCandidateBuildBasisImpl: async () => bases.shift(),
        withCliDistBuildLockImpl: async (callback) => await callback({
          waited: false,
          heldLockValue: 'lease',
          inherited: false,
        }),
        exportPackSandboxTarballImpl: writeTestPackedArtifact,
        createPackedAuthorCandidateImpl: async (params) => candidateFor(params),
        createCandidateInstallerArtifactsImpl: writeTestInstallerArtifacts,
      }),
      /source\/generated\/dist basis changed/i,
    );

    assert.equal(existsSync(join(outputRoot, 'r447-moving-basis')), false);
    assert.equal(await readFile(preservedSiblingPath, 'utf8'), 'preserve me');
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
  try {
    await mkdir(monorepoRoot, { recursive: true });
    await mkdir(outputRoot);

    await assert.rejects(
      buildPackedAuthorCandidate({
        monorepoRoot,
        outputRoot,
        runId: 'r447-mixed-root',
      }, {
        captureCandidateBuildBasisImpl: async () => 'a'.repeat(64),
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
      }),
      /outside the current run root/i,
    );

    assert.equal(existsSync(join(outputRoot, 'r447-mixed-root')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('captureCandidateBuildBasis detects source, generated, and dist byte changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'packed-candidate-builder-basis-'));
  const sourcePath = join(root, 'source.ts');
  const generatedPath = join(root, 'generated.ts');
  const distPath = join(root, 'dist', 'index.js');
  try {
    await mkdir(dirname(distPath), { recursive: true });
    await writeFile(sourcePath, 'source-a');
    await writeFile(generatedPath, 'generated-a');
    await writeFile(distPath, 'dist-a');
    const basisPaths = ['source.ts', 'generated.ts', 'dist'];

    const initial = await captureCandidateBuildBasis({ monorepoRoot: root, basisPaths });
    await writeFile(sourcePath, 'source-b');
    const sourceChanged = await captureCandidateBuildBasis({ monorepoRoot: root, basisPaths });
    await writeFile(generatedPath, 'generated-b');
    const generatedChanged = await captureCandidateBuildBasis({ monorepoRoot: root, basisPaths });
    await writeFile(distPath, 'dist-b');
    const distChanged = await captureCandidateBuildBasis({ monorepoRoot: root, basisPaths });

    assert.notEqual(initial, sourceChanged);
    assert.notEqual(sourceChanged, generatedChanged);
    assert.notEqual(generatedChanged, distChanged);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('candidate basis includes the canonical pack, generator, and native release owners', async () => {
  const monorepoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  const basisPaths = await resolveCandidateBuildBasisPaths({ monorepoRoot });

  for (const expectedPath of [
    'apps/stack/scripts/pack.mjs',
    'apps/stack/scripts/utils',
    'scripts/migrations/extensions',
    'scripts/pipeline/release/build-cli-binaries.mjs',
    'scripts/pipeline/release/lib',
    'scripts/pipeline/release/notarize-standalone-binary.mjs',
    'scripts/pipeline/release/verify-artifacts.mjs',
    'apps/website/public/install-dev.sh',
    'apps/website/public/install-dev.ps1',
    'apps/website/public/happier-release.pub',
  ]) {
    assert.equal(
      basisPaths.includes(expectedPath),
      true,
      `missing canonical candidate basis owner: ${expectedPath}`,
    );
  }
  assert.equal(basisPaths.includes('packages/plugin-sdk'), true);
  assert.equal(basisPaths.includes('apps/cli'), true);
  assert.equal(basisPaths.includes('packages/plugins/cliproxyapi'), true);
  assert.equal(
    basisPaths.some((relativePath) => relativePath.startsWith('dist/')),
    false,
    'candidate output roots must never enter their own source basis',
  );
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
    /only the SDK and CLI npm pair/u,
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
