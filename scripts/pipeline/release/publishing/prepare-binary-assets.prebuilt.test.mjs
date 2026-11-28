import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import archiver from 'archiver';

import {
  finalizePreparedBinaryArtifacts,
  prepareBinaryAssetsMain,
  prepareBinaryReleaseAssets,
} from './prepare-binary-assets.mjs';
import { parsePublishBinaryReleaseArgs } from './publish-binary-release.mjs';
import { getBinaryPublishProductSpec as getCompleteBinaryPublishProductSpec } from './product-specs.mjs';

function getBinaryPublishProductSpec(product) {
  return { ...getCompleteBinaryPublishProductSpec(product), optionalComponentProducts: [] };
}

const CLI_TARGETS = [
  ['linux', 'x64'],
  ['linux', 'arm64'],
  ['darwin', 'x64'],
  ['darwin', 'arm64'],
  ['windows', 'x64'],
];

test('CLI publication requires complete optional matrices and seals component envelopes', async () => {
  const artifactsDir = await mkdtemp(join(tmpdir(), 'happier-optional-publication-'));
  const version = '1.2.3-preview.4';
  const products = ['happier-memory-runtime', 'happier-voice-runtime', 'happier-difftastic'];
  const writes = [];
  const finalize = () => finalizePreparedBinaryArtifacts({
    artifactsDir, version, channel: 'preview', productSpec: getCompleteBinaryPublishProductSpec('cli'),
    targets: CLI_TARGETS.map(([os, arch]) => ({ os, arch })),
    writeChecksums: async (input) => {
      writes.push(input);
      const checksumPath = join(artifactsDir, `checksums-${input.product}-v${version}.txt`);
      await writeFile(checksumPath, 'checksum');
      return checksumPath;
    },
    signFile: async ({ path }) => {
      await writeFile(`${path}.minisig`, 'signature');
      return `${path}.minisig`;
    },
  });
  try {
    await writeCliArchives(artifactsDir, version);
    await writeCliEvidence(artifactsDir);
    for (const product of products) {
      for (const [os, arch] of CLI_TARGETS) {
        await writeFile(join(artifactsDir, `${product}-v${version}-${os}-${arch}.tar.gz`), 'component');
      }
      await writeProductEvidence(artifactsDir, product);
    }
    const missing = join(artifactsDir, `happier-difftastic-v${version}-windows-x64.tar.gz`);
    await rm(missing);
    await assert.rejects(finalize(), /missing prepared artifact.*happier-difftastic/);
    assert.equal(writes.length, 0);
    await writeFile(missing, 'component');
    const missingEvidence = join(artifactsDir, 'darwin-arm64.happier-memory-runtime.json');
    await rm(missingEvidence);
    await assert.rejects(finalize(), /missing prepared Darwin notarization evidence.*happier-memory-runtime/);
    await writeFile(missingEvidence, '{}');
    const result = await finalize();
    assert.deepEqual(writes.map(({ product }) => product), [...products, 'happier']);
    for (const product of products) {
      assert.equal(writes.find((entry) => entry.product === product).artifacts.length, 7);
      for (const suffix of ['', '.minisig']) {
        assert.ok(result.artifacts.some(({ name }) => name === `checksums-${product}-v${version}.txt${suffix}`));
      }
    }
    assert.equal(result.artifacts.length, 34);
  } finally {
    await rm(artifactsDir, { recursive: true, force: true });
  }
});

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

async function writeRunnerArchive(archivePath) {
  await new Promise((resolvePromise, reject) => {
    const output = createWriteStream(archivePath, { flags: 'wx', mode: 0o600 });
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolvePromise);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    archive.append('runner\n', { name: 'happier-runner', mode: 0o755, date: new Date(0) });
    void archive.finalize();
  });
}

