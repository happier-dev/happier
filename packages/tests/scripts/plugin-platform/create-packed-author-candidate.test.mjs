import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import * as tar from 'tar';

import * as packedNpmPairAttestor from './create-packed-author-candidate.mjs';
import { resolvePackedAuthorPackageArchiveLimits } from './packed-author-artifact-boundary.mjs';
import {
  readPackedPackageManifest,
  sha512Sri,
} from './run-packed-author-ui-compat.mjs';

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

async function createPackageTarball(root, fileName, packageJson, extraFiles = {}) {
  const sourceRoot = join(root, `${fileName}-source`);
  await mkdir(join(sourceRoot, 'package'), { recursive: true });
  await writeFile(join(sourceRoot, 'package', 'package.json'), `${JSON.stringify(packageJson)}\n`, 'utf8');
  await Promise.all(Object.entries(extraFiles).map(async ([relativePath, contents]) => {
    const targetPath = join(sourceRoot, 'package', relativePath);
    await mkdir(join(targetPath, '..'), { recursive: true });
    await writeFile(targetPath, contents, 'utf8');
  }));
  const tarballPath = join(root, `${fileName}.tgz`);
  await tar.c({ cwd: sourceRoot, file: tarballPath, gzip: true }, ['package']);
  return tarballPath;
}

async function createPluginUiTarball(root, fileName, sdkVersion = '0.0.0') {
  return await createPackageTarball(root, fileName, {
    name: '@happier-dev/plugin-ui',
    version: '0.0.0',
    dependencies: { '@happier-dev/plugin-sdk': sdkVersion },
  });
}

const { createPackedAuthorCandidate } = packedNpmPairAttestor;

test('keeps generic packed packages at 1 GiB while bounding the measured CLI closure at 1.25 GiB', () => {
  const oneGiB = 1024 * 1024 * 1024;
  const oneAndQuarterGiB = 1280 * 1024 * 1024;
  const measuredContractedCliExpandedBytes = 1_087_352_708;

  for (const artifactKind of ['sdk', 'pluginUi', 'channelsProtocol']) {
    assert.equal(
      resolvePackedAuthorPackageArchiveLimits(artifactKind).maxExpandedBytes,
      oneGiB,
    );
  }
  assert.equal(
    resolvePackedAuthorPackageArchiveLimits('cli').maxExpandedBytes,
    oneAndQuarterGiB,
  );
  assert.ok(measuredContractedCliExpandedBytes > oneGiB);
  assert.ok(measuredContractedCliExpandedBytes < oneAndQuarterGiB);
});

