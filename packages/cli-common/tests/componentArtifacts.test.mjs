import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ACTUAL_VOICE_RUNTIME_LOADER_SOURCE = readFileSync(
  new URL('../../../apps/cli/scripts/runtime/loadVoiceInferenceRuntime.mjs', import.meta.url),
  'utf8',
);

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

function writeWorkspaceBuildOwnerFixture(repoRoot) {
  const scriptsDir = join(repoRoot, 'scripts', 'workspaces');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(
    join(scriptsDir, 'ensureWorkspacePackagesBuilt.mjs'),
    `export async function ensureWorkspacePackagesBuiltByName(_repoRoot, packageNames) {
  return { ok: true, built: [], skipped: [...packageNames] };
}
`,
    'utf8',
  );
}

function writeCliToolUnpackFixture(repoRoot) {
  const cliDir = join(repoRoot, 'apps', 'cli');
  const cliScriptsDir = join(cliDir, 'scripts');
  const cliToolsArchivesDir = join(cliDir, 'tools', 'archives');
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
  fs.writeFileSync(path.join(unpackedPath, 'zellij-LICENSE'), 'fake zellij license\\n');
  fs.writeFileSync(path.join(unpackedPath, '.happier-tools-manifest.json'), JSON.stringify({
    platformDir,
    tools: { zellij: { version: '0.44.3' } },
  }, null, 2) + '\\n');
  return { success: true, alreadyUnpacked: false };
}

