import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import test from 'node:test';

import cliDistBuildManifest from '../../../packages/cli-common/cliDistBuildManifest.cjs';

import {
  buildCliBinaryArtifacts,
  main,
} from './build-cli-binaries.mjs';

const linuxX64TargetKey = 'linux-x64';
const inheritedLease = JSON.stringify({
  v: 1,
  path: '/tmp/cli-dist-build.lock',
  token: 'candidate-owner-token',
});

const linuxX64Target = Object.freeze({
  os: 'linux',
  arch: 'x64',
  exeExt: '',
  bunTarget: 'bun-linux-x64-baseline',
});
const linuxArm64Target = Object.freeze({
  os: 'linux',
  arch: 'arm64',
  exeExt: '',
  bunTarget: 'bun-linux-arm64',
});
const darwinArm64Target = Object.freeze({
  os: 'darwin',
  arch: 'arm64',
  exeExt: '',
  bunTarget: 'bun-darwin-arm64',
});

function createTestReleaseOwners() {
  const availableTargets = [linuxX64Target, linuxArm64Target];
  return {
    CLI_STACK_TARGETS: availableTargets,
    normalizeChannel: (channel) => String(channel ?? '').trim() || 'stable',
    parseCsv: (raw) => String(raw ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    readVersionFromPackageJson: () => '0.2.10',
    refreshCliBinaryArtifactRuntimeAssetBuildManifest: () => {},
    resolveTargets: ({ availableTargets: candidates, requested }) => {
      const requestedKeys = String(requested ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      if (requestedKeys.length === 0) return candidates;
      const selected = candidates.filter((target) => (
        requestedKeys.includes(`${target.os}-${target.arch}`)
      ));
      if (selected.length !== new Set(requestedKeys).size) {
        throw new Error('[release] unknown target');
      }
      return selected;
    },
  };
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'happier-cli-binary-owner-'));
  const repoRoot = join(root, 'repo');
  const cliPackageJsonPath = join(repoRoot, 'apps', 'cli', 'package.json');
  const outputRoot = join(root, 'candidate', 'native');
  const sharedOutputRoot = join(repoRoot, 'dist', 'release-assets', 'cli');
  const managedRuntimeExecutablePath = join(root, 'wrapper', 'happier-cliproxyapi-managed');
  await mkdir(sharedOutputRoot, { recursive: true });
  await mkdir(resolve(cliPackageJsonPath, '..'), { recursive: true });
  await mkdir(resolve(managedRuntimeExecutablePath, '..'), { recursive: true });
  await writeFile(join(sharedOutputRoot, 'sentinel.txt'), 'shared-output-must-not-change\n');
  await writeFile(
    cliPackageJsonPath,
    `${JSON.stringify({ name: '@happier-dev/cli', version: '0.2.10' }, null, 2)}\n`,
  );
  await writeFile(managedRuntimeExecutablePath, 'same-basis-wrapper\n');
  return {
    root,
    repoRoot,
    cliPackageJsonPath,
    outputRoot,
    sharedOutputRoot,
    managedRuntimeExecutablePath,
  };
}

