import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

function writeCliRuntimePackageFixture(
  repoRoot,
  bundledDependencies = [
    '@happier-dev/agents',
    '@happier-dev/cli-common',
    '@happier-dev/connection-supervisor',
    '@happier-dev/protocol',
    '@happier-dev/release-runtime',
  ],
) {
  const cliDir = join(repoRoot, 'apps', 'cli');
  mkdirSync(cliDir, { recursive: true });
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
        bundledDependencies,
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
}

test('resolveCurrentBinaryTarget maps the current platform to a supported binary target', async () => {
  const artifacts = await import('../dist/componentArtifacts/index.js');
  assert.equal(typeof artifacts.resolveCurrentBinaryTarget, 'function');

  const linux = artifacts.resolveCurrentBinaryTarget({
    availableTargets: artifacts.CLI_BINARY_TARGETS,
    platform: 'linux',
    arch: 'x64',
  });
  assert.deepEqual(linux, {
    bunTarget: 'bun-linux-x64-baseline',
    os: 'linux',
    arch: 'x64',
    exeExt: '',
  });

  const windows = artifacts.resolveCurrentBinaryTarget({
    availableTargets: artifacts.CLI_BINARY_TARGETS,
    platform: 'win32',
    arch: 'x64',
  });
  assert.deepEqual(windows, {
    bunTarget: 'bun-windows-x64',
    os: 'windows',
    arch: 'x64',
    exeExt: '.exe',
  });
});