module.exports = { unpackTools };
`, 'utf8');
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
  const cliScriptsDir = join(cliDir, 'scripts');
  mkdirSync(cliDir, { recursive: true });
  mkdirSync(cliScriptsDir, { recursive: true });
  writeWorkspaceBuildOwnerFixture(repoRoot);
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
  writeFileSync(join(cliScriptsDir, 'ripgrep_runtime_paths.cjs'), 'module.exports = { resolvePackagedRipgrepBinaryPath: () => undefined };\n', 'utf8');
  writeFileSync(join(cliScriptsDir, 'statusline_forwarder.cjs'), 'console.log("statusline");\n', 'utf8');
  writeFileSync(join(cliScriptsDir, 'terminal_launch_spec_runner.cjs'), 'console.log("terminal launch spec");\n', 'utf8');
  writeFileSync(join(cliScriptsDir, 'node_pty_relay.cjs'), 'console.log("node pty relay");\n', 'utf8');
  writeCliToolUnpackFixture(repoRoot);
}

function writeCliProxyApiManagedRuntimeFixture(repoRoot, target) {
  const executablePath = join(
    repoRoot,
    '.test-fixtures',
    `happier-cliproxyapi-managed${target.exeExt}`,
  );
  mkdirSync(join(executablePath, '..'), { recursive: true });
  writeFileSync(executablePath, 'signed managed runtime fixture\n', 'utf8');
  const licenseDir = join(
    repoRoot,
    'packages',
    'plugins',
    'cliproxyapi',
    'managed-runtime',
    'licenses',
  );
  mkdirSync(licenseDir, { recursive: true });
  writeFileSync(join(licenseDir, 'CLIProxyAPI-LICENSE'), 'CLIProxyAPI license fixture\n', 'utf8');
  writeFileSync(join(licenseDir, 'THIRD-PARTY-NOTICES'), 'CLIProxyAPI third-party notices fixture\n', 'utf8');
  return executablePath;
}

function prismaEngineFileNameForFixture({ platform = 'linux', arch = 'x64' } = {}) {
  const key = `${platform}-${arch}`;
  switch (key) {
    case 'linux-x64':
      return 'libquery_engine-debian-openssl-3.0.x.so.node';
    case 'linux-arm64':
      return 'libquery_engine-linux-arm64-openssl-3.0.x.so.node';
    case 'darwin-x64':
      return 'libquery_engine-darwin.dylib.node';
    case 'darwin-arm64':
      return 'libquery_engine-darwin-arm64.dylib.node';
    case 'windows-x64':
      return 'query_engine-windows.dll.node';
    default:
      throw new Error(`unsupported fixture platform: ${key}`);
  }
}

function writeServerPrismaEngineFixtures({
  sqliteClientDir,
  mysqlClientDir,
  postgresClientDir,
  providers = ['sqlite'],
  platform = 'linux',
  arch = 'x64',
}) {
  const engineFileName = prismaEngineFileNameForFixture({ platform, arch });
  if (providers.includes('sqlite') && sqliteClientDir) {
    writeFileSync(join(sqliteClientDir, engineFileName), 'sqlite-engine\n', 'utf8');
  }
  if (providers.includes('mysql') && mysqlClientDir) {
    writeFileSync(join(mysqlClientDir, engineFileName), 'mysql-engine\n', 'utf8');
  }
  if (postgresClientDir) {
    writeFileSync(join(postgresClientDir, engineFileName), 'postgres-engine\n', 'utf8');
  }
}

function writePackagedVoiceRuntimeFixture({ cliDistDir, cliRuntimeDir }) {
  mkdirSync(join(cliDistDir, 'daemon', 'voiceInference', 'runtime'), { recursive: true });
  writeFileSync(
    join(cliDistDir, 'daemon', 'voiceInference', 'runtime', 'packagedVoiceInferenceRuntime.mjs'),
    'export const voiceInferenceRuntimeEngine = { warmModel: async () => {}, synthesizeTts: async () => ({ bytes: Buffer.from("wav"), output: { codec: "wav", mimeType: "audio/wav" }, name: "runtime.wav" }), transcribeAudio: async () => ({ text: "runtime", language: "en" }) };\n',
    'utf8',
  );
  writeFileSync(
    join(cliRuntimeDir, 'loadVoiceInferenceRuntime.mjs'),
    ACTUAL_VOICE_RUNTIME_LOADER_SOURCE,
    'utf8',
  );
}

function writeSherpaRuntimePackageFixture(repoRoot) {
  const sherpaOnnxNodeDir = join(repoRoot, 'node_modules', 'sherpa-onnx-node');
  const sherpaOnnxLinuxX64Dir = join(repoRoot, 'node_modules', 'sherpa-onnx-linux-x64');
  mkdirSync(sherpaOnnxNodeDir, { recursive: true });
  mkdirSync(sherpaOnnxLinuxX64Dir, { recursive: true });
  writeFileSync(
    join(sherpaOnnxNodeDir, 'package.json'),
    JSON.stringify({ name: 'sherpa-onnx-node', version: '1.0.0', optionalDependencies: { 'sherpa-onnx-linux-x64': '1.0.0' } }, null, 2),
    'utf8',
  );
  writeFileSync(join(sherpaOnnxNodeDir, 'sherpa-onnx.js'), 'module.exports = { version: "1.0.0" };\n', 'utf8');
  writeFileSync(
    join(sherpaOnnxLinuxX64Dir, 'package.json'),
    JSON.stringify({ name: 'sherpa-onnx-linux-x64', version: '1.0.0', dependencies: {} }, null, 2),
    'utf8',
  );
  writeFileSync(join(sherpaOnnxLinuxX64Dir, 'index.js'), 'module.exports = { platformBinary: true };\n', 'utf8');
}

function writeFfmpegStaticPackageFixture(repoRoot) {
  const ffmpegStaticDir = join(repoRoot, 'node_modules', 'ffmpeg-static');
  mkdirSync(ffmpegStaticDir, { recursive: true });
  writeFileSync(
    join(ffmpegStaticDir, 'package.json'),
    JSON.stringify({ name: 'ffmpeg-static', version: '1.0.0', main: './index.js', dependencies: {} }, null, 2),
    'utf8',
  );
  writeFileSync(join(ffmpegStaticDir, 'index.js'), 'module.exports = "/runtime/ffmpeg";\n', 'utf8');
  writeFileSync(join(ffmpegStaticDir, 'ffmpeg'), '#!/bin/sh\nexit 0\n', 'utf8');
}

function resolveHostCliBinaryTarget(artifacts) {
  return artifacts.resolveCurrentBinaryTarget({
    availableTargets: artifacts.CLI_BINARY_TARGETS,
  });
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

test('resolvePrismaSchemaEngineTarget covers every released server binary target', async () => {
  const artifacts = await import('../dist/componentArtifacts/index.js');
  assert.deepEqual(
    artifacts.SERVER_BINARY_TARGETS.map((target) => [
      `${target.os}-${target.arch}`,
      artifacts.resolvePrismaSchemaEngineTarget(target).binaryTarget,
      artifacts.resolveExecutableName({ baseName: 'happier-server-migrate', target }),
    ]),
    [
      ['linux-x64', 'debian-openssl-3.0.x', 'happier-server-migrate'],
      ['linux-arm64', 'linux-arm64-openssl-3.0.x', 'happier-server-migrate'],
      ['darwin-x64', 'darwin', 'happier-server-migrate'],
      ['darwin-arm64', 'darwin-arm64', 'happier-server-migrate'],
      ['windows-x64', 'windows', 'happier-server-migrate.exe'],
    ],
  );
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

test('resolveRequestedServerDbProviders accepts canonical pipe-delimited provider values', async () => {
  const artifacts = await import('../dist/componentArtifacts/index.js');

  assert.deepEqual(
    artifacts.resolveRequestedServerDbProviders('pglite|sqlite|mysql'),
    ['sqlite', 'mysql'],
  );
  assert.deepEqual(
    artifacts.resolveRequestedServerDbProviders('postgres|mysql'),
    ['mysql'],
  );
  assert.throws(
    () => artifacts.resolveRequestedServerDbProviders('postgres|unknown'),
    /unsupported HAPPIER_BUILD_DB_PROVIDERS token/i,
  );
});

test('buildCliBinaryArtifactPayload compiles and finalizes a self-contained runtime payload', async () => {
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
    const sherpaOnnxNodeDir = join(repoRoot, 'node_modules', 'sherpa-onnx-node');
    const sherpaOnnxLinuxX64Dir = join(repoRoot, 'node_modules', 'sherpa-onnx-linux-x64');
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
    writePackagedVoiceRuntimeFixture({ cliDistDir, cliRuntimeDir });
    writeFileSync(join(cliScriptsDir, 'childProcessOptions.cjs'), 'module.exports = { withWindowsHide: (input) => input };\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_version_utils.cjs'), 'module.exports = { getClaudeCliPath: () => "claude", runClaudeCli: () => {} };\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_local_launcher.cjs'), 'require("./claude_version_utils.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_remote_launcher.cjs'), 'require("./claude_version_utils.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'session_hook_forwarder.cjs'), 'console.log("session");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'permission_hook_forwarder.cjs'), 'console.log("permission");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'ripgrep_launcher.cjs'), 'require("./childProcessOptions.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'terminal_launch_spec_runner.cjs'), 'console.log("terminal launch spec");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'node_pty_relay.cjs'), 'console.log("node pty relay");\n', 'utf8');
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
    writeSherpaRuntimePackageFixture(repoRoot);
    writeFfmpegStaticPackageFixture(repoRoot);
    writeFileSync(
      join(nodePtyDir, 'package.json'),
      JSON.stringify({ name: 'node-pty', version: '1.0.0', dependencies: {} }, null, 2),
    );
    writeFileSync(join(nodePtyDir, 'index.js'), 'module.exports = { spawn() {} };\n', 'utf8');
    if (process.platform !== 'win32') {
      const containedBinTarget = join(nodePtyDir, 'contained-cli-bin-target.js');
      const nestedBinDir = join(nodePtyDir, 'node_modules', '.bin');
      writeFileSync(containedBinTarget, 'console.log("contained cli bin target");\n', 'utf8');
      mkdirSync(nestedBinDir, { recursive: true });
      symlinkSync(containedBinTarget, join(nestedBinDir, 'contained-cli-bin'));
    }
    writeFileSync(
      join(homebridgePtyDir, 'package.json'),
      JSON.stringify({ name: '@homebridge/node-pty-prebuilt-multiarch', version: '1.0.0', dependencies: {} }, null, 2),
    );
    writeFileSync(join(homebridgePtyDir, 'index.js'), 'module.exports = { spawn() {} };\n', 'utf8');

    const artifacts = await import('../dist/componentArtifacts/index.js');
    const compileCalls = [];
    const runCalls = [];
    const target = resolveHostCliBinaryTarget(artifacts);
    const result = await artifacts.buildCliBinaryArtifactPayload({
      repoRoot,
      payloadDir,
      target,
      cliProxyApiManagedRuntimeExecutablePath: writeCliProxyApiManagedRuntimeFixture(repoRoot, target),
      commandProbe: () => true,
      runCommand: (cmd, args) => {
        runCalls.push({ cmd, args });
        mkdirSync(cliDistDir, { recursive: true });
        writeFileSync(join(cliDistDir, 'index.mjs'), 'console.log("cli");\n', 'utf8');
      },
      compileBinary: async ({ outfile, externals }) => {
        compileCalls.push({ outfile, externals });
        writeFileSync(outfile, '#!/bin/sh\necho happier\n', 'utf8');
        if (process.platform !== 'win32') {
          const runtimeAssetsDir = join(payloadDir, 'runtime-assets');
          const runtimeLinksDir = join(payloadDir, 'runtime-links');
          mkdirSync(runtimeAssetsDir, { recursive: true });
          mkdirSync(runtimeLinksDir, { recursive: true });
          writeFileSync(join(runtimeAssetsDir, 'inside.txt'), 'inside\n', 'utf8');
          symlinkSync(join('..', 'runtime-assets', 'inside.txt'), join(runtimeLinksDir, 'internal-link'));
        }
      },
    });

    assert.equal(result.executableName, artifacts.resolveExecutableName({ baseName: 'happier', target }));
    assert.equal(result.entrypoint, artifacts.resolveExecutableName({ baseName: 'happier', target }));
    assert.deepEqual(runCalls, []);
    assert.equal(compileCalls.length, 1);
    assert.deepEqual(compileCalls[0].externals.sort(), [
      '@homebridge/node-pty-prebuilt-multiarch',
      'ffmpeg-static',
      '@huggingface/transformers',
      'node-pty',
      'pino',
      'sherpa-onnx-node',
      'thread-stream',
    ].sort());
    assert.equal(readFileSync(join(payloadDir, result.executableName), 'utf8'), '#!/bin/sh\necho happier\n');
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
    assert.equal(existsSync(join(payloadDir, 'node_modules', 'ffmpeg-static')), false);
    assert.equal(existsSync(join(payloadDir, 'node_modules', '@huggingface', 'transformers')), false);
    assert.equal(existsSync(join(payloadDir, 'node_modules', 'sherpa-onnx-node')), false);
    assert.equal(
      existsSync(join(payloadDir, 'tools', 'archives', `voice-inference-runtime-${target.os}-${target.arch}.tar.gz`)),
      true,
    );
    const zellijBinaryName = target.os === 'windows' ? 'zellij.exe' : 'zellij';
    assert.equal(
      readFileSync(join(payloadDir, 'tools', 'unpacked', zellijBinaryName), 'utf8'),
      `zellij 0.44.3 for ${target.arch}-${target.os === 'windows' ? 'win32' : target.os}\n`,
    );
    assert.equal(
      readFileSync(join(payloadDir, 'tools', 'unpacked', `happier-cliproxyapi-managed${target.exeExt}`), 'utf8'),
      'signed managed runtime fixture\n',
    );
    assert.equal(
      readFileSync(join(payloadDir, 'tools', 'unpacked', 'CLIProxyAPI-LICENSE'), 'utf8'),
      'CLIProxyAPI license fixture\n',
    );
    assert.equal(
      readFileSync(join(payloadDir, 'tools', 'unpacked', 'CLIProxyAPI-THIRD-PARTY-NOTICES'), 'utf8'),
      'CLIProxyAPI third-party notices fixture\n',
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(payloadDir, 'tools', 'unpacked', '.happier-tools-manifest.json'), 'utf8')),
      {
        platformDir: `${target.arch}-${target.os === 'windows' ? 'win32' : target.os}`,
        tools: { zellij: { version: '0.44.3' } },
      },
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
    assert.equal(
      readFileSync(join(payloadDir, 'scripts', 'runtime', 'loadVoiceInferenceRuntime.mjs'), 'utf8'),
      ACTUAL_VOICE_RUNTIME_LOADER_SOURCE,
    );
    assert.equal(
      readFileSync(join(payloadDir, 'package-dist', 'daemon', 'voiceInference', 'runtime', 'packagedVoiceInferenceRuntime.mjs'), 'utf8'),
      'export const voiceInferenceRuntimeEngine = { warmModel: async () => {}, synthesizeTts: async () => ({ bytes: Buffer.from("wav"), output: { codec: "wav", mimeType: "audio/wav" }, name: "runtime.wav" }), transcribeAudio: async () => ({ text: "runtime", language: "en" }) };\n',
    );
    assert.equal(readFileSync(join(payloadDir, 'scripts', 'shims', 'git'), 'utf8'), '#!/bin/sh\nexit 0\n');
    if (process.platform !== 'win32') {
      assert.equal(readFileSync(join(payloadDir, 'runtime-links', 'internal-link'), 'utf8'), 'inside\n');
      assert.equal(
        existsSync(join(payloadDir, 'node_modules', 'node-pty', 'node_modules', '.bin')),
        false,
        'the completed CLI payload must not retain nested package-manager shims',
      );
      const externalRuntimeTarget = join(tempRoot, 'external-cli-runtime-target.js');
      writeFileSync(externalRuntimeTarget, 'console.log("external cli runtime target");\n', 'utf8');
      for (const [linkName, linkTarget] of [
        ['absolute-link', externalRuntimeTarget],
        ['escaping-relative-link', join('..', '..', 'external-cli-runtime-target.js')],
      ]) {
        await assert.rejects(
          artifacts.buildCliBinaryArtifactPayload({
            repoRoot,
            payloadDir,
            target,
            cliProxyApiManagedRuntimeExecutablePath: writeCliProxyApiManagedRuntimeFixture(repoRoot, target),
            commandProbe: () => true,
            runCommand: () => {},
            compileBinary: async ({ outfile }) => {
              writeFileSync(outfile, '#!/bin/sh\necho happier\n', 'utf8');
              const runtimeLinksDir = join(payloadDir, 'runtime-links');
              mkdirSync(runtimeLinksDir, { recursive: true });
              symlinkSync(linkTarget, join(runtimeLinksDir, linkName));
            },
          }),
          /runtime payload symlink escapes the artifact/i,
        );
      }
    }
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
            'ffmpeg-static': '1.0.0',
            'sherpa-onnx-node': '1.0.0',
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
    writePackagedVoiceRuntimeFixture({ cliDistDir, cliRuntimeDir });
    writeFileSync(join(cliScriptsDir, 'childProcessOptions.cjs'), 'module.exports = { withWindowsHide: (input) => input };\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_version_utils.cjs'), 'module.exports = { getClaudeCliPath: () => "claude", runClaudeCli: () => {} };\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_local_launcher.cjs'), 'require("./claude_version_utils.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_remote_launcher.cjs'), 'require("./claude_version_utils.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'session_hook_forwarder.cjs'), 'console.log("session");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'permission_hook_forwarder.cjs'), 'console.log("permission");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'ripgrep_launcher.cjs'), 'require("./childProcessOptions.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'terminal_launch_spec_runner.cjs'), 'console.log("terminal launch spec");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'node_pty_relay.cjs'), 'console.log("node pty relay");\n', 'utf8');
    writeFileSync(join(cliRuntimeDir, 'loadTransformersFromRuntime.mjs'), 'export const env = {}; export async function pipeline() { return () => null; }\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'shims', 'git'), '#!/bin/sh\nexit 0\n', 'utf8');
    writeSherpaRuntimePackageFixture(repoRoot);
    writeFfmpegStaticPackageFixture(repoRoot);
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
      target: resolveHostCliBinaryTarget(artifacts),
      cliProxyApiManagedRuntimeExecutablePath: writeCliProxyApiManagedRuntimeFixture(repoRoot, resolveHostCliBinaryTarget(artifacts)),
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

test('buildCliBinaryArtifactPayload snapshots CLI dist before compile/copy so later live-dist churn does not break packaging', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'component-artifacts-cli-dist-snapshot-'));
  try {
    const repoRoot = join(tempRoot, 'repo');
    const payloadDir = join(tempRoot, 'payload');
    const cliDistDir = join(repoRoot, 'apps', 'cli', 'dist');
    const cliScriptsDir = join(repoRoot, 'apps', 'cli', 'scripts');
    const cliRuntimeDir = join(cliScriptsDir, 'runtime');
    const cliShimsDir = join(cliScriptsDir, 'shims');
    const transformersDir = join(repoRoot, 'node_modules', '@huggingface', 'transformers');
    const ortDir = join(repoRoot, 'node_modules', 'onnxruntime-node');
    const ortCommonDir = join(repoRoot, 'node_modules', 'onnxruntime-common');
    const nodePtyDir = join(repoRoot, 'node_modules', 'node-pty');
    const homebridgePtyDir = join(repoRoot, 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch');

    mkdirSync(cliScriptsDir, { recursive: true });
    mkdirSync(cliRuntimeDir, { recursive: true });
    mkdirSync(cliShimsDir, { recursive: true });
    mkdirSync(transformersDir, { recursive: true });
    mkdirSync(ortDir, { recursive: true });
    mkdirSync(ortCommonDir, { recursive: true });
    mkdirSync(nodePtyDir, { recursive: true });
    mkdirSync(homebridgePtyDir, { recursive: true });

    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'repo', private: true }, null, 2));
    writeCliRuntimePackageFixture(repoRoot);
    writePackagedVoiceRuntimeFixture({ cliDistDir, cliRuntimeDir });
    writeFileSync(join(cliScriptsDir, 'childProcessOptions.cjs'), 'module.exports = { withWindowsHide: (input) => input };\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_version_utils.cjs'), 'module.exports = { getClaudeCliPath: () => "claude", runClaudeCli: () => {} };\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_local_launcher.cjs'), 'require("./claude_version_utils.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_remote_launcher.cjs'), 'require("./claude_version_utils.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'session_hook_forwarder.cjs'), 'console.log("session");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'permission_hook_forwarder.cjs'), 'console.log("permission");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'ripgrep_launcher.cjs'), 'require("./childProcessOptions.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'terminal_launch_spec_runner.cjs'), 'console.log("terminal launch spec");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'node_pty_relay.cjs'), 'console.log("node pty relay");\n', 'utf8');
    writeFileSync(join(cliRuntimeDir, 'loadTransformersFromRuntime.mjs'), 'export const env = {}; export async function pipeline() { return () => null; }\n', 'utf8');
    writeFileSync(join(cliShimsDir, 'git'), '#!/bin/sh\nexit 0\n', 'utf8');
    writeFileSync(join(cliShimsDir, 'rg'), '#!/bin/sh\nexit 0\n', 'utf8');
    writeSherpaRuntimePackageFixture(repoRoot);
    writeFfmpegStaticPackageFixture(repoRoot);
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
    await artifacts.buildCliBinaryArtifactPayload({
      repoRoot,
      payloadDir,
      target: resolveHostCliBinaryTarget(artifacts),
      cliProxyApiManagedRuntimeExecutablePath: writeCliProxyApiManagedRuntimeFixture(repoRoot, resolveHostCliBinaryTarget(artifacts)),
      commandProbe: () => true,
      runCommand: async () => {
        mkdirSync(cliDistDir, { recursive: true });
        writeFileSync(join(cliDistDir, 'index.mjs'), 'export { detect } from "./detect-BwxnBwvx.mjs";\n', 'utf8');
        writeFileSync(join(cliDistDir, 'detect-BwxnBwvx.mjs'), 'export const detect = true;\n', 'utf8');
      },
      compileBinary: async ({ outfile }) => {
        rmSync(cliDistDir, { recursive: true, force: true });
        writeFileSync(outfile, '#!/bin/sh\necho happier\n', 'utf8');
      },
    });

    assert.equal(readFileSync(join(payloadDir, 'package-dist', 'index.mjs'), 'utf8'), 'export { detect } from "./detect-BwxnBwvx.mjs";\n');
    assert.equal(readFileSync(join(payloadDir, 'package-dist', 'detect-BwxnBwvx.mjs'), 'utf8'), 'export const detect = true;\n');
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
    writePackagedVoiceRuntimeFixture({ cliDistDir, cliRuntimeDir });
    writeFileSync(join(cliScriptsDir, 'childProcessOptions.cjs'), 'module.exports = { withWindowsHide: (input) => input };\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_version_utils.cjs'), 'module.exports = { getClaudeCliPath: () => "claude", runClaudeCli: () => {} };\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_local_launcher.cjs'), 'require("./claude_version_utils.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_remote_launcher.cjs'), 'require("./claude_version_utils.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'session_hook_forwarder.cjs'), 'console.log("session");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'permission_hook_forwarder.cjs'), 'console.log("permission");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'ripgrep_launcher.cjs'), 'require("./childProcessOptions.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'terminal_launch_spec_runner.cjs'), 'console.log("terminal launch spec");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'node_pty_relay.cjs'), 'console.log("node pty relay");\n', 'utf8');
    writeFileSync(join(cliRuntimeDir, 'loadTransformersFromRuntime.mjs'), 'export const env = {}; export async function pipeline() { return () => null; }\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'shims', 'git'), '#!/bin/sh\nexit 0\n', 'utf8');
    writeSherpaRuntimePackageFixture(repoRoot);
    writeFfmpegStaticPackageFixture(repoRoot);
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
      target: resolveHostCliBinaryTarget(artifacts),
      cliProxyApiManagedRuntimeExecutablePath: writeCliProxyApiManagedRuntimeFixture(repoRoot, resolveHostCliBinaryTarget(artifacts)),
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
    writePackagedVoiceRuntimeFixture({ cliDistDir, cliRuntimeDir });
    writeFileSync(join(cliScriptsDir, 'childProcessOptions.cjs'), 'module.exports = { withWindowsHide: (input) => input };\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_version_utils.cjs'), 'module.exports = { getClaudeCliPath: () => "claude", runClaudeCli: () => {} };\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_local_launcher.cjs'), 'require("./claude_version_utils.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_remote_launcher.cjs'), 'require("./claude_version_utils.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'session_hook_forwarder.cjs'), 'console.log("session");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'permission_hook_forwarder.cjs'), 'console.log("permission");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'ripgrep_launcher.cjs'), 'require("./childProcessOptions.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'terminal_launch_spec_runner.cjs'), 'console.log("terminal launch spec");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'node_pty_relay.cjs'), 'console.log("node pty relay");\n', 'utf8');
    writeFileSync(join(cliRuntimeDir, 'loadTransformersFromRuntime.mjs'), 'export const env = {}; export async function pipeline() { return () => null; }\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'shims', 'git'), '#!/bin/sh\nexit 0\n', 'utf8');
    writeSherpaRuntimePackageFixture(repoRoot);
    writeFfmpegStaticPackageFixture(repoRoot);
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
      target: resolveHostCliBinaryTarget(artifacts),
      cliProxyApiManagedRuntimeExecutablePath: writeCliProxyApiManagedRuntimeFixture(repoRoot, resolveHostCliBinaryTarget(artifacts)),
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
    writePackagedVoiceRuntimeFixture({ cliDistDir, cliRuntimeDir });
    writeFileSync(join(cliScriptsDir, 'childProcessOptions.cjs'), 'module.exports = { withWindowsHide: (input) => input };\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_version_utils.cjs'), 'module.exports = { getClaudeCliPath: () => "claude", runClaudeCli: () => {} };\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_local_launcher.cjs'), 'require("./claude_version_utils.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'claude_remote_launcher.cjs'), 'require("./claude_version_utils.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'session_hook_forwarder.cjs'), 'console.log("session");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'permission_hook_forwarder.cjs'), 'console.log("permission");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'ripgrep_launcher.cjs'), 'require("./childProcessOptions.cjs");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'terminal_launch_spec_runner.cjs'), 'console.log("terminal launch spec");\n', 'utf8');
    writeFileSync(join(cliScriptsDir, 'node_pty_relay.cjs'), 'console.log("node pty relay");\n', 'utf8');
    writeFileSync(join(cliRuntimeDir, 'loadTransformersFromRuntime.mjs'), 'export const env = {}; export async function pipeline() { return () => null; }\n', 'utf8');
    writeFileSync(join(cliShimsDir, 'git'), '#!/bin/sh\nexit 0\n', 'utf8');
    writeSherpaRuntimePackageFixture(repoRoot);
    writeFfmpegStaticPackageFixture(repoRoot);
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
    const target = resolveHostCliBinaryTarget(artifacts);
    await artifacts.buildCliBinaryArtifactPayload({
      repoRoot,
      payloadDir,
      target,
      cliProxyApiManagedRuntimeExecutablePath: writeCliProxyApiManagedRuntimeFixture(repoRoot, target),
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

    assert.deepEqual([...compileCalls[0]?.externals].sort(), [
      '@homebridge/node-pty-prebuilt-multiarch',
      'ffmpeg-static',
      '@huggingface/transformers',
      'node-pty',
      'pino',
      'sherpa-onnx-node',
      'thread-stream',
    ].sort());
    assert.equal(existsSync(join(payloadDir, 'node_modules', '@huggingface', 'transformers')), false);
    assert.equal(existsSync(join(payloadDir, 'node_modules', 'ffmpeg-static')), false);
    assert.equal(existsSync(join(payloadDir, 'node_modules', 'sherpa-onnx-node')), false);
    assert.equal(
      existsSync(join(payloadDir, 'tools', 'archives', `voice-inference-runtime-${target.os}-${target.arch}.tar.gz`)),
      true,
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('buildServerBinaryArtifactPayload stages and finalizes self-contained runtime sidecars', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'component-artifacts-server-'));
  try {
    const repoRoot = join(tempRoot, 'repo');
    const payloadDir = join(tempRoot, 'payload');
    const serverSourcesDir = join(repoRoot, 'apps', 'server', 'sources');
    const uiDistDir = join(repoRoot, 'apps', 'ui', 'dist');
    const sqliteClientDir = join(repoRoot, 'apps', 'server', 'generated', 'sqlite-client');
    const mysqlClientDir = join(repoRoot, 'apps', 'server', 'generated', 'mysql-client');
    const sqliteMigrationsDir = join(repoRoot, 'apps', 'server', 'prisma', 'sqlite', 'migrations');
    const postgresClientDir = join(repoRoot, 'node_modules', '.prisma', 'client');
    const prismaClientPackageDir = join(repoRoot, 'node_modules', '@prisma', 'client');

    mkdirSync(serverSourcesDir, { recursive: true });
    mkdirSync(uiDistDir, { recursive: true });
    mkdirSync(sqliteClientDir, { recursive: true });
    mkdirSync(mysqlClientDir, { recursive: true });
    mkdirSync(sqliteMigrationsDir, { recursive: true });
    mkdirSync(postgresClientDir, { recursive: true });
    mkdirSync(prismaClientPackageDir, { recursive: true });

    writeFileSync(join(serverSourcesDir, 'main.light.ts'), 'export {};\n', 'utf8');
    writeFileSync(join(uiDistDir, 'index.html'), '<html>ui</html>\n', 'utf8');
    writeFileSync(join(sqliteClientDir, 'schema.prisma'), '// sqlite\n', 'utf8');
    writeFileSync(join(mysqlClientDir, 'schema.prisma'), '// mysql\n', 'utf8');
    writeFileSync(join(sqliteMigrationsDir, 'migration.sql'), '-- sql\n', 'utf8');
    writeServerPrismaEngineFixtures({
      sqliteClientDir,
      mysqlClientDir,
      postgresClientDir,
      providers: ['sqlite', 'mysql'],
    });
    writeFileSync(join(prismaClientPackageDir, 'index.js'), 'module.exports = { PrismaClient: class PrismaClient {} };\n', 'utf8');
    if (process.platform !== 'win32') {
      const externalBinTarget = join(tempRoot, 'external-server-bin-target.js');
      const nestedBinDir = join(prismaClientPackageDir, 'node_modules', '.bin');
      writeFileSync(externalBinTarget, 'console.log("external server bin target");\n', 'utf8');
      mkdirSync(nestedBinDir, { recursive: true });
      symlinkSync(externalBinTarget, join(nestedBinDir, 'external-server-bin'));
    }

    const artifacts = await import('../dist/componentArtifacts/index.js');
    const compileCalls = [];
    const runCalls = [];
    const result = await artifacts.buildServerBinaryArtifactPayload({
      repoRoot,
      payloadDir,
      uiWebDistPath: uiDistDir,
      serverComponent: 'happier-server-light',
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
        if (process.platform !== 'win32') {
          const runtimeAssetsDir = join(payloadDir, 'runtime-assets');
          const runtimeLinksDir = join(payloadDir, 'runtime-links');
          mkdirSync(runtimeAssetsDir, { recursive: true });
          mkdirSync(runtimeLinksDir, { recursive: true });
          writeFileSync(join(runtimeAssetsDir, 'inside.txt'), 'inside\n', 'utf8');
          symlinkSync(join('..', 'runtime-assets', 'inside.txt'), join(runtimeLinksDir, 'internal-link'));
        }
      },
    });

    assert.equal(result.executableName, 'happier-server');
    assert.equal(result.entrypoint, 'happier-server');
    assert.equal(result.migrationEntrypoint, undefined);
    assert.equal(compileCalls.length, 1);
    assert.deepEqual(runCalls, [
      {
        cmd: process.execPath,
        args: ['apps/server/scripts/buildSharedDeps.mjs', '--quiet'],
      },
      {
        cmd: 'yarn',
        args: ['--cwd', 'apps/server', '-s', 'generate:providers'],
      },
    ]);
    assert.equal(readFileSync(join(payloadDir, 'happier-server'), 'utf8'), '#!/bin/sh\necho happier-server\n');
    assert.equal(readFileSync(join(payloadDir, 'generated', 'sqlite-client', 'schema.prisma'), 'utf8'), '// sqlite\n');
    assert.equal(readFileSync(join(payloadDir, 'generated', 'mysql-client', 'schema.prisma'), 'utf8'), '// mysql\n');
    assert.equal(readFileSync(join(payloadDir, 'prisma', 'sqlite', 'migrations', 'migration.sql'), 'utf8'), '-- sql\n');
    assert.equal(existsSync(join(payloadDir, 'happier-server-migrate')), false);
    assert.equal(existsSync(join(payloadDir, 'prisma', 'schema.prisma')), false);
    assert.equal(readFileSync(join(payloadDir, 'ui-web', 'current', 'index.html'), 'utf8'), '<html>ui</html>\n');
    assert.equal(
      readFileSync(join(payloadDir, 'node_modules', '.prisma', 'client', 'libquery_engine-debian-openssl-3.0.x.so.node'), 'utf8'),
      'postgres-engine\n',
    );
    assert.equal(
      readFileSync(join(payloadDir, 'node_modules', '@prisma', 'client', 'index.js'), 'utf8'),
      'module.exports = { PrismaClient: class PrismaClient {} };\n'
    );
    if (process.platform !== 'win32') {
      assert.equal(readFileSync(join(payloadDir, 'runtime-links', 'internal-link'), 'utf8'), 'inside\n');
      assert.equal(
        existsSync(join(payloadDir, 'node_modules', '@prisma', 'client', 'node_modules', '.bin')),
        false,
        'the completed server payload must not retain nested package-manager shims',
      );
      const externalRuntimeTarget = join(tempRoot, 'external-server-runtime-target.js');
      writeFileSync(externalRuntimeTarget, 'console.log("external server runtime target");\n', 'utf8');
      for (const [linkName, linkTarget] of [
        ['absolute-link', externalRuntimeTarget],
        ['escaping-relative-link', join('..', '..', 'external-server-runtime-target.js')],
      ]) {
        await assert.rejects(
          artifacts.buildServerBinaryArtifactPayload({
            repoRoot,
            payloadDir,
            uiWebDistPath: uiDistDir,
            entrypoint: join(serverSourcesDir, 'main.light.ts'),
            buildDbProviders: 'all',
            target: artifacts.resolveCurrentBinaryTarget({
              availableTargets: artifacts.SERVER_BINARY_TARGETS,
              platform: 'linux',
              arch: 'x64',
            }),
            commandProbe: () => true,
            runCommand: () => {},
            compileBinary: async ({ outfile }) => {
              writeFileSync(outfile, '#!/bin/sh\necho happier-server\n', 'utf8');
              const runtimeLinksDir = join(payloadDir, 'runtime-links');
              mkdirSync(runtimeLinksDir, { recursive: true });
              symlinkSync(linkTarget, join(runtimeLinksDir, linkName));
            },
          }),
          /runtime payload symlink escapes the artifact/i,
        );
      }
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('buildServerBinaryArtifactPayload packages full PostgreSQL and MySQL migration capability only for full server', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'component-artifacts-full-server-'));
  try {
    const repoRoot = join(tempRoot, 'repo');
    const payloadDir = join(tempRoot, 'payload');
    const serverRoot = join(repoRoot, 'apps', 'server');
    const targetEngine = 'libquery_engine-debian-openssl-3.0.x.so.node';
    for (const dir of [
      join(serverRoot, 'sources'),
      join(serverRoot, 'scripts', 'runtime'),
      join(serverRoot, 'generated', 'mysql-client'),
      join(serverRoot, 'generated', 'runtime-migration-engines', 'linux-x64'),
      join(serverRoot, 'prisma', 'migrations', 'pg-sentinel'),
      join(serverRoot, 'prisma', 'mysql', 'migrations', 'mysql-sentinel'),
      join(repoRoot, 'apps', 'ui', 'dist'),
      join(repoRoot, 'node_modules', '.prisma', 'client'),
      join(repoRoot, 'node_modules', '@prisma', 'client'),
      join(repoRoot, 'node_modules', 'prisma', 'build'),
    ]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(serverRoot, 'sources', 'main.ts'), 'export {};\n');
    writeFileSync(join(serverRoot, 'scripts', 'runtime', 'migrateFullRuntime.ts'), 'export {};\n');
    writeFileSync(join(serverRoot, 'generated', 'mysql-client', targetEngine), 'mysql engine\n');
    writeFileSync(join(serverRoot, 'generated', 'mysql-client', 'schema.prisma'), '// generated mysql\n');
    writeFileSync(join(serverRoot, 'generated', 'runtime-migration-engines', 'linux-x64', 'schema-engine-debian-openssl-3.0.x'), 'schema engine\n');
    writeFileSync(join(serverRoot, 'prisma', 'schema.prisma'), '// pg schema\n');
    writeFileSync(join(serverRoot, 'prisma', 'migrations', 'migration_lock.toml'), 'provider = "postgresql"\n');
    writeFileSync(join(serverRoot, 'prisma', 'migrations', 'pg-sentinel', 'migration.sql'), '-- pg migration\n');
    writeFileSync(join(serverRoot, 'prisma', 'mysql', 'schema.prisma'), '// mysql schema\n');
    writeFileSync(join(serverRoot, 'prisma', 'mysql', 'migrations', 'migration_lock.toml'), 'provider = "mysql"\n');
    writeFileSync(join(serverRoot, 'prisma', 'mysql', 'migrations', 'mysql-sentinel', 'migration.sql'), '-- mysql migration\n');
    writeFileSync(join(repoRoot, 'apps', 'ui', 'dist', 'index.html'), '<html>full</html>\n');
    writeFileSync(join(repoRoot, 'node_modules', '.prisma', 'client', targetEngine), 'pg engine\n');
    writeFileSync(join(repoRoot, 'node_modules', '@prisma', 'client', 'index.js'), 'module.exports = {};\n');
    writeFileSync(join(repoRoot, 'node_modules', 'prisma', 'build', 'prisma_schema_build_bg.wasm'), 'schema wasm\n');

    const artifacts = await import('../dist/componentArtifacts/index.js');
    const result = await artifacts.buildServerBinaryArtifactPayload({
      repoRoot,
      payloadDir,
      uiWebDistPath: join(repoRoot, 'apps', 'ui', 'dist'),
      serverComponent: 'happier-server',
      entrypoint: join(serverRoot, 'sources', 'main.ts'),
      buildDbProviders: 'postgresql',
      target: artifacts.resolveCurrentBinaryTarget({ availableTargets: artifacts.SERVER_BINARY_TARGETS, platform: 'linux', arch: 'x64' }),
      commandProbe: () => true,
      runCommand: () => undefined,
      compileBinary: async ({ outfile }) => writeFileSync(outfile, 'compiled\n'),
      compilePrismaBinary: async ({ outfile }) => writeFileSync(outfile, 'prisma runner\n'),
    });

    assert.equal(result.migrationEntrypoint, 'happier-server-migrate');
    assert.equal(readFileSync(join(payloadDir, 'prisma', 'migrations', 'pg-sentinel', 'migration.sql'), 'utf8'), '-- pg migration\n');
    assert.equal(readFileSync(join(payloadDir, 'prisma', 'mysql', 'migrations', 'mysql-sentinel', 'migration.sql'), 'utf8'), '-- mysql migration\n');
    assert.equal(readFileSync(join(payloadDir, 'runtime', 'schema-engine'), 'utf8'), 'schema engine\n');
    assert.equal(readFileSync(join(payloadDir, 'runtime', 'prisma_schema_build_bg.wasm'), 'utf8'), 'schema wasm\n');
    assert.equal(readFileSync(join(payloadDir, 'runtime', 'prisma-migrate'), 'utf8'), 'prisma runner\n');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('buildServerBinaryArtifactPayload stages sharp runtime sidecars for the server binary target', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'component-artifacts-server-sharp-'));
  try {
    const repoRoot = join(tempRoot, 'repo');
    const payloadDir = join(tempRoot, 'payload');
    const serverSourcesDir = join(repoRoot, 'apps', 'server', 'sources');
    const uiDistDir = join(repoRoot, 'apps', 'ui', 'dist');
    const sqliteClientDir = join(repoRoot, 'apps', 'server', 'generated', 'sqlite-client');
    const sqliteMigrationsDir = join(repoRoot, 'apps', 'server', 'prisma', 'sqlite', 'migrations');
    const postgresClientDir = join(repoRoot, 'node_modules', '.prisma', 'client');
    const prismaClientPackageDir = join(repoRoot, 'node_modules', '@prisma', 'client');
    const sharpDir = join(repoRoot, 'node_modules', 'sharp');
    const sharpLinuxX64Dir = join(repoRoot, 'node_modules', '@img', 'sharp-linux-x64');
    const sharpLibvipsLinuxX64Dir = join(repoRoot, 'node_modules', '@img', 'sharp-libvips-linux-x64');
    const sharpDarwinArm64Dir = join(repoRoot, 'node_modules', '@img', 'sharp-darwin-arm64');

    mkdirSync(serverSourcesDir, { recursive: true });
    mkdirSync(uiDistDir, { recursive: true });
    mkdirSync(sqliteClientDir, { recursive: true });
    mkdirSync(sqliteMigrationsDir, { recursive: true });
    mkdirSync(postgresClientDir, { recursive: true });
    mkdirSync(prismaClientPackageDir, { recursive: true });
    mkdirSync(sharpDir, { recursive: true });
    mkdirSync(sharpLinuxX64Dir, { recursive: true });
    mkdirSync(sharpLibvipsLinuxX64Dir, { recursive: true });
    mkdirSync(sharpDarwinArm64Dir, { recursive: true });

    writeFileSync(join(serverSourcesDir, 'main.light.ts'), 'export {};\n', 'utf8');
    writeFileSync(join(uiDistDir, 'index.html'), '<html>ui</html>\n', 'utf8');
    writeFileSync(join(sqliteClientDir, 'schema.prisma'), '// sqlite\n', 'utf8');
    writeFileSync(join(sqliteMigrationsDir, 'migration.sql'), '-- sql\n', 'utf8');
    writeServerPrismaEngineFixtures({ sqliteClientDir, postgresClientDir });
    writeFileSync(join(prismaClientPackageDir, 'index.js'), 'module.exports = { PrismaClient: class PrismaClient {} };\n', 'utf8');
    writeFileSync(
      join(sharpDir, 'package.json'),
      JSON.stringify({
        name: 'sharp',
        version: '0.0.0',
        dependencies: {
          '@img/sharp-linux-x64': '0.0.0',
        },
        optionalDependencies: {
          '@img/sharp-libvips-linux-x64': '0.0.0',
          '@img/sharp-darwin-arm64': '0.0.0',
        },
      }),
      'utf8',
    );
    writeFileSync(join(sharpDir, 'index.js'), 'module.exports = {};\n', 'utf8');
    writeFileSync(
      join(sharpLinuxX64Dir, 'package.json'),
      JSON.stringify({ name: '@img/sharp-linux-x64', os: ['linux'], cpu: ['x64'] }),
      'utf8',
    );
    writeFileSync(join(sharpLinuxX64Dir, 'binding.node'), 'linux sharp binding\n', 'utf8');
    writeFileSync(
      join(sharpLibvipsLinuxX64Dir, 'package.json'),
      JSON.stringify({ name: '@img/sharp-libvips-linux-x64', os: ['linux'], cpu: ['x64'] }),
      'utf8',
    );
    writeFileSync(join(sharpLibvipsLinuxX64Dir, 'libvips.so'), 'linux libvips\n', 'utf8');
    writeFileSync(
      join(sharpDarwinArm64Dir, 'package.json'),
      JSON.stringify({ name: '@img/sharp-darwin-arm64', os: ['darwin'], cpu: ['arm64'] }),
      'utf8',
    );
    writeFileSync(join(sharpDarwinArm64Dir, 'binding.node'), 'darwin sharp binding\n', 'utf8');

    const artifacts = await import('../dist/componentArtifacts/index.js');
    const compileCalls = [];
    await artifacts.buildServerBinaryArtifactPayload({
      repoRoot,
      payloadDir,
      uiWebDistPath: uiDistDir,
      entrypoint: join(serverSourcesDir, 'main.light.ts'),
      buildDbProviders: 'sqlite',
      target: artifacts.resolveCurrentBinaryTarget({
        availableTargets: artifacts.SERVER_BINARY_TARGETS,
        platform: 'linux',
        arch: 'x64',
      }),
      commandProbe: () => true,
      runCommand: () => {},
      compileBinary: async ({ outfile, externals }) => {
        compileCalls.push({ externals });
        writeFileSync(outfile, '#!/bin/sh\necho happier-server\n', 'utf8');
      },
    });

    assert.deepEqual(compileCalls, [{ externals: ['redis'] }]);
    assert.equal(readFileSync(join(payloadDir, 'node_modules', 'sharp', 'index.js'), 'utf8'), 'module.exports = {};\n');
    assert.equal(
      readFileSync(join(payloadDir, 'node_modules', '@img', 'sharp-linux-x64', 'binding.node'), 'utf8'),
      'linux sharp binding\n',
    );
    assert.equal(
      readFileSync(join(payloadDir, 'node_modules', '@img', 'sharp-libvips-linux-x64', 'libvips.so'), 'utf8'),
      'linux libvips\n',
    );
    assert.equal(existsSync(join(payloadDir, 'node_modules', '@img', 'sharp-darwin-arm64')), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('buildServerBinaryArtifactPayload delegates provider freshness to generate:providers before staging server sidecars', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'component-artifacts-server-provider-freshness-'));
  try {
    const repoRoot = join(tempRoot, 'repo');
    const payloadDir = join(tempRoot, 'payload');
    const serverSourcesDir = join(repoRoot, 'apps', 'server', 'sources');
    const uiDistDir = join(repoRoot, 'apps', 'ui', 'dist');
    const sqliteClientDir = join(repoRoot, 'apps', 'server', 'generated', 'sqlite-client');
    const mysqlClientDir = join(repoRoot, 'apps', 'server', 'generated', 'mysql-client');
    const sqliteMigrationsDir = join(repoRoot, 'apps', 'server', 'prisma', 'sqlite', 'migrations');
    const sqliteSchemaPath = join(repoRoot, 'apps', 'server', 'prisma', 'sqlite', 'schema.prisma');
    const postgresSchemaPath = join(repoRoot, 'apps', 'server', 'prisma', 'schema.prisma');
    const postgresClientDir = join(repoRoot, 'node_modules', '.prisma', 'client');
    const prismaClientPackageDir = join(repoRoot, 'node_modules', '@prisma', 'client');

    mkdirSync(serverSourcesDir, { recursive: true });
    mkdirSync(uiDistDir, { recursive: true });
    mkdirSync(sqliteClientDir, { recursive: true });
    mkdirSync(mysqlClientDir, { recursive: true });
    mkdirSync(sqliteMigrationsDir, { recursive: true });
    mkdirSync(join(repoRoot, 'apps', 'server', 'prisma'), { recursive: true });
    mkdirSync(postgresClientDir, { recursive: true });
    mkdirSync(prismaClientPackageDir, { recursive: true });

    writeFileSync(join(serverSourcesDir, 'main.light.ts'), 'export {};\n', 'utf8');
    writeFileSync(join(uiDistDir, 'index.html'), '<html>ui</html>\n', 'utf8');
    writeFileSync(postgresSchemaPath, '// canonical postgres schema\n', 'utf8');
    writeFileSync(sqliteSchemaPath, '// canonical sqlite schema\n', 'utf8');
    writeFileSync(join(sqliteClientDir, 'schema.prisma'), '// stale sqlite schema\n', 'utf8');
    writeFileSync(join(mysqlClientDir, 'index.js'), 'module.exports = {};\n', 'utf8');
    writeFileSync(join(sqliteMigrationsDir, 'migration.sql'), '-- sql\n', 'utf8');
    writeServerPrismaEngineFixtures({
      sqliteClientDir,
      mysqlClientDir,
      postgresClientDir,
      providers: ['sqlite', 'mysql'],
    });
    writeFileSync(join(sqliteClientDir, 'index.js'), 'module.exports = {};\n', 'utf8');
    writeFileSync(join(postgresClientDir, 'schema.prisma'), '// stale postgres schema\n', 'utf8');
    writeFileSync(join(postgresClientDir, 'default.js'), 'module.exports = {};\n', 'utf8');
    writeFileSync(join(prismaClientPackageDir, 'index.js'), 'module.exports = { PrismaClient: class PrismaClient {} };\n', 'utf8');

    const artifacts = await import('../dist/componentArtifacts/index.js');
    const runCalls = [];

    await artifacts.buildServerBinaryArtifactPayload({
      repoRoot,
      payloadDir,
      uiWebDistPath: uiDistDir,
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
        const rendered = `${cmd} ${args.join(' ')}`;
        if (rendered.includes('--cwd apps/server -s generate:providers')) {
          writeFileSync(join(sqliteClientDir, 'schema.prisma'), '// canonical sqlite schema\n', 'utf8');
          writeFileSync(join(postgresClientDir, 'schema.prisma'), '// canonical postgres schema\n', 'utf8');
        }
      },
      compileBinary: async ({ outfile }) => {
        writeFileSync(outfile, '#!/bin/sh\necho happier-server\n', 'utf8');
      },
    });

    assert.deepEqual(runCalls, [
      {
        cmd: process.execPath,
        args: ['apps/server/scripts/buildSharedDeps.mjs', '--quiet'],
      },
      {
        cmd: 'yarn',
        args: ['--cwd', 'apps/server', '-s', 'generate:providers'],
      },
    ]);
    assert.equal(
      readFileSync(join(payloadDir, 'generated', 'sqlite-client', 'schema.prisma'), 'utf8'),
      '// canonical sqlite schema\n',
    );
    assert.equal(
      readFileSync(join(payloadDir, 'node_modules', '.prisma', 'client', 'schema.prisma'), 'utf8'),
      '// canonical postgres schema\n',
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('buildServerBinaryArtifactPayload fails darwin artifacts without the darwin Prisma engine', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'component-artifacts-server-darwin-engine-'));
  try {
    const repoRoot = join(tempRoot, 'repo');
    const payloadDir = join(tempRoot, 'payload');
    const serverSourcesDir = join(repoRoot, 'apps', 'server', 'sources');
    const uiDistDir = join(repoRoot, 'apps', 'ui', 'dist');
    const sqliteClientDir = join(repoRoot, 'apps', 'server', 'generated', 'sqlite-client');
    const sqliteMigrationsDir = join(repoRoot, 'apps', 'server', 'prisma', 'sqlite', 'migrations');
    const postgresClientDir = join(repoRoot, 'node_modules', '.prisma', 'client');
    const prismaClientPackageDir = join(repoRoot, 'node_modules', '@prisma', 'client');

    mkdirSync(serverSourcesDir, { recursive: true });
    mkdirSync(uiDistDir, { recursive: true });
    mkdirSync(sqliteClientDir, { recursive: true });
    mkdirSync(sqliteMigrationsDir, { recursive: true });
    mkdirSync(postgresClientDir, { recursive: true });
    mkdirSync(prismaClientPackageDir, { recursive: true });

    writeFileSync(join(serverSourcesDir, 'main.light.ts'), 'export {};\n', 'utf8');
    writeFileSync(join(uiDistDir, 'index.html'), '<html>ui</html>\n', 'utf8');
    writeFileSync(join(sqliteClientDir, 'schema.prisma'), '// sqlite\n', 'utf8');
    writeFileSync(join(sqliteClientDir, 'libquery_engine-linux-arm64-openssl-3.0.x.so.node'), 'wrong-platform\n', 'utf8');
    writeFileSync(join(sqliteMigrationsDir, 'migration.sql'), '-- sql\n', 'utf8');
    writeServerPrismaEngineFixtures({
      sqliteClientDir: null,
      mysqlClientDir: null,
      postgresClientDir,
      providers: [],
      platform: 'darwin',
      arch: 'arm64',
    });
    writeFileSync(join(prismaClientPackageDir, 'index.js'), 'module.exports = { PrismaClient: class PrismaClient {} };\n', 'utf8');

    const artifacts = await import('../dist/componentArtifacts/index.js');
    await assert.rejects(
      artifacts.buildServerBinaryArtifactPayload({
        repoRoot,
        payloadDir,
        uiWebDistPath: uiDistDir,
        entrypoint: join(serverSourcesDir, 'main.light.ts'),
        buildDbProviders: 'sqlite',
        target: artifacts.resolveCurrentBinaryTarget({
          availableTargets: artifacts.SERVER_BINARY_TARGETS,
          platform: 'darwin',
          arch: 'arm64',
        }),
        commandProbe: () => true,
        runCommand: () => {},
        compileBinary: async ({ outfile }) => {
          writeFileSync(outfile, '#!/bin/sh\necho happier-server\n', 'utf8');
        },
      }),
      /missing sqlite Prisma query engine for darwin-arm64/i,
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
    const uiDistDir = join(repoRoot, 'apps', 'ui', 'dist');
    const sqliteClientDir = join(repoRoot, 'apps', 'server', 'generated', 'sqlite-client');
    const sqliteMigrationsDir = join(repoRoot, 'apps', 'server', 'prisma', 'sqlite', 'migrations');
    const postgresClientDir = join(repoRoot, 'node_modules', '.prisma', 'client');
    const prismaClientPackageDir = join(repoRoot, 'node_modules', '@prisma', 'client');

    mkdirSync(serverSourcesDir, { recursive: true });
    mkdirSync(uiDistDir, { recursive: true });
    mkdirSync(sqliteClientDir, { recursive: true });
    mkdirSync(sqliteMigrationsDir, { recursive: true });
    mkdirSync(postgresClientDir, { recursive: true });
    mkdirSync(prismaClientPackageDir, { recursive: true });

    writeFileSync(join(serverSourcesDir, 'main.light.ts'), 'export {};\n', 'utf8');
    writeFileSync(join(uiDistDir, 'index.html'), '<html>ui</html>\n', 'utf8');
    writeFileSync(join(sqliteClientDir, 'schema.prisma'), '// sqlite\n', 'utf8');
    writeFileSync(join(sqliteMigrationsDir, 'migration.sql'), '-- sql\n', 'utf8');
    writeFileSync(join(postgresClientDir, 'client.d.ts'), 'export {};\n', 'utf8');
    writeServerPrismaEngineFixtures({ sqliteClientDir, postgresClientDir });
    writeFileSync(join(prismaClientPackageDir, 'index.js'), 'module.exports = {};\n', 'utf8');

    const artifacts = await import('../dist/componentArtifacts/index.js');
    let copyAttempts = 0;
    await artifacts.buildServerBinaryArtifactPayload({
      repoRoot,
      payloadDir,
      uiWebDistPath: uiDistDir,
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

test('prepareUiWebDist refreshes an existing ui-web dist before server sidecars copy it', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'component-artifacts-server-ui-build-'));
  try {
    const repoRoot = join(tempRoot, 'repo');
    const payloadDir = join(tempRoot, 'payload');
    const serverSourcesDir = join(repoRoot, 'apps', 'server', 'sources');
    const uiDistDir = join(repoRoot, 'apps', 'ui', 'dist');
    const sqliteClientDir = join(repoRoot, 'apps', 'server', 'generated', 'sqlite-client');
    const sqliteMigrationsDir = join(repoRoot, 'apps', 'server', 'prisma', 'sqlite', 'migrations');
    const postgresClientDir = join(repoRoot, 'node_modules', '.prisma', 'client');
    const prismaClientPackageDir = join(repoRoot, 'node_modules', '@prisma', 'client');

    mkdirSync(serverSourcesDir, { recursive: true });
    mkdirSync(uiDistDir, { recursive: true });
    mkdirSync(sqliteClientDir, { recursive: true });
    mkdirSync(sqliteMigrationsDir, { recursive: true });
    mkdirSync(postgresClientDir, { recursive: true });
    mkdirSync(prismaClientPackageDir, { recursive: true });

    writeFileSync(join(serverSourcesDir, 'main.light.ts'), 'export {};\n', 'utf8');
    writeFileSync(join(uiDistDir, 'index.html'), '<html>stale ui</html>\n', 'utf8');
    writeFileSync(join(sqliteClientDir, 'schema.prisma'), '// sqlite\n', 'utf8');
    writeFileSync(join(sqliteMigrationsDir, 'migration.sql'), '-- sql\n', 'utf8');
    writeFileSync(join(postgresClientDir, 'client.d.ts'), 'export {};\n', 'utf8');
    writeServerPrismaEngineFixtures({ sqliteClientDir, postgresClientDir });
    writeFileSync(join(prismaClientPackageDir, 'index.js'), 'module.exports = {};\n', 'utf8');

    const artifacts = await import('../dist/componentArtifacts/index.js');
    const runCalls = [];
    assert.equal(typeof artifacts.prepareUiWebDist, 'function');
    const uiWebDistPath = await artifacts.prepareUiWebDist({
      repoRoot,
      commandProbe: () => true,
      runCommand: (cmd, args) => {
        runCalls.push({ cmd, args });
        const argsText = Array.isArray(args) ? args.join(' ') : '';
        if (argsText.includes('--cwd apps/ui') && argsText.includes('expo export --platform web --output-dir dist')) {
          writeFileSync(join(uiDistDir, 'index.html'), '<html>fresh ui</html>\n', 'utf8');
        }
      },
    });
    await artifacts.buildServerBinaryArtifactPayload({
      repoRoot,
      payloadDir,
      uiWebDistPath,
      buildDbProviders: 'sqlite',
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
        writeFileSync(outfile, '#!/bin/sh\necho happier-server\n', 'utf8');
      },
    });

    assert.deepEqual(runCalls, [
      { cmd: process.execPath, args: ['apps/ui/scripts/ensureWorkspacePackagesBuilt.mjs'] },
      { cmd: 'yarn', args: ['--cwd', 'apps/ui', '-s', 'expo', 'export', '--platform', 'web', '--output-dir', 'dist'] },
      { cmd: process.execPath, args: ['scripts/pipeline/release/precompress-ui-web-assets.mjs', '--dir', 'apps/ui/dist'] },
      { cmd: process.execPath, args: ['apps/server/scripts/buildSharedDeps.mjs', '--quiet'] },
      { cmd: 'yarn', args: ['--cwd', 'apps/server', '-s', 'generate:providers'] },
    ]);
    assert.equal(uiWebDistPath, uiDistDir);
    assert.equal(readFileSync(join(payloadDir, 'ui-web', 'current', 'index.html'), 'utf8'), '<html>fresh ui</html>\n');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