test('programmatic CLI binary build stays in the caller output root and propagates the inherited build lease', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const calls = {
    payload: [],
    finalize: [],
    package: [],
    checksums: [],
    sign: [],
  };
  const envMarkerName = 'HAPPIER_TEST_CANDIDATE_BUILD_ENV';
  const previousLease = process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD;
  const previousMarker = process.env[envMarkerName];
  delete process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD;
  delete process.env[envMarkerName];

  const env = {
    ...process.env,
    HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: inheritedLease,
    [envMarkerName]: 'same-basis',
  };

  try {
    const result = await buildCliBinaryArtifacts(
      {
        repoRoot: fixture.repoRoot,
        outDir: fixture.outputRoot,
        channel: 'preview',
        version: '0.2.10-candidate.7',
        targets: [linuxX64TargetKey],
        externals: ['optional-native-package'],
        cliProxyApiManagedRuntime: {
          kind: 'prebuilt-executable',
          executablePath: fixture.managedRuntimeExecutablePath,
        },
        requiredCliDistInputFingerprint: 'c'.repeat(64),
        env,
      },
      {
        loadCliBinaryReleaseOwnersImpl: async () => createTestReleaseOwners(),
        buildCliBinaryArtifactPayloadImpl: async (params) => {
          calls.payload.push({
            ...params,
            observedLease: process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD,
            observedMarker: process.env[envMarkerName],
          });
          await mkdir(params.payloadDir, { recursive: true });
          await writeFile(join(params.payloadDir, 'happier'), 'native-cli-payload\n');
        },
        finalizeMacOSPayloadForArchiveImpl: (params) => {
          calls.finalize.push(params);
          return null;
        },
        packagePreparedTargetBinaryImpl: async (params) => {
          calls.package.push(params);
          const name = `happier-v${params.version}-${params.target.os}-${params.target.arch}.tar.gz`;
          const path = join(params.outDir, name);
          await writeFile(path, 'archive-fixture\n');
          return {
            name,
            path,
            os: params.target.os,
            arch: params.target.arch,
          };
        },
        writeChecksumsFileImpl: async (params) => {
          calls.checksums.push(params);
          const path = join(params.outDir, `checksums-${params.product}-v${params.version}.txt`);
          await writeFile(path, 'checksum-fixture\n');
          return path;
        },
        maybeSignFileImpl: async (params) => {
          calls.sign.push(params);
          const path = `${params.path}.minisig`;
          await writeFile(path, 'signature-fixture\n');
          return path;
        },
        cleanupTempDirBestEffortImpl: async ({ tempDir }) => {
          await rm(tempDir, { recursive: true, force: true });
          return { timedOut: false };
        },
      },
    );

    assert.equal(calls.payload.length, 1);
    assert.deepEqual(
      {
        target: `${calls.payload[0].target.os}-${calls.payload[0].target.arch}`,
        externals: calls.payload[0].externals,
        managedRuntime: calls.payload[0].cliProxyApiManagedRuntimeExecutablePath,
        requiredCliDistInputFingerprint:
          calls.payload[0].requiredCliDistInputFingerprint,
        observedLease: calls.payload[0].observedLease,
        observedMarker: calls.payload[0].observedMarker,
      },
      {
        target: linuxX64TargetKey,
        externals: ['optional-native-package'],
        managedRuntime: fixture.managedRuntimeExecutablePath,
        requiredCliDistInputFingerprint: 'c'.repeat(64),
        observedLease: inheritedLease,
        observedMarker: 'same-basis',
      },
    );
    assert.equal(calls.package.length, 1);
    assert.equal(calls.package[0].version, '0.2.10-candidate.7');
    assert.equal(calls.package[0].outDir, fixture.outputRoot);
    assert.equal(calls.checksums.length, 1);
    assert.equal(calls.checksums[0].outDir, fixture.outputRoot);
    assert.equal(calls.sign.length, 1);
    assert.equal(
      await readFile(join(fixture.sharedOutputRoot, 'sentinel.txt'), 'utf8'),
      'shared-output-must-not-change\n',
    );
    assert.deepEqual(result, {
      product: 'happier',
      channel: 'preview',
      version: '0.2.10-candidate.7',
      outDir: fixture.outputRoot,
      artifacts: [{
        name: 'happier-v0.2.10-candidate.7-linux-x64.tar.gz',
        path: join(
          fixture.outputRoot,
          'happier-v0.2.10-candidate.7-linux-x64.tar.gz',
        ),
        os: 'linux',
        arch: 'x64',
      }],
      checksumsPath: join(
        fixture.outputRoot,
        'checksums-happier-v0.2.10-candidate.7.txt',
      ),
      signaturePath: join(
        fixture.outputRoot,
        'checksums-happier-v0.2.10-candidate.7.txt.minisig',
      ),
    });
    assert.ok(
      calls.payload[0].payloadDir.startsWith(`${fixture.outputRoot}/.tmp-cli-binaries/`),
    );
  } finally {
    if (previousLease === undefined) {
      delete process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD;
    } else {
      process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD = previousLease;
    }
    if (previousMarker === undefined) {
      delete process.env[envMarkerName];
    } else {
      process.env[envMarkerName] = previousMarker;
    }
  }

  assert.equal(process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD, previousLease);
  assert.equal(process.env[envMarkerName], previousMarker);
});

