import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  computePluginUiArtifactFileSetSha256DigestV1,
  computePluginUiArtifactSha256DigestV1,
} from '@happier-dev/protocol/plugins/ui';
import {
  assertPluginExecutableEventsOwnedByDaemons,
  DevChangeStream,
  ISOLATED_DAEMON_START_WAIT_TIMEOUT_MS,
  ISOLATED_DAEMON_RESTART_ARGS,
  PACKED_PLUGINS_DEV_UI_MODES,
  PLUGIN_INSTALL_APPROVAL_TIMEOUT_MS,
  PLUGINS_DEV_CHANGE_TIMEOUT_MS,
  preparePackedPluginsDevCandidateArtifacts,
  readPackedPluginsDevUiArtifactEvidence,
  resolvePluginInstallReviewFacts,
  resolvePluginsDevPtyLaunch,
  runCommandUntilOutput,
} from './runPackedPluginsDev';
import type { PackedAuthorCandidate } from '../../scripts/plugin-platform/run-packed-author-ui-compat.mjs';

test('allows the Linux author toolchain and daemon decision boundary to finish before timing out', () => {
  assert.equal(PLUGINS_DEV_CHANGE_TIMEOUT_MS, 600_000);
  assert.equal(ISOLATED_DAEMON_START_WAIT_TIMEOUT_MS, PLUGINS_DEV_CHANGE_TIMEOUT_MS);
  assert.equal(PLUGIN_INSTALL_APPROVAL_TIMEOUT_MS, ISOLATED_DAEMON_START_WAIT_TIMEOUT_MS);
});

test('takes over the isolated manual daemon when proving restart recovery', () => {
  assert.deepEqual(ISOLATED_DAEMON_RESTART_ARGS, ['daemon', 'restart', '--takeover', '--json']);
});

test('runs the ordinary packed dev lifecycle for both generated UI modes', () => {
  assert.deepEqual(PACKED_PLUGINS_DEV_UI_MODES, ['reactNative', 'hostedWeb']);
});

test('reads each generated UI mode from its immutable artifact graph and rejects altered emitted bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-plugins-dev-ui-artifact-'));
  const generation = 'generation-2';
  const artifactRoot = join(
    root,
    'plugins',
    'plugins',
    'generations',
    generation,
    'dist',
    'happier-plugin-ui',
  );
  const artifacts = [
    { relativePath: 'react-native/preview-native/ios.bundle', bytes: Buffer.from('ios bundle') },
    { relativePath: 'react-native/preview-native/android.bundle', bytes: Buffer.from('android bundle') },
    { relativePath: 'react-native-web/preview-native/entry.mjs.bundle', bytes: Buffer.from('web native entry') },
    { relativePath: 'hosted-web/preview-hosted/index.html', bytes: Buffer.from('<main>hosted</main>') },
  ];
  const artifact = (relativePath: string) => {
    const found = artifacts.find((candidate) => candidate.relativePath === relativePath);
    assert.ok(found, `Expected fixture bytes for ${relativePath}`);
    return {
      relativePath,
      digest: computePluginUiArtifactSha256DigestV1(found.bytes),
      byteSize: found.bytes.byteLength,
    };
  };
  const entry = (input: Readonly<{
    contributionId: string;
    tier: 'reactNative' | 'hostedWeb';
    platform: 'ios' | 'android' | 'web';
    relativePath: string;
  }>) => {
    const file = artifact(input.relativePath);
    const isNative = input.tier === 'reactNative' && input.platform !== 'web';
    return {
      contributionId: input.contributionId,
      tier: input.tier,
      platform: input.platform,
      ...(isNative ? {
        repack: {
          containerName: 'preview_native',
          modulePath: './renderSurface',
          exportName: 'renderSurface',
        },
      } : {}),
      entry: input.relativePath,
      files: [file],
      digest: computePluginUiArtifactFileSetSha256DigestV1([{
        relativePath: file.relativePath,
        bytes: artifacts.find((candidate) => candidate.relativePath === file.relativePath)?.bytes ?? Buffer.alloc(0),
      }]),
      builtWith: {
        bundler: isNative ? 'repack' : 'vite',
        version: '1.0.0',
      },
      hostUiApiVersion: '1.0.0',
      compat: input.tier === 'reactNative'
        ? { react: '19.2.0', reactNative: '0.83.4' }
        : {},
    };
  };

  try {
    await Promise.all(artifacts.map(async ({ relativePath, bytes }) => {
      const outputPath = join(artifactRoot, ...relativePath.split('/'));
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, bytes);
    }));
    await writeFile(join(artifactRoot, 'ui-artifacts.json'), JSON.stringify({
      version: 1,
      entries: [
        entry({ contributionId: 'preview-native', tier: 'reactNative', platform: 'ios', relativePath: artifacts[0]!.relativePath }),
        entry({ contributionId: 'preview-native', tier: 'reactNative', platform: 'android', relativePath: artifacts[1]!.relativePath }),
        entry({ contributionId: 'preview-native', tier: 'reactNative', platform: 'web', relativePath: artifacts[2]!.relativePath }),
        entry({ contributionId: 'preview-hosted', tier: 'hostedWeb', platform: 'web', relativePath: artifacts[3]!.relativePath }),
      ],
    }), 'utf8');

    const [native, hosted] = await Promise.all([
      readPackedPluginsDevUiArtifactEvidence({ happyHomeDir: root, generation, mode: 'reactNative' }),
      readPackedPluginsDevUiArtifactEvidence({ happyHomeDir: root, generation, mode: 'hostedWeb' }),
    ]);
    assert.equal(native.contributionId, 'preview-native');
    assert.deepEqual(native.artifacts.map((candidate) => candidate.platform), ['android', 'ios', 'web']);
    assert.equal(hosted.contributionId, 'preview-hosted');
    assert.deepEqual(hosted.artifacts.map((candidate) => candidate.platform), ['web']);

    await writeFile(join(artifactRoot, ...artifacts[1]!.relativePath.split('/')), 'altered android bundle', 'utf8');
    await assert.rejects(
      readPackedPluginsDevUiArtifactEvidence({ happyHomeDir: root, generation, mode: 'reactNative' }),
      /artifact digest did not match emitted bytes for android/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('uses the node-pty terminal adapter without shell argument injection on supported hosts', () => {
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    const launch = resolvePluginsDevPtyLaunch(platform, '/opt/node binary', [
      '/tmp/happier cli.mjs',
      'plugins',
      'install',
      "/tmp/author's plugin",
    ]);
    assert.ok(launch);
    assert.equal(launch.command, process.execPath);
    assert.match(launch.args[0] ?? '', /run-command-in-pty\.mjs$/u);
    assert.deepEqual(launch.args.slice(1), [
      '--',
      '/opt/node binary',
      '/tmp/happier cli.mjs',
      'plugins',
      'install',
      "/tmp/author's plugin",
    ]);
  }
});

