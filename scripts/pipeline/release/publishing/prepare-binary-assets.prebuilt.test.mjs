import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  finalizePreparedBinaryArtifacts,
  prepareBinaryAssetsMain,
  prepareBinaryReleaseAssets,
} from './prepare-binary-assets.mjs';
import { parsePublishBinaryReleaseArgs } from './publish-binary-release.mjs';
import { getBinaryPublishProductSpec } from './product-specs.mjs';

const CLI_TARGETS = [
  ['linux', 'x64'],
  ['linux', 'arm64'],
  ['darwin', 'x64'],
  ['darwin', 'arm64'],
  ['windows', 'x64'],
];

async function writeCliArchives(artifactsDir, version, targets = CLI_TARGETS) {
  for (const [os, arch] of targets) {
    const name = `happier-v${version}-${os}-${arch}.tar.gz`;
    await writeFile(join(artifactsDir, name), `${os}-${arch}\n`, 'utf8');
  }
}

async function writeCliEvidence(artifactsDir) {
  await writeFile(join(artifactsDir, 'darwin-x64.cli.json'), '{"target":"darwin-x64"}\n', 'utf8');
  await writeFile(join(artifactsDir, 'darwin-arm64.cli.json'), '{"target":"darwin-arm64"}\n', 'utf8');
}

async function writeProductEvidence(artifactsDir, suffix) {
  await writeFile(join(artifactsDir, `darwin-x64.${suffix}.json`), '{"target":"darwin-x64"}\n', 'utf8');
  await writeFile(join(artifactsDir, `darwin-arm64.${suffix}.json`), '{"target":"darwin-arm64"}\n', 'utf8');
}

test('finalizePreparedBinaryArtifacts signs one complete native CLI artifact matrix', async () => {
  const artifactsDir = await mkdtemp(join(tmpdir(), 'happier-prebuilt-cli-'));
  const version = '1.2.3-preview.4';
  try {
    await writeCliArchives(artifactsDir, version);
    await writeCliEvidence(artifactsDir);
    const writes = [];
    const signs = [];

    const result = await finalizePreparedBinaryArtifacts({
      artifactsDir,
      productSpec: getBinaryPublishProductSpec('cli'),
      channel: 'preview',
      version,
      targets: CLI_TARGETS.map(([os, arch]) => ({ os, arch })),
      writeChecksums: async (input) => {
        writes.push(input);
        return join(artifactsDir, `checksums-happier-v${version}.txt`);
      },
      signFile: async (input) => {
        signs.push(input);
        return `${input.path}.minisig`;
      },
    });

    assert.deepEqual(
      writes[0].artifacts.map((artifact) => [artifact.os, artifact.arch, artifact.name]),
      [
        ...CLI_TARGETS.map(([os, arch]) => [os, arch, `happier-v${version}-${os}-${arch}.tar.gz`]),
        ['darwin', 'arm64', 'darwin-arm64.cli.json'],
        ['darwin', 'x64', 'darwin-x64.cli.json'],
      ],
    );
    assert.deepEqual(signs, [{
      path: join(artifactsDir, `checksums-happier-v${version}.txt`),
      trustedComment: `happier ${version} preview`,
    }]);
    assert.equal(result.artifacts.length, CLI_TARGETS.length + 2);
    assert.equal(result.signaturePath, join(artifactsDir, `checksums-happier-v${version}.txt.minisig`));
  } finally {
    await rm(artifactsDir, { recursive: true, force: true });
  }
});

test('finalizePreparedBinaryArtifacts refuses publication without both Darwin notarization evidence records', async () => {
  const artifactsDir = await mkdtemp(join(tmpdir(), 'happier-prebuilt-cli-missing-evidence-'));
  const version = '1.2.3-preview.4';
  try {
    await writeCliArchives(artifactsDir, version);
    await assert.rejects(
      finalizePreparedBinaryArtifacts({
        artifactsDir,
        productSpec: getBinaryPublishProductSpec('cli'),
        channel: 'preview',
        version,
        targets: CLI_TARGETS.map(([os, arch]) => ({ os, arch })),
        writeChecksums: async () => {
          throw new Error('must not checksum an unsigned Darwin matrix');
        },
        signFile: async () => {
          throw new Error('must not sign an unsigned Darwin matrix');
        },
      }),
      /missing prepared Darwin notarization evidence/iu,
    );
  } finally {
    await rm(artifactsDir, { recursive: true, force: true });
  }
});

