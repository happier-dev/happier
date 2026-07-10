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

function writeCliToolUnpackFixture(repoRoot) {
  const cliScriptsDir = join(repoRoot, 'apps', 'cli', 'scripts');
  const cliToolsArchivesDir = join(repoRoot, 'apps', 'cli', 'tools', 'archives');
  mkdirSync(cliScriptsDir, { recursive: true });
  mkdirSync(cliToolsArchivesDir, { recursive: true });
  writeFileSync(join(cliToolsArchivesDir, 'checksums.sha256'), '', 'utf8');
  writeFileSync(join(cliToolsArchivesDir, 'zellij-no-web-x86_64-unknown-linux-musl.tar.gz'), 'fake zellij archive\n', 'utf8');
  writeFileSync(join(cliToolsArchivesDir, 'zellij-LICENSE'), 'fake zellij license\n', 'utf8');
  writeFileSync(join(cliScriptsDir, 'unpack-tools.cjs'), `
const fs = require('fs');
const path = require('path');

async function unpackTools(options = {}) {
  const platformDir = options.platformDir || 'unknown';
  const toolsDir = options.toolsDir || path.resolve(__dirname, '..', 'tools');
  const unpackedPath = path.join(toolsDir, 'unpacked');
  fs.mkdirSync(unpackedPath, { recursive: true });
  const binaryName = platformDir === 'x64-win32' ? 'zellij.exe' : 'zellij';
  fs.writeFileSync(path.join(unpackedPath, binaryName), 'zellij 0.44.3 for ' + platformDir + '\\n');
  fs.writeFileSync(path.join(unpackedPath, '.happier-tools-manifest.json'), JSON.stringify({
    platformDir,
    tools: { zellij: { version: '0.44.3' } },
  }, null, 2) + '\\n');
  return { success: true, alreadyUnpacked: false };
}

module.exports = { unpackTools };
`, 'utf8');
}