test('programmatic CLI binary build embeds the requested version and restores package.json', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const requestedVersion = '0.2.10-preview.47';
  const observedPackageVersions = [];

  await buildCliBinaryArtifacts(
    {
      repoRoot: fixture.repoRoot,
      outDir: fixture.outputRoot,
      channel: 'preview',
      version: requestedVersion,
      targets: [linuxX64TargetKey],
      cliProxyApiManagedRuntime: { kind: 'build-from-workspace-source' },
      env: process.env,
    },
    {
      loadCliBinaryReleaseOwnersImpl: async () => createTestReleaseOwners(),
      buildCliBinaryArtifactPayloadImpl: async ({ payloadDir }) => {
        observedPackageVersions.push(
          JSON.parse(await readFile(fixture.cliPackageJsonPath, 'utf8')).version,
        );
        await mkdir(payloadDir, { recursive: true });
      },
      finalizeMacOSPayloadForArchiveImpl: () => null,
      packagePreparedTargetBinaryImpl: async ({ outDir, target, version }) => ({
        name: `happier-v${version}-${target.os}-${target.arch}.tar.gz`,
        path: join(outDir, `happier-v${version}-${target.os}-${target.arch}.tar.gz`),
        os: target.os,
        arch: target.arch,
      }),
      writeChecksumsFileImpl: async ({ outDir, version }) => join(
        outDir,
        `checksums-happier-v${version}.txt`,
      ),
      maybeSignFileImpl: async () => null,
      cleanupTempDirBestEffortImpl: async () => ({ timedOut: false }),
    },
  );

  assert.deepEqual(observedPackageVersions, [requestedVersion]);
  assert.equal(
    JSON.parse(await readFile(fixture.cliPackageJsonPath, 'utf8')).version,
    '0.2.10',
  );
});

test('Darwin finalization refreshes managed-runtime integrity before payload evidence and archive custody', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const events = [];

  await buildCliBinaryArtifacts(
    {
      repoRoot: fixture.repoRoot,
      outDir: fixture.outputRoot,
      channel: 'preview',
      version: '0.2.10-candidate.7',
      targets: ['darwin-arm64'],
      cliProxyApiManagedRuntime: { kind: 'build-from-workspace-source' },
      env: process.env,
    },
    {
      loadCliBinaryReleaseOwnersImpl: async () => ({
        ...createTestReleaseOwners(),
        CLI_STACK_TARGETS: [darwinArm64Target],
      }),
      buildCliBinaryArtifactPayloadImpl: async ({ payloadDir }) => {
        events.push('payload');
        const entrypoint = join(payloadDir, 'package-dist', 'index.mjs');
        const wrapperPath = join(
          payloadDir,
          'tools',
          'unpacked',
          'happier-cliproxyapi-managed',
        );
        await mkdir(join(payloadDir, 'package-dist'), { recursive: true });
        await mkdir(join(payloadDir, 'tools', 'unpacked'), { recursive: true });
        await writeFile(entrypoint, 'export default true;\n');
        await writeFile(wrapperPath, 'managed-runtime-A');
        cliDistBuildManifest.writeCliDistBuildManifest(entrypoint);
        cliDistBuildManifest.writeCliRuntimeAssetBuildManifest({
          runtimeRoot: payloadDir,
          entrypoint,
          relativePath: 'tools/unpacked/happier-cliproxyapi-managed',
        });
      },
      finalizeMacOSPayloadForArchiveImpl: (params) => {
        events.push('codesign');
        writeFileSync(
          join(
            params.stageDir,
            'tools',
            'unpacked',
            'happier-cliproxyapi-managed',
          ),
          'managed-runtime-B',
        );
        assert.equal(typeof params.refreshRuntimeAssetManifest, 'function');
        params.refreshRuntimeAssetManifest();
        events.push('evidence');
        return { payloadSha256: 'a'.repeat(64) };
      },
      refreshCliBinaryArtifactRuntimeAssetBuildManifestImpl: ({ payloadDir }) => {
        events.push('refresh');
        cliDistBuildManifest.refreshCliRuntimeAssetBuildManifest({
          runtimeRoot: payloadDir,
          entrypoint: join(payloadDir, 'package-dist', 'index.mjs'),
        });
      },
      packagePreparedTargetBinaryImpl: async ({ stageDir, outDir, target }) => {
        events.push('archive');
        assert.equal(cliDistBuildManifest.readCliRuntimeAssetIntegrity({
          runtimeRoot: stageDir,
          relativePath: 'tools/unpacked/happier-cliproxyapi-managed',
        }).ok, true);
        return {
          name: 'happier-v0.2.10-candidate.7-darwin-arm64.tar.gz',
          path: join(outDir, 'happier-v0.2.10-candidate.7-darwin-arm64.tar.gz'),
          os: target.os,
          arch: target.arch,
        };
      },
      writeChecksumsFileImpl: async ({ outDir }) => join(outDir, 'checksums.txt'),
      maybeSignFileImpl: async () => null,
      cleanupTempDirBestEffortImpl: async ({ tempDir }) => {
        await rm(tempDir, { recursive: true, force: true });
        return { timedOut: false };
      },
    },
  );

  assert.deepEqual(events, ['payload', 'codesign', 'refresh', 'evidence', 'archive']);
});