test('compares terminal review evidence against the canonical plugin source path', async () => {
  const facts = await resolvePluginInstallReviewFacts(
    '/var/folders/example/plugin',
    async (path) => {
      assert.equal(path, '/var/folders/example/plugin');
      return '/private/var/folders/example/plugin';
    },
  );

  assert.ok(facts.includes('Source: /private/var/folders/example/plugin'));
  assert.ok(!facts.includes('Source: /var/folders/example/plugin'));
  assert.ok(facts.includes('Required disclosures and cooperative services:'));
  assert.ok(facts.includes('Optional host-owned resources (off by default):'));
});

test('releases a terminal wrapper after the command emits its final success evidence', async () => {
  const startedAt = Date.now();
  const result = await runCommandUntilOutput(
    process.execPath,
    ['-e', "process.stdout.write('installed\\n'); setInterval(() => {}, 1_000)"],
    {
      cwd: process.cwd(),
      env: process.env,
      input: '',
      completionText: 'installed',
      timeoutMs: 2_000,
    },
  );

  assert.equal(result.completedByOutput, true);
  assert.match(result.stdout, /installed/u);
  assert.ok(Date.now() - startedAt < 1_500);
});

test('the node-pty launcher helper presents real terminal streams to its child', async () => {
  const launch = resolvePluginsDevPtyLaunch('win32', process.execPath, [
    '-e',
    "process.stdout.write(JSON.stringify({ stdin: process.stdin.isTTY, stdout: process.stdout.isTTY }) + '\\n')",
  ]);
  assert.ok(launch);

  const result = await runCommandUntilOutput(launch.command, launch.args, {
    cwd: process.cwd(),
    env: process.env,
    input: '',
    completionText: '"stdout":true',
    timeoutMs: 5_000,
  });

  assert.match(result.stdout, /"stdin":true/u);
  assert.match(result.stdout, /"stdout":true/u);
});

test('the node-pty launcher helper exits when its terminal child exits', async () => {
  const launch = resolvePluginsDevPtyLaunch('win32', process.execPath, [
    '-e',
    "process.stdout.write('done\\n'); process.exitCode = 17",
  ]);
  assert.ok(launch);
  const child = spawn(launch.command, [...launch.args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const result = await new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>(
    (resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('PTY launcher did not exit after its terminal child'));
      }, 2_000);
      child.once('close', (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal });
      });
    },
  );

  assert.deepEqual(result, { code: 17, signal: null });
});