test('finalizePreparedBinaryArtifacts signs the complete CLI candidate envelope including notarization evidence', async () => {
  const artifactsDir = await mkdtemp(join(tmpdir(), 'happier-prebuilt-cli-evidence-'));
  const version = '1.2.3-dev.4';
  try {
    await writeCliArchives(artifactsDir, version);
    await writeCliEvidence(artifactsDir);
    const writes = [];

    await finalizePreparedBinaryArtifacts({
      artifactsDir,
      productSpec: getBinaryPublishProductSpec('cli'),
      channel: 'dev',
      version,
      targets: CLI_TARGETS.map(([os, arch]) => ({ os, arch })),
      writeChecksums: async (input) => {
        writes.push(input);
        return join(artifactsDir, `checksums-happier-v${version}.txt`);
      },
      signFile: async ({ path }) => `${path}.minisig`,
    });

    assert.deepEqual(
      writes[0].artifacts.map((artifact) => artifact.name).sort(),
      [
        ...CLI_TARGETS.map(([os, arch]) => `happier-v${version}-${os}-${arch}.tar.gz`),
        'darwin-arm64.cli.json',
        'darwin-x64.cli.json',
      ].sort(),
    );
  } finally {
    await rm(artifactsDir, { recursive: true, force: true });
  }
});