test('programmatic CLI binary build requires an explicit exact managed-runtime input', async () => {
  await assert.rejects(
    buildCliBinaryArtifacts({
      repoRoot: '/tmp/repo',
      outDir: '/tmp/candidate/native',
      channel: 'dev',
      version: '0.2.10',
      targets: [linuxX64TargetKey],
      env: process.env,
    }, {
      loadCliBinaryReleaseOwnersImpl: async () => createTestReleaseOwners(),
    }),
    /managed runtime input is required/i,
  );
});

test('a prebuilt managed runtime is accepted only for one exact canonical CLI target', async () => {
  await assert.rejects(
    buildCliBinaryArtifacts({
      repoRoot: '/tmp/repo',
      outDir: '/tmp/candidate/native',
      channel: 'dev',
      version: '0.2.10',
      targets: [linuxX64TargetKey, 'linux-arm64'],
      cliProxyApiManagedRuntime: {
        kind: 'prebuilt-executable',
        executablePath: '/tmp/happier-cliproxyapi-managed',
      },
      env: process.env,
    }, {
      loadCliBinaryReleaseOwnersImpl: async () => createTestReleaseOwners(),
    }),
    /exactly one CLI target/i,
  );
});

test('workspace-source managed runtime construction stays inside the inherited lease and canonical payload owner', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const previousLease = process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD;
  delete process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD;
  const observations = [];

  try {
    await buildCliBinaryArtifacts(
      {
        repoRoot: fixture.repoRoot,
        outDir: fixture.outputRoot,
        channel: 'dev',
        version: '0.2.10',
        targets: [linuxX64TargetKey],
        cliProxyApiManagedRuntime: {
          kind: 'build-from-workspace-source',
        },
        env: {
          ...process.env,
          HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: inheritedLease,
        },
      },
      {
        loadCliBinaryReleaseOwnersImpl: async () => createTestReleaseOwners(),
        buildCliBinaryArtifactPayloadImpl: async (params) => {
          observations.push({
            managedRuntime: params.cliProxyApiManagedRuntimeExecutablePath,
            lease: process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD,
          });
        },
        finalizeMacOSPayloadForArchiveImpl: () => null,
        packagePreparedTargetBinaryImpl: async ({ outDir, target }) => ({
          name: 'happier-v0.2.10-linux-x64.tar.gz',
          path: join(outDir, 'happier-v0.2.10-linux-x64.tar.gz'),
          os: target.os,
          arch: target.arch,
        }),
        writeChecksumsFileImpl: async ({ outDir }) => join(
          outDir,
          'checksums-happier-v0.2.10.txt',
        ),
        maybeSignFileImpl: async () => null,
        cleanupTempDirBestEffortImpl: async () => ({ timedOut: false }),
      },
    );
  } finally {
    if (previousLease === undefined) {
      delete process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD;
    } else {
      process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD = previousLease;
    }
  }

  assert.deepEqual(observations, [{
    managedRuntime: undefined,
    lease: inheritedLease,
  }]);
});

test('intermediate failure still cleans the caller temp build and restores env without hiding the primary failure', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const envMarkerName = 'HAPPIER_TEST_CANDIDATE_FAILURE_ENV';
  const previousLease = process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD;
  const previousMarker = process.env[envMarkerName];
  delete process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD;
  delete process.env[envMarkerName];
  const cleanupCalls = [];
  const warnings = [];

  try {
    await assert.rejects(
      buildCliBinaryArtifacts(
        {
          repoRoot: fixture.repoRoot,
          outDir: fixture.outputRoot,
          channel: 'dev',
          version: '0.2.10',
          targets: [linuxX64TargetKey],
          cliProxyApiManagedRuntime: {
            kind: 'build-from-workspace-source',
          },
          env: {
            ...process.env,
            HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: inheritedLease,
            [envMarkerName]: 'temporary-failure-scope',
          },
        },
        {
          loadCliBinaryReleaseOwnersImpl: async () => createTestReleaseOwners(),
          buildCliBinaryArtifactPayloadImpl: async () => {},
          finalizeMacOSPayloadForArchiveImpl: () => null,
          packagePreparedTargetBinaryImpl: async () => {
            throw new Error('primary archive failure');
          },
          cleanupTempDirBestEffortImpl: async (params) => {
            cleanupCalls.push(params);
            throw new Error('secondary cleanup failure');
          },
          warnImpl: (message) => warnings.push(message),
        },
      ),
      /primary archive failure/,
    );
    assert.equal(cleanupCalls.length, 1);
    assert.match(cleanupCalls[0].tempDir, /[/\\]\.tmp-cli-binaries[/\\]build-/);
    assert.deepEqual(warnings, [
      '[release] temp cleanup failed after CLI binary build failure: secondary cleanup failure',
    ]);
    assert.equal(process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD, undefined);
    assert.equal(process.env[envMarkerName], undefined);
    assert.equal(
      JSON.parse(await readFile(fixture.cliPackageJsonPath, 'utf8')).version,
      '0.2.10',
    );
  } finally {
    if (previousLease === undefined) {
      delete process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD;
    } else {
      process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD = previousLease;
    }
    if (previousMarker === undefined) {
      delete process.env[envMarkerName];
    } else {
      process.env[envMarkerName] = previousMarker;
    }
  }
});