function writeCliArtifactFixtures(repoRoot) {
  const cliDir = join(repoRoot, 'apps', 'cli');
  const cliScriptsDir = join(repoRoot, 'apps', 'cli', 'scripts');
  const cliShimsDir = join(cliScriptsDir, 'shims');
  const cliRuntimeDir = join(cliScriptsDir, 'runtime');
  const transformersDir = join(repoRoot, 'node_modules', '@huggingface', 'transformers');
  const ortDir = join(repoRoot, 'node_modules', 'onnxruntime-node');
  const ortCommonDir = join(repoRoot, 'node_modules', 'onnxruntime-common');
  const ffmpegStaticDir = join(repoRoot, 'node_modules', 'ffmpeg-static');
  const sherpaOnnxNodeDir = join(repoRoot, 'node_modules', 'sherpa-onnx-node');
  const sherpaOnnxLinuxX64Dir = join(repoRoot, 'node_modules', 'sherpa-onnx-linux-x64');
  const nodePtyDir = join(repoRoot, 'node_modules', 'node-pty');
  const homebridgePtyDir = join(repoRoot, 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch');

  mkdirSync(cliDir, { recursive: true });
  mkdirSync(cliShimsDir, { recursive: true });
  mkdirSync(cliRuntimeDir, { recursive: true });
  mkdirSync(transformersDir, { recursive: true });
  mkdirSync(ortDir, { recursive: true });
  mkdirSync(ortCommonDir, { recursive: true });
  mkdirSync(ffmpegStaticDir, { recursive: true });
  mkdirSync(sherpaOnnxNodeDir, { recursive: true });
  mkdirSync(sherpaOnnxLinuxX64Dir, { recursive: true });
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
          'ffmpeg-static': '1.0.0',
          'sherpa-onnx-node': '1.0.0',
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
  writeCliToolUnpackFixture(repoRoot);
  writeWorkspacePackageFixture({ repoRoot, packageName: '@happier-dev/agents', relativeDir: ['packages', 'agents'] });
  writeWorkspacePackageFixture({ repoRoot, packageName: '@happier-dev/cli-common', relativeDir: ['packages', 'cli-common'] });
  writeWorkspacePackageFixture({ repoRoot, packageName: '@happier-dev/connection-supervisor', relativeDir: ['packages', 'connection-supervisor'] });
  writeWorkspacePackageFixture({ repoRoot, packageName: '@happier-dev/protocol', relativeDir: ['packages', 'protocol'] });
  writeWorkspacePackageFixture({ repoRoot, packageName: '@happier-dev/release-runtime', relativeDir: ['packages', 'release-runtime'] });
  mkdirSync(join(cliDir, 'dist', 'daemon', 'voiceInference', 'runtime'), { recursive: true });
  writeFileSync(
    join(cliDir, 'dist', 'daemon', 'voiceInference', 'runtime', 'packagedVoiceInferenceRuntime.mjs'),
    'export const voiceInferenceRuntimeEngine = { warmModel: async () => {}, synthesizeTts: async () => ({ bytes: Buffer.from("wav"), output: { codec: "wav", mimeType: "audio/wav" }, name: "runtime.wav" }), transcribeAudio: async () => ({ text: "runtime", language: "en" }) };\n',
    'utf8',
  );
  writeFileSync(join(cliScriptsDir, 'childProcessOptions.cjs'), 'module.exports = { withWindowsHide: (input) => input };\n', 'utf8');
  writeFileSync(join(cliScriptsDir, 'claude_version_utils.cjs'), 'module.exports = { getClaudeCliPath: () => "claude", runClaudeCli: () => {} };\n', 'utf8');
  writeFileSync(join(cliScriptsDir, 'claude_local_launcher.cjs'), 'require("./claude_version_utils.cjs");\n', 'utf8');
  writeFileSync(join(cliScriptsDir, 'claude_remote_launcher.cjs'), 'require("./claude_version_utils.cjs");\n', 'utf8');
  writeFileSync(join(cliScriptsDir, 'session_hook_forwarder.cjs'), 'console.log("session");\n', 'utf8');
  writeFileSync(join(cliScriptsDir, 'permission_hook_forwarder.cjs'), 'console.log("permission");\n', 'utf8');
  writeFileSync(join(cliScriptsDir, 'ripgrep_launcher.cjs'), 'require("./childProcessOptions.cjs");\n', 'utf8');
  writeFileSync(join(cliScriptsDir, 'statusline_forwarder.cjs'), 'console.log("statusline");\n', 'utf8');
  writeFileSync(join(cliScriptsDir, 'terminal_launch_spec_runner.cjs'), 'console.log("terminal launch spec");\n', 'utf8');
  writeFileSync(join(cliScriptsDir, 'node_pty_relay.cjs'), 'console.log("node pty relay");\n', 'utf8');
  writeFileSync(join(cliRuntimeDir, 'loadTransformersFromRuntime.mjs'), 'export const env = {}; export async function pipeline() { return () => null; }\n', 'utf8');
  writeFileSync(
    join(cliRuntimeDir, 'loadVoiceInferenceRuntime.mjs'),
    [
      "try {",
      "  await import('sherpa-onnx-node');",
      "} catch (error) {",
      "  const runtimeError = new Error(",
      "    error instanceof Error && error.message.trim().length > 0",
      "      ? `voice_inference_runtime_unavailable:${error.message}`",
      "      : 'voice_inference_runtime_unavailable',",
      '  );',
      "  runtimeError.code = 'runtime_unavailable';",
      '  throw runtimeError;',
      '}',
      '',
      'export { voiceInferenceRuntimeEngine } from "../../package-dist/daemon/voiceInference/runtime/packagedVoiceInferenceRuntime.mjs";',
      '',
    ].join('\n'),
    'utf8',
  );
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
    join(ffmpegStaticDir, 'package.json'),
    JSON.stringify({ name: 'ffmpeg-static', version: '1.0.0', main: './index.js', dependencies: {} }, null, 2),
  );
  writeFileSync(join(ffmpegStaticDir, 'index.js'), 'module.exports = "/runtime/ffmpeg";\n', 'utf8');
  writeFileSync(join(ffmpegStaticDir, 'ffmpeg'), '#!/bin/sh\nexit 0\n', 'utf8');
  writeFileSync(
    join(sherpaOnnxNodeDir, 'package.json'),
    JSON.stringify({ name: 'sherpa-onnx-node', version: '1.0.0', optionalDependencies: { 'sherpa-onnx-linux-x64': '1.0.0' } }, null, 2),
  );
  writeFileSync(join(sherpaOnnxNodeDir, 'sherpa-onnx.js'), 'module.exports = { version: "1.0.0" };\n', 'utf8');
  writeFileSync(
    join(sherpaOnnxLinuxX64Dir, 'package.json'),
    JSON.stringify({ name: 'sherpa-onnx-linux-x64', version: '1.0.0', dependencies: {} }, null, 2),
  );
  writeFileSync(join(sherpaOnnxLinuxX64Dir, 'index.js'), 'module.exports = { platformBinary: true };\n', 'utf8');
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

function resolveHostCliBinaryTarget(artifacts) {
  return artifacts.resolveCurrentBinaryTarget({
    availableTargets: artifacts.CLI_BINARY_TARGETS,
  });
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
    const target = resolveHostCliBinaryTarget(artifacts);
    const executableName = artifacts.resolveExecutableName({ baseName: 'happier', target });

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
    assert.equal(existsSync(join(payloadDirA, executableName)), true);
    assert.equal(existsSync(join(payloadDirB, executableName)), true);
    assert.equal(existsSync(join(payloadDirA, 'scripts', 'runtime', 'loadVoiceInferenceRuntime.mjs')), true);
    assert.equal(existsSync(join(payloadDirB, 'node_modules', 'ffmpeg-static')), false);
    assert.equal(existsSync(join(payloadDirB, 'node_modules', 'sherpa-onnx-node')), false);
    assert.equal(existsSync(join(payloadDirB, 'tools', 'archives', `voice-inference-runtime-${target.os}-${target.arch}.tar.gz`)), true);
    assert.equal(existsSync(join(payloadDirA, 'tools', 'unpacked', target.os === 'windows' ? 'zellij.exe' : 'zellij')), true);
    assert.equal(existsSync(join(payloadDirB, 'tools', 'unpacked', target.os === 'windows' ? 'zellij.exe' : 'zellij')), true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