for (const { productId, manifestProduct, suffix } of [
  { productId: 'hstack', manifestProduct: 'hstack', suffix: 'hstack' },
  { productId: 'server', manifestProduct: 'happier-server', suffix: 'server' },
]) {
  test(`finalizePreparedBinaryArtifacts signs the complete ${productId} envelope including Darwin notarization evidence`, async () => {
    const artifactsDir = await mkdtemp(join(tmpdir(), `happier-prebuilt-${productId}-evidence-`));
    const version = '1.2.3-dev.4';
    const targets = CLI_TARGETS.map(([os, arch]) => ({ os, arch }));
    try {
      for (const [os, arch] of CLI_TARGETS) {
        await writeFile(
          join(artifactsDir, `${manifestProduct}-v${version}-${os}-${arch}.tar.gz`),
          `${os}-${arch}\n`,
          'utf8',
        );
      }
      await writeProductEvidence(artifactsDir, suffix);
      const writes = [];

      await finalizePreparedBinaryArtifacts({
        artifactsDir,
        productSpec: getBinaryPublishProductSpec(productId),
        channel: 'dev',
        version,
        targets,
        writeChecksums: async (input) => {
          writes.push(input);
          return join(artifactsDir, `checksums-${manifestProduct}-v${version}.txt`);
        },
        signFile: async ({ path }) => `${path}.minisig`,
      });

      assert.deepEqual(
        writes[0].artifacts.map((artifact) => artifact.name).sort(),
        [
          ...CLI_TARGETS.map(([os, arch]) => `${manifestProduct}-v${version}-${os}-${arch}.tar.gz`),
          `darwin-arm64.${suffix}.json`,
          `darwin-x64.${suffix}.json`,
        ].sort(),
      );
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });
}

test('finalizePreparedBinaryArtifacts fails closed when one native CLI target is missing', async () => {
  const artifactsDir = await mkdtemp(join(tmpdir(), 'happier-prebuilt-cli-missing-'));
  const version = '1.2.3-preview.4';
  try {
    await writeCliArchives(artifactsDir, version, CLI_TARGETS.slice(0, -1));

    await assert.rejects(
      finalizePreparedBinaryArtifacts({
        artifactsDir,
        productSpec: getBinaryPublishProductSpec('cli'),
        channel: 'preview',
        version,
        targets: CLI_TARGETS.map(([os, arch]) => ({ os, arch })),
        writeChecksums: async () => {
          throw new Error('must not write checksums for an incomplete matrix');
        },
        signFile: async () => {
          throw new Error('must not sign an incomplete matrix');
        },
      }),
      /missing prepared artifact.*windows-x64/iu,
    );
  } finally {
    await rm(artifactsDir, { recursive: true, force: true });
  }
});

test('finalizePreparedBinaryArtifacts rejects stale archives before signing', async () => {
  const artifactsDir = await mkdtemp(join(tmpdir(), 'happier-prebuilt-cli-stale-'));
  const version = '1.2.3-preview.4';
  try {
    await writeCliArchives(artifactsDir, version);
    await writeFile(join(artifactsDir, 'happier-v1.2.3-preview.3-linux-x64.tar.gz'), 'stale\n', 'utf8');

    await assert.rejects(
      finalizePreparedBinaryArtifacts({
        artifactsDir,
        productSpec: getBinaryPublishProductSpec('cli'),
        channel: 'preview',
        version,
        targets: CLI_TARGETS.map(([os, arch]) => ({ os, arch })),
        writeChecksums: async () => {
          throw new Error('must not write checksums when stale artifacts are present');
        },
        signFile: async () => {
          throw new Error('must not sign when stale artifacts are present');
        },
      }),
      /unexpected prepared artifact.*preview\.3/iu,
    );
  } finally {
    await rm(artifactsDir, { recursive: true, force: true });
  }
});

test('prepareBinaryReleaseAssets consumes a prepared matrix without rebuilding it', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'happier-prepare-prebuilt-cli-'));
  const finalized = [];
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => {
    logs.push(args.join(' '));
  };
  try {
    await prepareBinaryReleaseAssets({
      repoRoot,
      productId: 'cli',
      channel: 'preview',
      version: '1.2.3-preview.4',
      assetsBaseUrl: 'https://example.test/cli-preview',
      commitSha: 'a'.repeat(40),
      preparedArtifacts: true,
      dryRun: true,
      finalizePrepared: async (params) => {
        finalized.push(params);
      },
    });

    assert.equal(finalized.length, 1);
    assert.equal(finalized[0].version, '1.2.3-preview.4');
    assert.equal(finalized[0].channel, 'preview');
    assert.equal(
      logs.some((line) => line.includes('build-cli-binaries.mjs')),
      false,
      'prepared artifact publishing must not invoke a second CLI build',
    );
  } finally {
    console.log = originalLog;
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('prepareBinaryReleaseAssets publishes an already-finalized candidate envelope without re-signing or rebuilding', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'happier-prepare-finalized-cli-'));
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => {
    logs.push(args.join(' '));
  };
  try {
    await prepareBinaryReleaseAssets({
      repoRoot,
      productId: 'cli',
      channel: 'preview',
      version: '1.2.3-preview.4',
      assetsBaseUrl: 'https://example.test/cli-preview',
      commitSha: 'a'.repeat(40),
      preparedArtifacts: true,
      finalizedArtifacts: true,
      dryRun: true,
      finalizePrepared: async () => {
        throw new Error('an authenticated candidate envelope must not be re-signed');
      },
    });

    assert.equal(logs.some((line) => line.includes('build-cli-binaries.mjs')), false);
    assert.equal(logs.some((line) => line.includes('would finalize prepared artifacts')), false);
    assert.equal(
      logs.some(
        (line) => line.includes('--require-all-artifacts-checksummed')
          && line.includes('--require-signature'),
      ),
      true,
      'finalized artifact publishing must re-admit the exact signed payload set without rewriting it',
    );
  } finally {
    console.log = originalLog;
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('prepare-binary-assets exposes the existing complete-matrix finalizer without publishing', async () => {
  const calls = [];
  await prepareBinaryAssetsMain({
    cwd: '/workspace/happier',
    argv: [
      '--finalize-prepared-only',
      '--product',
      'cli',
      '--channel',
      'dev',
      '--version',
      '1.2.3-dev.4',
      '--artifacts-dir',
      'dist/candidate-native-matrix',
    ],
    finalizePrepared: async (params) => {
      calls.push(params);
      return {
        artifacts: [],
        checksumsPath:
          '/workspace/happier/dist/candidate-native-matrix/checksums-happier-v1.2.3-dev.4.txt',
        signaturePath:
          '/workspace/happier/dist/candidate-native-matrix/checksums-happier-v1.2.3-dev.4.txt.minisig',
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].artifactsDir, '/workspace/happier/dist/candidate-native-matrix');
  assert.equal(calls[0].productSpec.id, 'cli');
  assert.equal(calls[0].channel, 'dev');
  assert.equal(calls[0].version, '1.2.3-dev.4');
});

test('binary publisher accepts the prepared-artifacts handoff explicitly', () => {
  const values = parsePublishBinaryReleaseArgs([
    '--product',
    'cli',
    '--channel',
    'preview',
    '--prepared-artifacts',
  ]);

  assert.equal(values['prepared-artifacts'], true);
});

test('binary publisher accepts an exact finalized-artifacts handoff explicitly', () => {
  const values = parsePublishBinaryReleaseArgs([
    '--product',
    'cli',
    '--channel',
    'dev',
    '--version',
    '1.2.3-dev.4',
    '--finalized-artifacts',
  ]);

  assert.equal(values['finalized-artifacts'], true);
});

test('privileged binary publisher can validate an artifact envelope without executing candidate binaries', () => {
  const values = parsePublishBinaryReleaseArgs([
    '--product',
    'cli',
    '--channel',
    'dev',
    '--version',
    '1.2.3-dev.4',
    '--prepared-artifacts',
    '--skip-smoke',
  ]);

  assert.equal(values['skip-smoke'], true);
});

test('binary publisher can resolve one version for all native build jobs', () => {
  const values = parsePublishBinaryReleaseArgs([
    '--product',
    'cli',
    '--channel',
    'preview',
    '--resolve-version-only',
    '--github-output',
    '/tmp/github-output',
  ]);

  assert.equal(values['resolve-version-only'], true);
  assert.equal(values['github-output'], '/tmp/github-output');
});