test('rejects any plugin executable graph observed outside the allowed daemon processes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-plugins-dev-daemon-owner-'));
  const markerPath = join(root, 'events.jsonl');
  try {
    await writeFile(markerPath, [
      JSON.stringify({
        kind: 'module',
        activationInstanceId: 'daemon-generation',
        pid: 101,
        state: { revisionTag: 'one', entry: 'one', transitive: 'one', nested: 'one' },
      }),
      JSON.stringify({
        kind: 'activate',
        activationInstanceId: 'cli-generation',
        pid: 202,
        state: { revisionTag: 'one', entry: 'one', transitive: 'one', nested: 'one' },
      }),
      '',
    ].join('\n'), 'utf8');

    await assert.rejects(
      assertPluginExecutableEventsOwnedByDaemons(markerPath, new Set([101]), 'pre-restart'),
      /outside the allowed daemon processes.*pid=202/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('prepares consumer-private candidate artifacts before mutable sources can be reopened', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-plugins-dev-candidate-copy-'));
  const sourceRoot = join(root, 'source');
  const consumerRoot = join(root, 'consumer');
  const sdkSourcePath = join(sourceRoot, 'sdk.tgz');
  const pluginUiSourcePath = join(sourceRoot, 'plugin-ui.tgz');
  const cliSourcePath = join(sourceRoot, 'cli.tgz');
  const sdkBytes = Buffer.from('verified sdk bytes');
  const pluginUiBytes = Buffer.from('verified plugin ui bytes');
  const cliBytes = Buffer.from('verified cli bytes');
  const integrity = (bytes: Uint8Array): string => (
    `sha512-${createHash('sha512').update(bytes).digest('base64')}`
  );
  const candidate: PackedAuthorCandidate = {
    schemaVersion: 1,
    runId: 'plugins-dev-private-copy',
    installers: {
      releaseChannel: 'dev',
      shell: { kind: 'shell', fileName: 'install-dev.sh', sizeBytes: 1, sha256: '1'.repeat(64), filePath: join(sourceRoot, 'install-dev.sh') },
      powershell: { kind: 'powershell', fileName: 'install-dev.ps1', sizeBytes: 1, sha256: '2'.repeat(64), filePath: join(sourceRoot, 'install-dev.ps1') },
      publicKey: { kind: 'minisign-public-key', fileName: 'happier-release.pub', sizeBytes: 1, sha256: '3'.repeat(64), filePath: join(sourceRoot, 'happier-release.pub') },
    },
    sdk: {
      packageName: '@happier-dev/plugin-sdk',
      version: '1.2.3',
      integrity: integrity(sdkBytes),
      tarballPath: sdkSourcePath,
    },
    pluginUi: {
      packageName: '@happier-dev/plugin-ui',
      version: '1.2.3',
      pluginSdkVersion: '1.2.3',
      integrity: integrity(pluginUiBytes),
      tarballPath: pluginUiSourcePath,
    },
    cli: {
      packageName: '@happier-dev/cli',
      version: '1.2.3',
      integrity: integrity(cliBytes),
      tarballPath: cliSourcePath,
      entrypoint: 'package/bin/happier.mjs',
    },
    standaloneCli: {
      product: 'happier',
      version: '1.2.3',
      os: 'linux',
      arch: 'x64',
      sha256: '4'.repeat(64),
      archivePath: join(sourceRoot, 'happier-v1.2.3-linux-x64.tar.gz'),
      archives: [{
        product: 'happier',
        version: '1.2.3',
        os: 'linux',
        arch: 'x64',
        sha256: '4'.repeat(64),
        archivePath: join(sourceRoot, 'happier-v1.2.3-linux-x64.tar.gz'),
      }],
      checksums: { kind: 'sha256-checksums', fileName: 'checksums-happier-v1.2.3.txt', sizeBytes: 1, sha256: '5'.repeat(64), filePath: join(sourceRoot, 'checksums-happier-v1.2.3.txt') },
      signature: { kind: 'minisign-signature', fileName: 'checksums-happier-v1.2.3.txt.minisig', sizeBytes: 1, sha256: '6'.repeat(64), filePath: join(sourceRoot, 'checksums-happier-v1.2.3.txt.minisig') },
      notarization: [],
    },
  };
  const registry = {
    origin: 'http://127.0.0.1:4873',
    packages: [],
    close: async () => {},
  };
  const preparedSdkPath = join(consumerRoot, 'verified-sdk.tgz');
  const preparedPluginUiPath = join(consumerRoot, 'verified-plugin-ui.tgz');
  const preparedCliPath = join(consumerRoot, 'verified-cli.tgz');

  try {
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(consumerRoot, { recursive: true });
    await Promise.all([
      writeFile(sdkSourcePath, sdkBytes),
      writeFile(pluginUiSourcePath, pluginUiBytes),
      writeFile(cliSourcePath, cliBytes),
    ]);

    const prepared = await preparePackedPluginsDevCandidateArtifacts(
      candidate,
      consumerRoot,
      {
        readPackedPackageManifest: async (path: string) => {
          assert.notEqual(path, sdkSourcePath);
          await Promise.all([
            writeFile(sdkSourcePath, 'mutated sdk bytes'),
            writeFile(pluginUiSourcePath, 'mutated plugin ui bytes'),
            writeFile(cliSourcePath, 'mutated cli bytes'),
          ]);
          if (path === preparedSdkPath) {
            assert.deepEqual(await readFile(path), sdkBytes);
            return { name: candidate.sdk.packageName, version: candidate.sdk.version };
          }
          assert.equal(path, preparedPluginUiPath);
          assert.deepEqual(await readFile(path), pluginUiBytes);
          return { name: candidate.pluginUi.packageName, version: candidate.pluginUi.version };
        },
        assertPackedPackageIdentity: (manifest, artifact) => {
          if (artifact.packageName === candidate.sdk.packageName) {
            assert.deepEqual(manifest, {
              name: candidate.sdk.packageName,
              version: candidate.sdk.version,
            });
            assert.equal(artifact.tarballPath, preparedSdkPath);
            return;
          }
          assert.deepEqual(manifest, {
            name: candidate.pluginUi.packageName,
            version: candidate.pluginUi.version,
          });
          assert.equal(artifact.tarballPath, preparedPluginUiPath);
        },
        assertPackedPluginUiSdkDependency: (manifest, artifact) => {
          assert.deepEqual(manifest, {
            name: candidate.pluginUi.packageName,
            version: candidate.pluginUi.version,
          });
          assert.equal(artifact.packageName, candidate.sdk.packageName);
          assert.equal(artifact.version, candidate.sdk.version);
          return candidate.sdk.version;
        },
        startCandidateRegistry: async (input) => {
          assert.equal(input.packages.length, 2);
          assert.deepEqual(input.packages.map((entry) => entry.packageName), [
            candidate.sdk.packageName,
            candidate.pluginUi.packageName,
          ]);
          assert.equal((input.packages[0] as unknown as { tarballPath: string }).tarballPath, preparedSdkPath);
          assert.equal((input.packages[1] as unknown as { tarballPath: string }).tarballPath, preparedPluginUiPath);
          assert.deepEqual(input.packages[0]?.bytes, sdkBytes);
          assert.deepEqual(input.packages[1]?.bytes, pluginUiBytes);
          return registry;
        },
        materializePackedCli: async (input) => {
          assert.equal(input.cliArtifact.tarballPath, preparedCliPath);
          assert.deepEqual(await readFile(input.cliArtifact.tarballPath), cliBytes);
          return join(consumerRoot, 'cli-install', 'bin', 'happier.mjs');
        },
      },
    );

    assert.equal(prepared.candidate.sdk.tarballPath, preparedSdkPath);
    assert.equal(prepared.candidate.pluginUi.tarballPath, preparedPluginUiPath);
    assert.equal(prepared.candidate.cli.tarballPath, preparedCliPath);
    assert.deepEqual(await readFile(preparedSdkPath), sdkBytes);
    assert.deepEqual(await readFile(preparedPluginUiPath), pluginUiBytes);
    assert.deepEqual(await readFile(preparedCliPath), cliBytes);
    assert.equal(prepared.registry, registry);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('delivers consecutive plugin development changes to consecutive waiters', async () => {
  const stream = new DevChangeStream(() => 'test stream');
  const first = stream.next();

  stream.push({
    ok: true,
    kind: 'plugins_dev_change',
    data: { observedFiles: 1 },
  });
  const firstChange = await first;
  if (!firstChange.ok) assert.fail('Expected the first development change to succeed');
  assert.equal(firstChange.data.observedFiles, 1);

  const second = stream.next(100);
  stream.push({
    ok: true,
    kind: 'plugins_dev_change',
    data: { observedFiles: 2 },
  });
  const secondChange = await second;
  if (!secondChange.ok) assert.fail('Expected the second development change to succeed');
  assert.equal(secondChange.data.observedFiles, 2);
});