test('attests the exact packed SDK, Plugin UI, Channels protocol, and CLI set without candidate or native semantics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-candidate-creator-'));
  try {
    const sdkTarballPath = await createPackageTarball(root, 'sdk', {
      name: '@happier-dev/plugin-sdk',
      version: '0.0.0',
    });
    const pluginUiTarballPath = await createPackageTarball(root, 'plugin-ui', {
      name: '@happier-dev/plugin-ui',
      version: '0.0.0',
      dependencies: { '@happier-dev/plugin-sdk': '0.0.0' },
    });
    const channelsProtocolTarballPath = await createPackageTarball(root, 'channels-protocol', {
      name: '@happier-dev/channels-protocol',
      version: '0.0.0',
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
    });
    const cliTarballPath = await createPackageTarball(root, 'cli', {
      name: '@happier-dev/cli',
      version: '0.2.10',
      bin: { happier: './bin/happier.mjs' },
    });
    const candidate = await createPackedAuthorCandidate({
      runId: 'natural-local-17',
      sdkTarballPath,
      pluginUiTarballPath,
      channelsProtocolTarballPath,
      cliTarballPath,
    });

    assert.equal(Object.hasOwn(candidate, 'schemaVersion'), false);
    assert.equal(Object.hasOwn(candidate, 'standaloneCli'), false);
    assert.equal(candidate.runId, 'natural-local-17');
    assert.equal(candidate.sdk.version, '0.0.0');
    assert.equal(candidate.pluginUi.version, '0.0.0');
    assert.equal(candidate.pluginUi.pluginSdkVersion, candidate.sdk.version);
    assert.equal(candidate.channelsProtocol.packageName, '@happier-dev/channels-protocol');
    assert.equal(candidate.channelsProtocol.version, '0.0.0');
    assert.equal(
      candidate.channelsProtocol.integrity,
      sha512Sri(await readFile(channelsProtocolTarballPath)),
    );
    assert.equal(candidate.cli.version, '0.2.10');
    assert.equal(candidate.cli.entrypoint, 'package/bin/happier.mjs');
    assert.equal(candidate.sdk.integrity, sha512Sri(await readFile(sdkTarballPath)));
    assert.equal(candidate.pluginUi.integrity, sha512Sri(await readFile(pluginUiTarballPath)));
    assert.equal(candidate.cli.integrity, sha512Sri(await readFile(cliTarballPath)));
    const mismatchedPluginUiTarballPath = await createPackageTarball(root, 'plugin-ui-mismatch', {
      name: '@happier-dev/plugin-ui',
      version: '0.0.0',
      dependencies: { '@happier-dev/plugin-sdk': '0.0.1' },
    });
    await assert.rejects(
      createPackedAuthorCandidate({
        runId: 'natural-local-17-mismatch',
        sdkTarballPath,
        pluginUiTarballPath: mismatchedPluginUiTarballPath,
        cliTarballPath,
      }),
      /Plugin UI.*SDK/i,
    );
    const privateChannelsProtocolTarballPath = await createPackageTarball(root, 'channels-protocol-private', {
      name: '@happier-dev/channels-protocol',
      version: '0.0.0',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: {
        '.': {
          types: './dist/index.d.ts',
          default: './dist/index.js',
        },
      },
    });
    await assert.rejects(
      createPackedAuthorCandidate({
        runId: 'natural-local-17-private-channels-protocol',
        sdkTarballPath,
        pluginUiTarballPath,
        channelsProtocolTarballPath: privateChannelsProtocolTarballPath,
        cliTarballPath,
      }),
      /Channels protocol public exports/i,
    );
    await assert.rejects(
      createPackedAuthorCandidate({
        runId: 'natural-local-17',
        sdkTarballPath,
        pluginUiTarballPath,
        cliTarballPath,
        standaloneCliArtifactPath:
          join(root, 'happier-v0.2.10-darwin-arm64.tar.gz'),
      }),
      /does not accept native artifacts/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('admits the bounded file count of the real packed CLI runtime closure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-candidate-runtime-closure-size-'));
  try {
    const sdkTarballPath = await createPackageTarball(root, 'sdk', {
      name: '@happier-dev/plugin-sdk',
      version: '0.0.0',
    });
    const pluginUiTarballPath = await createPluginUiTarball(root, 'plugin-ui');
    const cliTarballPath = join(root, 'cli.tgz');
    const runtimeEntries = Array.from({ length: 25_200 }, (_, index) => ({
      name: `package/node_modules/runtime/f${String(index).padStart(5, '0')}.js`,
    }));
    await writeFile(cliTarballPath, createTarGzip([
      {
        name: 'package/package.json',
        contents: JSON.stringify({
          name: '@happier-dev/cli',
          version: '0.2.10',
          bin: { happier: './bin/happier.mjs' },
        }),
      },
      ...runtimeEntries,
    ]));

    await assert.doesNotReject(createPackedAuthorCandidate({
      runId: 'runtime-closure-size',
      sdkTarballPath,
      pluginUiTarballPath,
      cliTarballPath,
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('has no executable candidate-creator entrypoint', () => {
  assert.equal('parseCandidateCreatorArgs' in packedNpmPairAttestor, false);
  assert.equal('main' in packedNpmPairAttestor, false);
});

test('reads only the packed package manifest instead of materializing the full artifact tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-candidate-manifest-'));
  try {
    const sourceRoot = join(root, 'source');
    await mkdir(join(sourceRoot, 'package'), { recursive: true });
    await Promise.all([
      writeFile(join(sourceRoot, 'package', 'package.json'), JSON.stringify({
        name: '@happier-dev/plugin-sdk',
        version: '0.0.0',
      })),
      writeFile(join(sourceRoot, 'package', 'large-unrelated-artifact.bin'), 'not-a-manifest'),
    ]);
    const tarballPath = join(root, 'sdk.tgz');
    await tar.c({ cwd: sourceRoot, file: tarballPath, gzip: true }, ['package']);
    const extractionRoot = join(root, 'extracted');

    const manifest = await readPackedPackageManifest(tarballPath, extractionRoot);

    assert.equal(manifest.name, '@happier-dev/plugin-sdk');
    await assert.rejects(
      readFile(join(extractionRoot, 'package', 'large-unrelated-artifact.bin')),
      { code: 'ENOENT' },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects lookalike artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-candidate-lookalike-'));
  try {
    const sdkTarballPath = await createPackageTarball(root, 'sdk', {
      name: '@scope/lookalike-sdk',
      version: '0.0.0',
    });
    const pluginUiTarballPath = await createPluginUiTarball(root, 'plugin-ui');
    const cliTarballPath = await createPackageTarball(root, 'cli', {
      name: '@happier-dev/cli',
      version: '0.2.10',
      bin: { happier: './bin/happier.mjs' },
    });
    await assert.rejects(
      createPackedAuthorCandidate({
        runId: 'lookalike',
        sdkTarballPath,
        pluginUiTarballPath,
        cliTarballPath,
      }),
      /identity mismatch/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects sensitive SDK and CLI package state before reading package manifests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-candidate-sensitive-'));
  try {
    const sensitiveCases = [
      ['environment', '.env.production'],
      ['credentials', '.aws/credentials'],
      ['credentials', '.yarnrc.yml'],
      ['credentials', '.docker/config.json'],
      ['credentials', '.config/gh/hosts.yml'],
      ['credentials', '.kube/config'],
      ['private state', '.happier/settings.json'],
      ['private state', '.git/config'],
      ['private state', '.azure/profile.json'],
      ['private key', 'identity.p12'],
    ];
    for (const [index, [label, relativePath]] of sensitiveCases.entries()) {
      const caseId = `${label.replace(' ', '-')}-${index}`;
      const sdkTarballPath = await createPackageTarball(root, `sdk-${caseId}`, {
        name: '@happier-dev/plugin-sdk',
        version: '0.0.0',
      }, { [relativePath]: 'secret\n' });
      const pluginUiTarballPath = await createPluginUiTarball(root, `plugin-ui-${caseId}`);
      const cliTarballPath = await createPackageTarball(root, `cli-${caseId}`, {
        name: '@happier-dev/cli',
        version: '0.2.10',
        bin: { happier: './bin/happier.mjs' },
      });
      await assert.rejects(
        createPackedAuthorCandidate({
          runId: `sensitive-${caseId}`,
          sdkTarballPath,
          pluginUiTarballPath,
          cliTarballPath,
        }),
        new RegExp(`sensitive.*${label}`, 'iu'),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('accepts dependency compiler metadata that is not private package state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-candidate-tsbuildinfo-'));
  try {
    const sdkTarballPath = await createPackageTarball(root, 'sdk', {
      name: '@happier-dev/plugin-sdk',
      version: '0.0.0',
    });
    const pluginUiTarballPath = await createPluginUiTarball(root, 'plugin-ui');
    const cliTarballPath = await createPackageTarball(root, 'cli', {
      name: '@happier-dev/cli',
      version: '0.2.10',
      bin: { happier: './bin/happier.mjs' },
    }, {
      'node_modules/dependency/dist/cache.tsbuildinfo': '{}',
    });

    await assert.doesNotReject(createPackedAuthorCandidate({
      runId: 'allows-tsbuildinfo',
      sdkTarballPath,
      pluginUiTarballPath,
      cliTarballPath,
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
