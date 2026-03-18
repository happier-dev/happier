import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

function writeWorkspacePackageFixture({ repoRoot, packageName, relativeDir }) {
  const packageDir = join(repoRoot, ...relativeDir);
  const distDir = join(packageDir, 'dist');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify(
      {
        name: packageName,
        version: '0.0.0',
        type: 'module',
        exports: {
          '.': {
            import: {
              default: './dist/index.mjs',
            },
          },
        },
        dependencies: {},
      },
      null,
      2,
    ),
    'utf8',
  );
  writeFileSync(join(distDir, 'index.mjs'), `export const packageName = ${JSON.stringify(packageName)};\n`, 'utf8');
}

function writeCliArtifactFixtures(repoRoot) {
  const cliDir = join(repoRoot, 'apps', 'cli');
  const cliScriptsDir = join(repoRoot, 'apps', 'cli', 'scripts');
  const cliShimsDir = join(cliScriptsDir, 'shims');
  const cliRuntimeDir = join(cliScriptsDir, 'runtime');
  const transformersDir = join(repoRoot, 'node_modules', '@huggingface', 'transformers');
  const ortDir = join(repoRoot, 'node_modules', 'onnxruntime-node');
  const ortCommonDir = join(repoRoot, 'node_modules', 'onnxruntime-common');
  const nodePtyDir = join(repoRoot, 'node_modules', 'node-pty');
  const homebridgePtyDir = join(repoRoot, 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch');

  mkdirSync(cliDir, { recursive: true });
  mkdirSync(cliShimsDir, { recursive: true });
  mkdirSync(cliRuntimeDir, { recursive: true });
  mkdirSync(transformersDir, { recursive: true });
  mkdirSync(ortDir, { recursive: true });
  mkdirSync(ortCommonDir, { recursive: true });
  mkdirSync(nodePtyDir, { recursive: true });
  mkdirSync(homebridgePtyDir, { recursive: true });

  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'repo', private: true }, null, 2));
  writeFileSync(
    join(cliDir, 'package.json'),
    JSON.stringify(
      {
        name: '@happier-dev/cli',
        version: '0.0.0',
        dependencies: {
          '@huggingface/transformers': '1.0.0',
          'node-pty': '1.0.0',
          '@homebridge/node-pty-prebuilt-multiarch': '1.0.0',
        },
        bundledDependencies: [
          '@happier-dev/agents',
          '@happier-dev/cli-common',
          '@happier-dev/connection-supervisor',
          '@happier-dev/protocol',
          '@happier-dev/release-runtime',
        ],
      },
      null,
      2,
    ),
    'utf8',
  );
  writeWorkspacePackageFixture({ repoRoot, packageName: '@happier-dev/agents', relativeDir: ['packages', 'agents'] });
  writeWorkspacePackageFixture({ repoRoot, packageName: '@happier-dev/cli-common', relativeDir: ['packages', 'cli-common'] });
  writeWorkspacePackageFixture({ repoRoot, packageName: '@happier-dev/connection-supervisor', relativeDir: ['packages', 'connection-supervisor'] });
  writeWorkspacePackageFixture({ repoRoot, packageName: '@happier-dev/protocol', relativeDir: ['packages', 'protocol'] });
  writeWorkspacePackageFixture({ repoRoot, packageName: '@happier-dev/release-runtime', relativeDir: ['packages', 'release-runtime'] });
  writeFileSync(join(cliScriptsDir, 'childProcessOptions.cjs'), 'module.exports = { withWindowsHide: (input) => input };\n', 'utf8');
  writeFileSync(join(cliScriptsDir, 'claude_version_utils.cjs'), 'module.exports = { getClaudeCliPath: () => "claude", runClaudeCli: () => {} };\n', 'utf8');
  writeFileSync(join(cliScriptsDir, 'claude_local_launcher.cjs'), 'require("./claude_version_utils.cjs");\n', 'utf8');
  writeFileSync(join(cliScriptsDir, 'claude_remote_launcher.cjs'), 'require("./claude_version_utils.cjs");\n', 'utf8');
  writeFileSync(join(cliScriptsDir, 'session_hook_forwarder.cjs'), 'console.log("session");\n', 'utf8');
  writeFileSync(join(cliScriptsDir, 'permission_hook_forwarder.cjs'), 'console.log("permission");\n', 'utf8');
  writeFileSync(join(cliScriptsDir, 'ripgrep_launcher.cjs'), 'require("./childProcessOptions.cjs");\n', 'utf8');
  writeFileSync(join(cliRuntimeDir, 'loadTransformersFromRuntime.mjs'), 'export const env = {}; export async function pipeline() { return () => null; }\n', 'utf8');
  writeFileSync(join(cliShimsDir, 'git'), '#!/bin/sh\nexit 0\n', 'utf8');
  writeFileSync(join(cliShimsDir, 'rg'), '#!/bin/sh\nexit 0\n', 'utf8');
  writeFileSync(
    join(transformersDir, 'package.json'),
    JSON.stringify({ name: '@huggingface/transformers', version: '1.0.0', dependencies: { 'onnxruntime-node': '1.0.0' } }, null, 2),
  );
  writeFileSync(join(transformersDir, 'index.js'), 'module.exports = {};\n', 'utf8');
  writeFileSync(
    join(ortDir, 'package.json'),
    JSON.stringify({ name: 'onnxruntime-node', version: '1.0.0', dependencies: { 'onnxruntime-common': '1.0.0' } }, null, 2),
  );
  writeFileSync(join(ortDir, 'index.js'), 'module.exports = {};\n', 'utf8');
  writeFileSync(
    join(ortCommonDir, 'package.json'),
    JSON.stringify({ name: 'onnxruntime-common', version: '1.0.0', dependencies: {} }, null, 2),
  );
  writeFileSync(join(ortCommonDir, 'index.js'), 'module.exports = {};\n', 'utf8');
  writeFileSync(
    join(nodePtyDir, 'package.json'),
    JSON.stringify({ name: 'node-pty', version: '1.0.0', dependencies: {} }, null, 2),
  );
  writeFileSync(join(nodePtyDir, 'index.js'), 'module.exports = { spawn() {} };\n', 'utf8');
  writeFileSync(
    join(homebridgePtyDir, 'package.json'),
    JSON.stringify({ name: '@homebridge/node-pty-prebuilt-multiarch', version: '1.0.0', dependencies: {} }, null, 2),
  );
  writeFileSync(join(homebridgePtyDir, 'index.js'), 'module.exports = { spawn() {} };\n', 'utf8');
}