test('finalizePreparedBinaryArtifacts flattens generated channel manifests into the signed release envelope', async () => {
  const artifactsDir = await mkdtemp(join(tmpdir(), 'happier-prebuilt-cli-manifests-'));
  const manifestsRoot = join(artifactsDir, 'manifests');
  const manifestsDir = join(manifestsRoot, 'v1', 'happier', 'preview');
  const version = '1.2.3-preview.4';
  const finalize = (writes) => finalizePreparedBinaryArtifacts({
    artifactsDir, manifestsDir, manifestsRoot, productSpec: getBinaryPublishProductSpec('cli'),
    channel: 'preview', version, targets: CLI_TARGETS.map(([os, arch]) => ({ os, arch })),
    writeChecksums: async (input) => {
      writes.push(input);
      const checksumPath = join(artifactsDir, `checksums-happier-v${version}.txt`);
      await writeFile(checksumPath, 'checksum');
      return checksumPath;
    },
    signFile: async ({ path }) => {
      await writeFile(`${path}.minisig`, 'signature');
      return `${path}.minisig`;
    },
  });
  try {
    await writeCliArchives(artifactsDir, version);
    await writeCliEvidence(artifactsDir);
    await mkdir(manifestsDir, { recursive: true });
    const manifestNames = [...CLI_TARGETS.map(([os, arch]) => `${os}-${arch}.json`), 'latest.json'];
    for (const name of manifestNames) await writeFile(join(manifestsDir, name), `${JSON.stringify({ name })}\n`, 'utf8');
    const writes = [];
    await finalize(writes);
    const signed = writes[0].artifacts.map(({ name }) => name);
    for (const name of manifestNames) assert.ok(signed.includes(name), `${name} is in the signed checksums`);
    assert.deepEqual((await readdir(artifactsDir)).filter((name) => name.endsWith('.json') && !name.includes('.cli.')).sort(), [...manifestNames].sort());
    assert.equal((await readdir(artifactsDir)).includes('manifests'), false, 'the nested manifest tree is removed');

    await mkdir(manifestsDir, { recursive: true });
    for (const name of manifestNames.slice(1)) await writeFile(join(manifestsDir, name), '{}\n', 'utf8');
    await assert.rejects(finalize([]), /unexpected generated manifest set/);
  } finally {
    await rm(artifactsDir, { recursive: true, force: true });
  }
});

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

test('finalizePreparedBinaryArtifacts signs the first publication-eligible Runner ZIP without requiring other native targets', async () => {
  const artifactsDir = await mkdtemp(join(tmpdir(), 'happier-prebuilt-runner-'));
  const version = '1.2.3-preview.4';
  const archiveName = `happier-runner-v${version}-linux-x64.zip`;
  try {
    await writeRunnerArchive(join(artifactsDir, archiveName));
    const writes = [];

    const result = await finalizePreparedBinaryArtifacts({
      artifactsDir,
      productSpec: getBinaryPublishProductSpec('runner'),
      channel: 'preview',
      version,
      writeChecksums: async (input) => {
        writes.push(input);
        return join(artifactsDir, `checksums-happier-runner-v${version}.txt`);
      },
      signFile: async ({ path }) => `${path}.minisig`,
    });

    assert.deepEqual(
      writes[0].artifacts.map((artifact) => [artifact.os, artifact.arch, artifact.name]),
      [['linux', 'x64', archiveName]],
    );
    assert.equal(writes[0].artifacts[0].archiveMetadata.sizeBytes > 0, true);
    assert.deepEqual(writes[0].artifacts[0].archiveMetadata.entries, [{
      path: 'happier-runner',
      kind: 'file',
      sizeBytes: 7,
      mode: 0o755,
    }]);
    assert.deepEqual(result.artifacts.map((artifact) => artifact.name), [archiveName]);
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

    // The second seal adds the generated channel manifests to the signed envelope.
    assert.equal(finalized.length, 2);
    assert.equal(finalized[0].version, '1.2.3-preview.4');
    assert.equal(finalized[0].channel, 'preview');
    assert.equal(finalized[0].manifestsDir, undefined);
    assert.equal(finalized[1].manifestsRoot, join(repoRoot, 'dist/release-assets/cli/manifests'));
    assert.equal(finalized[1].manifestsDir, join(repoRoot, 'dist/release-assets/cli/manifests/v1/happier/preview'));
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