test('CLI entrypoint delegates to the programmatic owner with the existing shared output and temp roots', async () => {
  const calls = [];
  const lines = [];
  const repoRoot = '/workspace/happier';
  await main(
    [
      '--channel',
      'preview',
      '--version',
      '0.2.10',
      '--targets',
      linuxX64TargetKey,
      '--cliproxyapi-managed-runtime-executable',
      'artifacts/happier-cliproxyapi-managed',
    ],
    {
      repoRoot,
      env: { HAPPIER_CLI_BUN_EXTERNALS: 'dependency-a,dependency-b' },
      loadCliBinaryReleaseOwnersImpl: async () => createTestReleaseOwners(),
      buildCliBinaryArtifactsImpl: async (params) => {
        calls.push(params);
        return {
          product: 'happier',
          channel: 'preview',
          version: '0.2.10',
          outDir: join(repoRoot, 'dist', 'release-assets', 'cli'),
          artifacts: [{
            name: 'happier-v0.2.10-linux-x64.tar.gz',
            path: join(
              repoRoot,
              'dist',
              'release-assets',
              'cli',
              'happier-v0.2.10-linux-x64.tar.gz',
            ),
            os: 'linux',
            arch: 'x64',
          }],
          checksumsPath: join(
            repoRoot,
            'dist',
            'release-assets',
            'cli',
            'checksums-happier-v0.2.10.txt',
          ),
          signaturePath: null,
        };
      },
      logImpl: (line) => lines.push(line),
    },
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    repoRoot,
    outDir: join(repoRoot, 'dist', 'release-assets', 'cli'),
    tempBaseDir: join(repoRoot, 'dist', 'release-assets', '.tmp-cli-binaries'),
    channel: 'preview',
    version: '0.2.10',
    targets: [linuxX64TargetKey],
    externals: ['dependency-a', 'dependency-b'],
    cliProxyApiManagedRuntime: {
      kind: 'prebuilt-executable',
      executablePath: join(repoRoot, 'artifacts', 'happier-cliproxyapi-managed'),
    },
    macOSSigningIdentity: '',
    macOSNotarizationOutputPath: '',
    env: { HAPPIER_CLI_BUN_EXTERNALS: 'dependency-a,dependency-b' },
  });
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    product: 'happier',
    channel: 'preview',
    version: '0.2.10',
    outDir: join(repoRoot, 'dist', 'release-assets', 'cli'),
    artifacts: ['happier-v0.2.10-linux-x64.tar.gz'],
    checksums: join(
      repoRoot,
      'dist',
      'release-assets',
      'cli',
      'checksums-happier-v0.2.10.txt',
    ),
    signature: null,
  });
});

test('CLI entrypoint makes workspace-source wrapper construction explicit when no prebuilt input is assigned', async () => {
  const calls = [];
  await main(
    ['--channel', 'dev', '--version', '0.2.10', '--targets', linuxX64TargetKey],
    {
      repoRoot: '/workspace/happier',
      env: {},
      loadCliBinaryReleaseOwnersImpl: async () => createTestReleaseOwners(),
      buildCliBinaryArtifactsImpl: async (params) => {
        calls.push(params);
        return {
          product: 'happier',
          channel: 'dev',
          version: '0.2.10',
          outDir: params.outDir,
          artifacts: [],
          checksumsPath: join(params.outDir, 'checksums-happier-v0.2.10.txt'),
          signaturePath: null,
        };
      },
      logImpl: () => {},
    },
  );

  assert.deepEqual(calls[0].cliProxyApiManagedRuntime, {
    kind: 'build-from-workspace-source',
  });
});