test('buildCliBinaryArtifactPayload reuses the first completed dist build across concurrent artifact requests', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'component-artifacts-cli-lock-'));
  try {
    const repoRoot = join(tempRoot, 'repo');
    const cliDistDir = join(repoRoot, 'apps', 'cli', 'dist');
    const payloadDirA = join(tempRoot, 'payload-a');
    const payloadDirB = join(tempRoot, 'payload-b');

    writeCliArtifactFixtures(repoRoot);

    const artifacts = await import('../dist/componentArtifacts/index.js');
    const target = artifacts.resolveCurrentBinaryTarget({
      availableTargets: artifacts.CLI_BINARY_TARGETS,
      platform: 'linux',
      arch: 'x64',
    });

    let releaseFirstBuild = null;
    const firstBuildRelease = new Promise((resolve) => {
      releaseFirstBuild = resolve;
    });
    const runCalls = [];

    const runCommand = async (cmd, args) => {
      runCalls.push({ cmd, args });
      assert.equal(runCalls.length, 1, 'concurrent artifact requests should not trigger a second CLI dist build');
      await firstBuildRelease;
      mkdirSync(cliDistDir, { recursive: true });
      writeFileSync(join(cliDistDir, 'index.mjs'), 'console.log("cli");\n', 'utf8');
    };

    const compileBinary = async ({ outfile }) => {
      writeFileSync(outfile, '#!/bin/sh\necho happier\n', 'utf8');
    };

    const first = artifacts.buildCliBinaryArtifactPayload({
      repoRoot,
      payloadDir: payloadDirA,
      target,
      commandProbe: () => true,
      runCommand,
      compileBinary,
    });
    const second = artifacts.buildCliBinaryArtifactPayload({
      repoRoot,
      payloadDir: payloadDirB,
      target,
      commandProbe: () => true,
      runCommand,
      compileBinary,
    });

    for (let attempts = 0; attempts < 20 && runCalls.length === 0; attempts += 1) {
      await delay(10);
    }
    assert.equal(runCalls.length, 1, 'the first artifact request should begin the shared CLI dist build');
    releaseFirstBuild();

    await Promise.all([first, second]);

    assert.equal(runCalls.length, 1);
    assert.equal(existsSync(join(payloadDirA, 'happier')), true);
    assert.equal(existsSync(join(payloadDirB, 'happier')), true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