test('commandExists does not execute shell metacharacters on Unix', async () => {
  if (process.platform === 'win32') return;

  const tempRoot = mkdtempSync(join(tmpdir(), 'component-artifacts-command-exists-'));
  try {
    const probePath = join(tempRoot, 'probe');
    const artifacts = await import('../dist/componentArtifacts/index.js');
    assert.equal(artifacts.commandExists(`missing-command; touch ${JSON.stringify(probePath)}`), false);
    assert.equal(existsSync(probePath), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('buildCliBinaryArtifactPayload compiles the local CLI binary into the payload dir', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'component-artifacts-cli-'));
  try {
    const repoRoot = join(tempRoot, 'repo');
    const payloadDir = join(tempRoot, 'payload');
    const cliDistDir = join(repoRoot, 'apps', 'cli', 'dist');
    const cliScriptsDir = join(repoRoot, 'apps', 'cli', 'scripts');
    const cliShimsDir = join(cliScriptsDir, 'shims');
    const cliRuntimeDir = join(cliScriptsDir, 'runtime');
    const transformersDir = join(repoRoot, 'node_modules', '@huggingface', 'transformers');
    const ortDir = join(repoRoot, 'node_modules', 'onnxruntime-node');
    const ortCommonDir = join(repoRoot, 'node_modules', 'onnxruntime-common');
    const nodePtyDir = join(repoRoot, 'node_modules', 'node-pty');
    const homebridgePtyDir = join(repoRoot, 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch');

    mkdirSync(cliDistDir, { recursive: true });
    mkdirSync(cliShimsDir, { recursive: true });
    mkdirSync(cliRuntimeDir, { recursive: true });
    mkdirSync(transformersDir, { recursive: true });
    mkdirSync(ortDir, { recursive: true });
    mkdirSync(ortCommonDir, { recursive: true });
    mkdirSync(nodePtyDir, { recursive: true });
    mkdirSync(homebridgePtyDir, { recursive: true });
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'repo', private: true }, null, 2));
    writeCliRuntimePackageFixture(repoRoot);
    writeFileSync(join(cliDistDir, 'index.mjs'), 'console.log("cli");\n', 'utf8');
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

    const artifacts = await import('../dist/componentArtifacts/index.js');
    const compileCalls = [];
    const runCalls = [];
    const result = await artifacts.buildCliBinaryArtifactPayload({
      repoRoot,
      payloadDir,
      target: artifacts.resolveCurrentBinaryTarget({
        availableTargets: artifacts.CLI_BINARY_TARGETS,
        platform: 'linux',
        arch: 'x64',
      }),
      commandProbe: () => true,
      runCommand: (cmd, args) => {
        runCalls.push({ cmd, args });
        mkdirSync(cliDistDir, { recursive: true });
        writeFileSync(join(cliDistDir, 'index.mjs'), 'console.log("cli");\n', 'utf8');
      },
      compileBinary: async ({ outfile, externals }) => {
        compileCalls.push({ outfile, externals });
        writeFileSync(outfile, '#!/bin/sh\necho happier\n', 'utf8');
      },
    });

    assert.equal(result.executableName, 'happier');
    assert.equal(result.entrypoint, 'happier');
    assert.deepEqual(runCalls, [{ cmd: 'yarn', args: ['--cwd', 'apps/cli', 'build'] }]);
    assert.equal(compileCalls.length, 1);
    assert.deepEqual(compileCalls[0].externals.sort(), [
      '@homebridge/node-pty-prebuilt-multiarch',
      '@huggingface/transformers',
      'node-pty',
    ]);
    assert.equal(readFileSync(join(payloadDir, 'happier'), 'utf8'), '#!/bin/sh\necho happier\n');
    assert.equal(readFileSync(join(payloadDir, 'package-dist', 'index.mjs'), 'utf8'), 'console.log("cli");\n');
    assert.equal(
      readFileSync(join(payloadDir, 'node_modules', '@happier-dev', 'protocol', 'dist', 'index.mjs'), 'utf8'),
      'export const packageName = "@happier-dev/protocol";\n',
    );
    assert.equal(
      readFileSync(join(payloadDir, 'node_modules', '@happier-dev', 'connection-supervisor', 'dist', 'index.mjs'), 'utf8'),
      'export const packageName = "@happier-dev/connection-supervisor";\n',
    );
    assert.equal(readFileSync(join(payloadDir, 'node_modules', 'node-pty', 'index.js'), 'utf8'), 'module.exports = { spawn() {} };\n');
    assert.equal(
      readFileSync(join(payloadDir, 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch', 'index.js'), 'utf8'),
      'module.exports = { spawn() {} };\n',
    );
    assert.equal(
      readFileSync(join(payloadDir, 'scripts', 'claude_version_utils.cjs'), 'utf8'),
      'module.exports = { getClaudeCliPath: () => "claude", runClaudeCli: () => {} };\n',
    );
    assert.equal(
      readFileSync(join(payloadDir, 'scripts', 'claude_local_launcher.cjs'), 'utf8'),
      'require("./claude_version_utils.cjs");\n',
    );
    assert.equal(
      readFileSync(join(payloadDir, 'scripts', 'childProcessOptions.cjs'), 'utf8'),
      'module.exports = { withWindowsHide: (input) => input };\n',
    );
    assert.equal(
      readFileSync(join(payloadDir, 'scripts', 'runtime', 'loadTransformersFromRuntime.mjs'), 'utf8'),
      'export const env = {}; export async function pipeline() { return () => null; }\n',
    );
    assert.equal(readFileSync(join(payloadDir, 'scripts', 'shims', 'git'), 'utf8'), '#!/bin/sh\nexit 0\n');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('buildCliBinaryArtifactPayload removes compile-generated node_modules before staging canonical runtime packages', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'component-artifacts-cli-compile-node-modules-'));
  try {
    const repoRoot = join(tempRoot, 'repo');
    const payloadDir = join(tempRoot, 'payload');
    const cliDistDir = join(repoRoot, 'apps', 'cli', 'dist');
    const cliScriptsDir = join(repoRoot, 'apps', 'cli', 'scripts');
    const cliRuntimeDir = join(cliScriptsDir, 'runtime');
    const transformersDir = join(repoRoot, 'node_modules', '@huggingface', 'transformers');
    const ortDir = join(repoRoot, 'node_modules', 'onnxruntime-node');
    const nodePtyDir = join(repoRoot, 'node_modules', 'node-pty');
    const homebridgePtyDir = join(repoRoot, 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch');
    const tarDir = join(repoRoot, 'node_modules', 'tar');
    const chownrDir = join(repoRoot, 'node_modules', 'chownr');

    mkdirSync(cliDistDir, { recursive: true });
    mkdirSync(join(cliScriptsDir, 'shims'), { recursive: true });
    mkdirSync(cliRuntimeDir, { recursive: true });
    mkdirSync(transformersDir, { recursive: true });
    mkdirSync(ortDir, { recursive: true });
    mkdirSync(nodePtyDir, { recursive: true });
    mkdirSync(homebridgePtyDir, { recursive: true });
    mkdirSync(tarDir, { recursive: true });
    mkdirSync(chownrDir, { recursive: true });
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'repo', private: true }, null, 2));
    writeCliRuntimePackageFixture(repoRoot);
    writeFileSync(
      join(repoRoot, 'apps', 'cli', 'package.json'),
      JSON.stringify(
        {
          name: '@happier-dev/cli',
          version: '0.0.0',
          dependencies: {
            '@huggingface/transformers': '1.0.0',
            'node-pty': '1.0.0',
            '@homebridge/node-pty-prebuilt-multiarch': '1.0.0',
            tar: '7.0.0',
          },
          bundledDependencies: [
            '@happier-dev/agents',
            '@happier-dev/cli-common',
            '@happier-dev/protocol',
            '@happier-dev/release-runtime',
          ],
        },
        null,
        2,
      ),
      'utf8',
    );
    writeFileSync(join(cliDistDir, 'index.mjs'), 'console.log("cli");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'childProcessOptions.cjs'), 'module.exports = { withWindowsHide: (input) => input };\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_version_utils.cjs'), 'module.exports = { getClaudeCliPath: () => "claude", runClaudeCli: () => {} };\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_local_launcher.cjs'), 'require("./claude_version_utils.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_remote_launcher.cjs'), 'require("./claude_version_utils.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'session_hook_forwarder.cjs'), 'console.log("session");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'permission_hook_forwarder.cjs'), 'console.log("permission");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'ripgrep_launcher.cjs'), 'require("./childProcessOptions.cjs");\n', 'utf8');
    writeFileSync(join(cliRuntimeDir, 'loadTransformersFromRuntime.mjs'), 'export const env = {}; export async function pipeline() { return () => null; }\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'shims', 'git'), '#!/bin/sh\nexit 0\n', 'utf8');
    writeFileSync(
      join(transformersDir, 'package.json'),
      JSON.stringify({ name: '@huggingface/transformers', version: '1.0.0', dependencies: { 'onnxruntime-node': '1.0.0' } }, null, 2),
    );
    writeFileSync(join(transformersDir, 'index.js'), 'module.exports = {};\n', 'utf8');
    writeFileSync(
      join(ortDir, 'package.json'),
      JSON.stringify({ name: 'onnxruntime-node', version: '1.0.0', dependencies: {} }, null, 2),
    );
    writeFileSync(join(ortDir, 'index.js'), 'module.exports = {};\n', 'utf8');
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
    writeFileSync(
      join(tarDir, 'package.json'),
      JSON.stringify({ name: 'tar', version: '7.0.0', type: 'module', dependencies: { chownr: '^3.0.0' } }, null, 2),
      'utf8',
    );
    writeFileSync(join(tarDir, 'index.js'), 'export {};\n', 'utf8');
    writeFileSync(
      join(chownrDir, 'package.json'),
      JSON.stringify({ name: 'chownr', version: '3.0.0', type: 'module' }, null, 2),
      'utf8',
    );
    writeFileSync(join(chownrDir, 'index.js'), 'export const chownr = () => {};\n', 'utf8');

    const artifacts = await import('../dist/componentArtifacts/index.js');
    await artifacts.buildCliBinaryArtifactPayload({
      repoRoot,
      payloadDir,
      target: artifacts.resolveCurrentBinaryTarget({
        availableTargets: artifacts.CLI_BINARY_TARGETS,
        platform: 'linux',
        arch: 'x64',
      }),
      commandProbe: () => true,
      runCommand: () => {
        mkdirSync(cliDistDir, { recursive: true });
        writeFileSync(join(cliDistDir, 'index.mjs'), 'console.log("cli");\n', 'utf8');
      },
      compileBinary: async ({ outfile }) => {
        const compileChownrDir = join(payloadDir, 'node_modules', 'chownr');
        const compileTarFsDir = join(payloadDir, 'node_modules', 'tar-fs');
        mkdirSync(compileChownrDir, { recursive: true });
        mkdirSync(compileTarFsDir, { recursive: true });
        writeFileSync(outfile, '#!/bin/sh\necho happier\n', 'utf8');
        writeFileSync(
          join(compileChownrDir, 'package.json'),
          JSON.stringify({ name: 'chownr', version: '1.1.4', main: 'index.js' }, null, 2),
          'utf8',
        );
        writeFileSync(join(compileChownrDir, 'index.js'), 'module.exports = { legacy: true };\n', 'utf8');
        writeFileSync(
          join(compileTarFsDir, 'package.json'),
          JSON.stringify({ name: 'tar-fs', version: '2.1.4', main: 'index.js' }, null, 2),
          'utf8',
        );
        writeFileSync(join(compileTarFsDir, 'index.js'), 'module.exports = { tarFs: true };\n', 'utf8');
      },
    });

    assert.equal(existsSync(join(payloadDir, 'node_modules', 'chownr', 'package.json')), false);
    assert.equal(existsSync(join(payloadDir, 'node_modules', 'tar-fs', 'package.json')), false);
    assert.equal(
      JSON.parse(readFileSync(join(payloadDir, 'node_modules', 'tar', 'node_modules', 'chownr', 'package.json'), 'utf8')).version,
      '3.0.0',
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('buildCliBinaryArtifactPayload derives bundled workspace packages from apps/cli package.json', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'component-artifacts-cli-bundle-manifest-'));
  try {
    const repoRoot = join(tempRoot, 'repo');
    const payloadDir = join(tempRoot, 'payload');
    const cliDistDir = join(repoRoot, 'apps', 'cli', 'dist');
    const cliScriptsDir = join(repoRoot, 'apps', 'cli', 'scripts');
    const cliRuntimeDir = join(cliScriptsDir, 'runtime');
    const transformersDir = join(repoRoot, 'node_modules', '@huggingface', 'transformers');
    const nodePtyDir = join(repoRoot, 'node_modules', 'node-pty');
    const homebridgePtyDir = join(repoRoot, 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch');

    mkdirSync(cliDistDir, { recursive: true });
    mkdirSync(join(cliScriptsDir, 'shims'), { recursive: true });
    mkdirSync(cliRuntimeDir, { recursive: true });
    mkdirSync(transformersDir, { recursive: true });
    mkdirSync(nodePtyDir, { recursive: true });
    mkdirSync(homebridgePtyDir, { recursive: true });
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'repo', private: true }, null, 2));
    writeCliRuntimePackageFixture(repoRoot, [
      '@happier-dev/agents',
      '@happier-dev/cli-common',
      '@happier-dev/protocol',
      '@happier-dev/release-runtime',
    ]);
    writeFileSync(join(cliDistDir, 'index.mjs'), 'console.log("cli");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'childProcessOptions.cjs'), 'module.exports = { withWindowsHide: (input) => input };\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_version_utils.cjs'), 'module.exports = { getClaudeCliPath: () => "claude", runClaudeCli: () => {} };\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_local_launcher.cjs'), 'require("./claude_version_utils.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_remote_launcher.cjs'), 'require("./claude_version_utils.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'session_hook_forwarder.cjs'), 'console.log("session");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'permission_hook_forwarder.cjs'), 'console.log("permission");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'ripgrep_launcher.cjs'), 'require("./childProcessOptions.cjs");\n', 'utf8');
    writeFileSync(join(cliRuntimeDir, 'loadTransformersFromRuntime.mjs'), 'export const env = {}; export async function pipeline() { return () => null; }\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'shims', 'git'), '#!/bin/sh\nexit 0\n', 'utf8');
    writeFileSync(
      join(transformersDir, 'package.json'),
      JSON.stringify({ name: '@huggingface/transformers', version: '1.0.0', dependencies: {} }, null, 2),
    );
    writeFileSync(join(transformersDir, 'index.js'), 'module.exports = {};\n', 'utf8');
    writeFileSync(
      join(nodePtyDir, 'package.json'),
      JSON.stringify({ name: 'node-pty', version: '1.0.0', dependencies: {} }, null, 2),
      'utf8',
    );
    writeFileSync(join(nodePtyDir, 'index.js'), 'module.exports = { spawn() {} };\n', 'utf8');
    writeFileSync(
      join(homebridgePtyDir, 'package.json'),
      JSON.stringify({ name: '@homebridge/node-pty-prebuilt-multiarch', version: '1.0.0', dependencies: {} }, null, 2),
      'utf8',
    );
    writeFileSync(join(homebridgePtyDir, 'index.js'), 'module.exports = { spawn() {} };\n', 'utf8');

    const artifacts = await import('../dist/componentArtifacts/index.js');
    await artifacts.buildCliBinaryArtifactPayload({
      repoRoot,
      payloadDir,
      target: artifacts.resolveCurrentBinaryTarget({
        availableTargets: artifacts.CLI_BINARY_TARGETS,
        platform: 'linux',
        arch: 'x64',
      }),
      commandProbe: () => true,
      runCommand: () => {
        mkdirSync(cliDistDir, { recursive: true });
        writeFileSync(join(cliDistDir, 'index.mjs'), 'console.log("cli");\n', 'utf8');
      },
      compileBinary: async ({ outfile }) => {
        writeFileSync(outfile, '#!/bin/sh\necho happier\n', 'utf8');
      },
    });

    assert.equal(existsSync(join(payloadDir, 'node_modules', '@happier-dev', 'connection-supervisor')), false);
    assert.equal(existsSync(join(payloadDir, 'node_modules', '@happier-dev', 'protocol')), true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('buildCliBinaryArtifactPayload restores runtime sidecars after compile rewrites the payload dir', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'component-artifacts-cli-sidecars-after-compile-'));
  try {
    const repoRoot = join(tempRoot, 'repo');
    const payloadDir = join(tempRoot, 'payload');
    const cliDistDir = join(repoRoot, 'apps', 'cli', 'dist');
    const cliScriptsDir = join(repoRoot, 'apps', 'cli', 'scripts');
    const cliRuntimeDir = join(cliScriptsDir, 'runtime');
    const transformersDir = join(repoRoot, 'node_modules', '@huggingface', 'transformers');
    const ortDir = join(repoRoot, 'node_modules', 'onnxruntime-node');
    const nodePtyDir = join(repoRoot, 'node_modules', 'node-pty');
    const homebridgePtyDir = join(repoRoot, 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch');

    mkdirSync(cliDistDir, { recursive: true });
    mkdirSync(join(cliScriptsDir, 'shims'), { recursive: true });
    mkdirSync(cliRuntimeDir, { recursive: true });
    mkdirSync(transformersDir, { recursive: true });
    mkdirSync(ortDir, { recursive: true });
    mkdirSync(nodePtyDir, { recursive: true });
    mkdirSync(homebridgePtyDir, { recursive: true });
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'repo', private: true }, null, 2));
    writeCliRuntimePackageFixture(repoRoot);
    writeFileSync(join(cliDistDir, 'index.mjs'), 'console.log("cli");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'childProcessOptions.cjs'), 'module.exports = { withWindowsHide: (input) => input };\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_version_utils.cjs'), 'module.exports = { getClaudeCliPath: () => "claude", runClaudeCli: () => {} };\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_local_launcher.cjs'), 'require("./claude_version_utils.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_remote_launcher.cjs'), 'require("./claude_version_utils.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'session_hook_forwarder.cjs'), 'console.log("session");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'permission_hook_forwarder.cjs'), 'console.log("permission");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'ripgrep_launcher.cjs'), 'require("./childProcessOptions.cjs");\n', 'utf8');
    writeFileSync(join(cliRuntimeDir, 'loadTransformersFromRuntime.mjs'), 'export const env = {}; export async function pipeline() { return () => null; }\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'shims', 'git'), '#!/bin/sh\nexit 0\n', 'utf8');
    writeFileSync(
      join(transformersDir, 'package.json'),
      JSON.stringify({ name: '@huggingface/transformers', version: '1.0.0', dependencies: { 'onnxruntime-node': '1.0.0' } }, null, 2),
    );
    writeFileSync(join(transformersDir, 'index.js'), 'module.exports = {};\n', 'utf8');
    writeFileSync(
      join(ortDir, 'package.json'),
      JSON.stringify({ name: 'onnxruntime-node', version: '1.0.0', dependencies: {} }, null, 2),
    );
    writeFileSync(join(ortDir, 'index.js'), 'module.exports = {};\n', 'utf8');
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

    const artifacts = await import('../dist/componentArtifacts/index.js');
    await artifacts.buildCliBinaryArtifactPayload({
      repoRoot,
      payloadDir,
      target: artifacts.resolveCurrentBinaryTarget({
        availableTargets: artifacts.CLI_BINARY_TARGETS,
        platform: 'linux',
        arch: 'x64',
      }),
      commandProbe: () => true,
      runCommand: () => {
        mkdirSync(cliDistDir, { recursive: true });
        writeFileSync(join(cliDistDir, 'index.mjs'), 'console.log("cli");\n', 'utf8');
      },
      compileBinary: async ({ outfile }) => {
        rmSync(payloadDir, { recursive: true, force: true });
        mkdirSync(payloadDir, { recursive: true });
        writeFileSync(outfile, '#!/bin/sh\necho happier\n', 'utf8');
      },
    });

    assert.equal(readFileSync(join(payloadDir, 'scripts', 'claude_local_launcher.cjs'), 'utf8'), 'require("./claude_version_utils.cjs");\n');
    assert.equal(
      readFileSync(join(payloadDir, 'scripts', 'runtime', 'loadTransformersFromRuntime.mjs'), 'utf8'),
      'export const env = {}; export async function pipeline() { return () => null; }\n',
    );
    assert.equal(readFileSync(join(payloadDir, 'scripts', 'shims', 'git'), 'utf8'), '#!/bin/sh\nexit 0\n');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('buildCliBinaryArtifactPayload stages embeddings runtime packages and externalizes transformers', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'component-artifacts-cli-embeddings-'));
  try {
    const repoRoot = join(tempRoot, 'repo');
    const payloadDir = join(tempRoot, 'payload');
    const cliDistDir = join(repoRoot, 'apps', 'cli', 'dist');
    const cliScriptsDir = join(repoRoot, 'apps', 'cli', 'scripts');
    const cliShimsDir = join(cliScriptsDir, 'shims');
    const cliRuntimeDir = join(cliScriptsDir, 'runtime');
    const transformersDir = join(repoRoot, 'node_modules', '@huggingface', 'transformers');
    const ortDir = join(repoRoot, 'node_modules', 'onnxruntime-node');
    const ortCommonDir = join(repoRoot, 'node_modules', 'onnxruntime-common');
    const nodePtyDir = join(repoRoot, 'node_modules', 'node-pty');
    const homebridgePtyDir = join(repoRoot, 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch');

    mkdirSync(cliDistDir, { recursive: true });
    mkdirSync(cliShimsDir, { recursive: true });
    mkdirSync(cliRuntimeDir, { recursive: true });
    mkdirSync(transformersDir, { recursive: true });
    mkdirSync(ortDir, { recursive: true });
    mkdirSync(ortCommonDir, { recursive: true });
    mkdirSync(nodePtyDir, { recursive: true });
    mkdirSync(homebridgePtyDir, { recursive: true });
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'repo', private: true }, null, 2));
    writeCliRuntimePackageFixture(repoRoot);
    writeFileSync(join(cliDistDir, 'index.mjs'), 'console.log("cli");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'childProcessOptions.cjs'), 'module.exports = { withWindowsHide: (input) => input };\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_version_utils.cjs'), 'module.exports = { getClaudeCliPath: () => "claude", runClaudeCli: () => {} };\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_local_launcher.cjs'), 'require("./claude_version_utils.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_remote_launcher.cjs'), 'require("./claude_version_utils.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'session_hook_forwarder.cjs'), 'console.log("session");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'permission_hook_forwarder.cjs'), 'console.log("permission");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'ripgrep_launcher.cjs'), 'require("./childProcessOptions.cjs");\n', 'utf8');
    writeFileSync(join(cliRuntimeDir, 'loadTransformersFromRuntime.mjs'), 'export const env = {}; export async function pipeline() { return () => null; }\n', 'utf8');
    writeFileSync(join(cliShimsDir, 'git'), '#!/bin/sh\nexit 0\n', 'utf8');
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

    const artifacts = await import('../dist/componentArtifacts/index.js');
    const compileCalls = [];
    await artifacts.buildCliBinaryArtifactPayload({
      repoRoot,
      payloadDir,
      target: artifacts.resolveCurrentBinaryTarget({
        availableTargets: artifacts.CLI_BINARY_TARGETS,
        platform: 'linux',
        arch: 'x64',
      }),
      commandProbe: () => true,
      runCommand: () => {
        mkdirSync(cliDistDir, { recursive: true });
        writeFileSync(join(cliDistDir, 'index.mjs'), 'console.log("cli");\n', 'utf8');
      },
      compileBinary: async (args) => {
        compileCalls.push(args);
        writeFileSync(args.outfile, '#!/bin/sh\necho happier\n', 'utf8');
      },
    });

    assert.deepEqual(compileCalls[0]?.externals, [
      '@huggingface/transformers',
      'node-pty',
      '@homebridge/node-pty-prebuilt-multiarch',
    ]);
    assert.equal(
      readFileSync(join(payloadDir, 'node_modules', '@huggingface', 'transformers', 'package.json'), 'utf8'),
      JSON.stringify({ name: '@huggingface/transformers', version: '1.0.0', dependencies: { 'onnxruntime-node': '1.0.0' } }, null, 2),
    );
    assert.equal(
      readFileSync(join(payloadDir, 'node_modules', '@huggingface', 'transformers', 'node_modules', 'onnxruntime-node', 'package.json'), 'utf8'),
      JSON.stringify({ name: 'onnxruntime-node', version: '1.0.0', dependencies: { 'onnxruntime-common': '1.0.0' } }, null, 2),
    );
    assert.equal(
      readFileSync(
        join(
          payloadDir,
          'node_modules',
          '@huggingface',
          'transformers',
          'node_modules',
          'onnxruntime-node',
          'node_modules',
          'onnxruntime-common',
          'package.json',
        ),
        'utf8',
      ),
      JSON.stringify({ name: 'onnxruntime-common', version: '1.0.0', dependencies: {} }, null, 2),
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('buildServerBinaryArtifactPayload stages the compiled binary and runtime sidecars', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'component-artifacts-server-'));
  try {
    const repoRoot = join(tempRoot, 'repo');
    const payloadDir = join(tempRoot, 'payload');
    const serverSourcesDir = join(repoRoot, 'apps', 'server', 'sources');
    const sqliteClientDir = join(repoRoot, 'apps', 'server', 'generated', 'sqlite-client');
    const mysqlClientDir = join(repoRoot, 'apps', 'server', 'generated', 'mysql-client');
    const sqliteMigrationsDir = join(repoRoot, 'apps', 'server', 'prisma', 'sqlite', 'migrations');
    const postgresClientDir = join(repoRoot, 'node_modules', '.prisma', 'client');
    const prismaClientPackageDir = join(repoRoot, 'node_modules', '@prisma', 'client');

    mkdirSync(serverSourcesDir, { recursive: true });
    mkdirSync(sqliteClientDir, { recursive: true });
    mkdirSync(mysqlClientDir, { recursive: true });
    mkdirSync(sqliteMigrationsDir, { recursive: true });
    mkdirSync(postgresClientDir, { recursive: true });
    mkdirSync(prismaClientPackageDir, { recursive: true });

    writeFileSync(join(serverSourcesDir, 'main.light.ts'), 'export {};\n', 'utf8');
    writeFileSync(join(sqliteClientDir, 'schema.prisma'), '// sqlite\n', 'utf8');
    writeFileSync(join(mysqlClientDir, 'schema.prisma'), '// mysql\n', 'utf8');
    writeFileSync(join(sqliteMigrationsDir, 'migration.sql'), '-- sql\n', 'utf8');
    writeFileSync(join(postgresClientDir, 'query_engine.so'), 'binary\n', 'utf8');
    writeFileSync(join(prismaClientPackageDir, 'index.js'), 'module.exports = { PrismaClient: class PrismaClient {} };\n', 'utf8');

    const artifacts = await import('../dist/componentArtifacts/index.js');
    const compileCalls = [];
    const runCalls = [];
    const result = await artifacts.buildServerBinaryArtifactPayload({
      repoRoot,
      payloadDir,
      entrypoint: join(serverSourcesDir, 'main.light.ts'),
      buildDbProviders: 'all',
      target: artifacts.resolveCurrentBinaryTarget({
        availableTargets: artifacts.SERVER_BINARY_TARGETS,
        platform: 'linux',
        arch: 'x64',
      }),
      commandProbe: () => true,
      runCommand: (cmd, args) => {
        runCalls.push({ cmd, args });
      },
      compileBinary: async ({ outfile }) => {
        compileCalls.push(outfile);
        writeFileSync(outfile, '#!/bin/sh\necho happier-server\n', 'utf8');
      },
    });

    assert.equal(result.executableName, 'happier-server');
    assert.equal(result.entrypoint, 'happier-server');
    assert.equal(compileCalls.length, 1);
    assert.deepEqual(runCalls, [{ cmd: 'yarn', args: ['--cwd', 'apps/server', '-s', 'generate:providers'] }]);
    assert.equal(readFileSync(join(payloadDir, 'happier-server'), 'utf8'), '#!/bin/sh\necho happier-server\n');
    assert.equal(readFileSync(join(payloadDir, 'generated', 'sqlite-client', 'schema.prisma'), 'utf8'), '// sqlite\n');
    assert.equal(readFileSync(join(payloadDir, 'generated', 'mysql-client', 'schema.prisma'), 'utf8'), '// mysql\n');
    assert.equal(readFileSync(join(payloadDir, 'prisma', 'sqlite', 'migrations', 'migration.sql'), 'utf8'), '-- sql\n');
    assert.equal(readFileSync(join(payloadDir, 'node_modules', '.prisma', 'client', 'query_engine.so'), 'utf8'), 'binary\n');
    assert.equal(
      readFileSync(join(payloadDir, 'node_modules', '@prisma', 'client', 'index.js'), 'utf8'),
      'module.exports = { PrismaClient: class PrismaClient {} };\n'
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('buildServerBinaryArtifactPayload retries transient ENOENT failures while copying sidecars', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'component-artifacts-server-retry-'));
  try {
    const repoRoot = join(tempRoot, 'repo');
    const payloadDir = join(tempRoot, 'payload');
    const serverSourcesDir = join(repoRoot, 'apps', 'server', 'sources');
    const sqliteClientDir = join(repoRoot, 'apps', 'server', 'generated', 'sqlite-client');
    const sqliteMigrationsDir = join(repoRoot, 'apps', 'server', 'prisma', 'sqlite', 'migrations');
    const postgresClientDir = join(repoRoot, 'node_modules', '.prisma', 'client');
    const prismaClientPackageDir = join(repoRoot, 'node_modules', '@prisma', 'client');

    mkdirSync(serverSourcesDir, { recursive: true });
    mkdirSync(sqliteClientDir, { recursive: true });
    mkdirSync(sqliteMigrationsDir, { recursive: true });
    mkdirSync(postgresClientDir, { recursive: true });
    mkdirSync(prismaClientPackageDir, { recursive: true });

    writeFileSync(join(serverSourcesDir, 'main.light.ts'), 'export {};\n', 'utf8');
    writeFileSync(join(sqliteClientDir, 'schema.prisma'), '// sqlite\n', 'utf8');
    writeFileSync(join(sqliteMigrationsDir, 'migration.sql'), '-- sql\n', 'utf8');
    writeFileSync(join(postgresClientDir, 'client.d.ts'), 'export {};\n', 'utf8');
    writeFileSync(join(prismaClientPackageDir, 'index.js'), 'module.exports = {};\n', 'utf8');

    const artifacts = await import('../dist/componentArtifacts/index.js');
    let copyAttempts = 0;
    await artifacts.buildServerBinaryArtifactPayload({
      repoRoot,
      payloadDir,
      buildDbProviders: 'sqlite',
      target: artifacts.resolveCurrentBinaryTarget({
        availableTargets: artifacts.SERVER_BINARY_TARGETS,
        platform: 'linux',
        arch: 'x64',
      }),
      commandProbe: () => true,
      runCommand: () => {},
      compileBinary: async ({ outfile }) => {
        writeFileSync(outfile, '#!/bin/sh\necho happier-server\n', 'utf8');
      },
      copyPath: async ({ sourcePath, destPath, recursive }, fallbackCopyPath) => {
        copyAttempts += 1;
        if (copyAttempts === 1) {
          const error = new Error(`ENOENT: no such file or directory, lstat '${sourcePath}'`);
          error.code = 'ENOENT';
          throw error;
        }
        return await fallbackCopyPath({ sourcePath, destPath, recursive });
      },
    });

    assert.ok(copyAttempts >= 2);
    assert.equal(readFileSync(join(payloadDir, 'node_modules', '.prisma', 'client', 'client.d.ts'), 'utf8'), 'export {};\n');
    assert.equal(readFileSync(join(payloadDir, 'node_modules', '@prisma', 'client', 'index.js'), 'utf8'), 'module.exports = {};\n');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
