#!/usr/bin/env node

// @ts-check

import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveReleaseAssetBundle } from '@happier-dev/release-runtime/assets';
import { lookupSha256 } from '@happier-dev/release-runtime/checksums';
import { verifyMinisign } from '@happier-dev/release-runtime/minisign';

import { fileSha256 } from './lib/release-files.mjs';
import { isBinaryReleaseArtifactFilename, parseArtifactFilename } from './lib/manifests.mjs';
import { parseArgs } from './lib/release-arguments.mjs';
import { shouldSmokeTestReleaseArtifact } from './publishing/artifact-smoke-compatibility.mjs';
import { CLI_OPTIONAL_COMPONENT_PRODUCTS } from './publishing/product-specs.mjs';
import { terminateProcessTreeByPid } from '../../testing/process/processTree.mjs';

const DEFAULT_BINARY_SMOKE_TIMEOUT_MS = 20_000;
const DEFAULT_SERVER_BINARY_SMOKE_TIMEOUT_MS = 15_000;

function parseChecksums(raw) {
  const lines = String(raw ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.map((line) => {
    const match = /^([a-fA-F0-9]{64})\s{2}(.+)$/.exec(line);
    if (!match) {
      throw new Error(`[release] invalid checksum line: ${line}`);
    }
    return { sha256: match[1].toLowerCase(), name: match[2] };
  });
}

async function fileExists(path) {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function verifyChecksumSignature({ checksumsPath, pubkeyFile }) {
  const message = await readFile(checksumsPath);
  const sigFile = await readFile(`${checksumsPath}.minisig`, 'utf8');
  if (!verifyMinisign({ message, sigFile, pubkeyFile })) {
    throw new Error(`[release] signature verification failed for ${checksumsPath}`);
  }
  return message.toString('utf8');
}

function isServerBinaryCandidate(candidate) {
  return String(candidate ?? '').startsWith('happier-server');
}

function formatSmokeOutput(result) {
  const stdout = String(result?.stdout ?? '').trim();
  const stderr = String(result?.stderr ?? '').trim();
  return [stdout, stderr].filter(Boolean).join('\n');
}

function readTimeoutOverride(rawValue, fallbackMs) {
  const parsed = Number.parseInt(String(rawValue ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallbackMs;
}

function resolveArtifactSmokeTimeoutMs({ serverBinary }) {
  return serverBinary
    ? readTimeoutOverride(process.env.HAPPIER_RELEASE_SERVER_SMOKE_TIMEOUT_MS, DEFAULT_SERVER_BINARY_SMOKE_TIMEOUT_MS)
    : readTimeoutOverride(process.env.HAPPIER_RELEASE_BINARY_SMOKE_TIMEOUT_MS, DEFAULT_BINARY_SMOKE_TIMEOUT_MS);
}

function createBaseCliRuntimeSmokeSource({ root, scratch, targetOs }) {
  return `
    import { mkdir, writeFile } from 'node:fs/promises';
    import { createRequire } from 'node:module';
    import { join } from 'node:path';
    import { pathToFileURL } from 'node:url';

    const root = ${JSON.stringify(root)};
    const scratch = ${JSON.stringify(scratch)};
    const targetOs = ${JSON.stringify(targetOs)};
    const runtimeRequire = createRequire(join(root, 'runtime-smoke.cjs'));

    const claudeFixturePath = join(scratch, 'claude-runtime-smoke.js');
    const claudeWorkDir = join(scratch, 'claude-work');
    await mkdir(claudeWorkDir, { recursive: true });
    await writeFile(claudeFixturePath, ${JSON.stringify(`
      const readline = require('node:readline');
      const input = readline.createInterface({ input: process.stdin });
      let sent = false;
      input.on('line', () => {
        if (sent) return;
        sent = true;
        process.stdout.write(JSON.stringify({ type: 'result', result: 'fixture-ok' }) + '\\n');
      });
    `)});

    const claudeSdkEntry = runtimeRequire.resolve('@anthropic-ai/claude-agent-sdk');
    const { createSdkMcpServer, query, tool } = await import(pathToFileURL(claudeSdkEntry).href);
    const claudeQuery = query({
      prompt: 'runtime-smoke',
      options: {
        cwd: claudeWorkDir,
        executable: process.execPath,
        pathToClaudeCodeExecutable: claudeFixturePath,
        settingSources: [],
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: '',
          CLAUDE_CODE_OAUTH_TOKEN: '',
          CLAUDE_CONFIG_DIR: join(scratch, 'claude-config'),
        },
      },
    });
    try {
      const first = await claudeQuery.next();
      if (first.done || first.value?.type !== 'result' || first.value?.result !== 'fixture-ok') {
        throw new Error('Claude Agent SDK query did not execute the generated fixture');
      }
    } finally {
      claudeQuery.close();
    }

    const cjsMcp = runtimeRequire('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = runtimeRequire('@modelcontextprotocol/sdk/inMemory.js');
    if (typeof cjsMcp.Client !== 'function' || typeof InMemoryTransport?.createLinkedPair !== 'function') {
      throw new Error('MCP SDK CommonJS exports are unavailable');
    }
    const { z } = runtimeRequire('zod');
    const echoTool = tool(
      'runtime_echo',
      'Echoes the release runtime smoke value',
      { value: z.string() },
      async ({ value }) => ({ content: [{ type: 'text', text: value }] }),
    );
    const sdkServer = createSdkMcpServer({ name: 'release-runtime-smoke', version: '1.0.0', tools: [echoTool] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new cjsMcp.Client({ name: 'release-runtime-smoke', version: '1.0.0' }, { capabilities: {} });
    try {
      await Promise.all([sdkServer.instance.connect(serverTransport), mcpClient.connect(clientTransport)]);
      await mcpClient.ping();
      const tools = await mcpClient.listTools();
      if (!tools.tools?.some((entry) => entry.name === 'runtime_echo')) {
        throw new Error('Claude SDK MCP server tool was not listed by the root MCP client');
      }
      const called = await mcpClient.callTool({ name: 'runtime_echo', arguments: { value: 'mcp-ok' } });
      if (!called.content?.some((entry) => entry.type === 'text' && entry.text === 'mcp-ok')) {
        throw new Error('Claude SDK MCP server tool call did not cross the root in-memory transport');
      }
    } finally {
      await mcpClient.close();
      await sdkServer.instance.close();
    }

    const sharp = runtimeRequire('sharp');
    const png = await sharp({
      create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).png().toBuffer();
    const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    if (png.length < pngSignature.length || !png.subarray(0, pngSignature.length).equals(pngSignature)) {
      throw new Error('sharp did not encode a 1x1 PNG');
    }

    if (targetOs === 'linux') {
      const homebridgePty = runtimeRequire('@homebridge/node-pty-prebuilt-multiarch');
      if (typeof homebridgePty.spawn !== 'function') throw new Error('Homebridge PTY package did not load');
    }

    const nodePty = runtimeRequire('node-pty');
    const command = targetOs === 'windows' ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
    // cmd's set /p prints its prompt but exits 1 at EOF; echo succeeds without input.
    const args = targetOs === 'windows'
      ? ['/d', '/s', '/c', 'echo pty-ok']
      : ['-c', 'printf pty-ok'];
    const ptyOutput = await new Promise((resolvePromise, rejectPromise) => {
      let output = '';
      let pty;
      try {
        pty = nodePty.spawn(command, args, {
          name: 'xterm-color',
          cols: 80,
          rows: 24,
          cwd: root,
          env: process.env,
        });
      } catch (error) {
        rejectPromise(error);
        return;
      }
      pty.onData((chunk) => { output += chunk; });
      pty.onExit(({ exitCode, signal }) => {
        if (exitCode !== 0) {
          rejectPromise(new Error('node-pty child failed with exit ' + exitCode + ' signal ' + signal));
          return;
        }
        resolvePromise(output);
      });
    });
    if (!ptyOutput.includes('pty-ok')) throw new Error('node-pty did not carry subprocess output');
  `;
}

async function assertPathsAbsent(paths, message) {
  const present = (await Promise.all(paths.map(async (path) => {
    try {
      await stat(path);
      return path;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }))).filter(Boolean);
  if (present.length > 0) throw new Error(`${message}: ${present.join(', ')}`);
}

async function assertBaseCliProjection({ root, targetOs }) {
  const claudeScopes = [
    join(root, 'node_modules', '@anthropic-ai'),
    join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'node_modules', '@anthropic-ai'),
  ];
  const claudeNativePackageNames = [
    'claude-agent-sdk-darwin-arm64', 'claude-agent-sdk-darwin-x64',
    'claude-agent-sdk-linux-arm64', 'claude-agent-sdk-linux-x64',
    'claude-agent-sdk-linux-arm64-musl', 'claude-agent-sdk-linux-x64-musl',
    'claude-agent-sdk-win32-arm64', 'claude-agent-sdk-win32-x64',
  ];
  await assertPathsAbsent(
    claudeScopes.flatMap((scope) => claudeNativePackageNames.map((name) => join(scope, name))),
    'unused Claude SDK native fallback package survived projection',
  );
  await assertPathsAbsent(
    [join(root, 'tools', 'unpacked', 'ripgrep.node')],
    'unused ripgrep native addon survived projection',
  );
  if (targetOs === 'windows') {
    await assertPathsAbsent(
      [
        join(root, 'tools', 'unpacked', 'zellij.exe'),
        join(root, 'tools', 'unpacked', 'zellij-LICENSE'),
      ],
      'unreachable Windows zellij input survived projection',
    );
  }
  if (targetOs === 'windows') return;
  const ptyRoots = [
    join(root, 'node_modules', 'node-pty'),
    join(root, 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch'),
  ];
  await assertPathsAbsent(
    ptyRoots.flatMap((packageRoot) => ['third_party/conpty', 'deps/winpty', 'src/win']
      .map((relativePath) => join(packageRoot, relativePath))),
    'Windows-only PTY input survived non-Windows projection',
  );
}

async function runSmokeCommand({ command, args, cwd, env, timeoutMs }) {
  return await new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    child.stdout?.setEncoding('utf-8');
    child.stderr?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });

    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };

    child.on('error', (error) => {
      settle({
        status: null,
        signal: null,
        error,
        timedOut,
        stdout,
        stderr,
      });
    });

    child.on('close', (code, signal) => {
      settle({
        status: code,
        signal,
        error: null,
        timedOut,
        stdout,
        stderr,
      });
    });

    const timer = setTimeout(() => {
      timedOut = true;
      if (Number.isInteger(child.pid) && child.pid > 0) {
        void terminateProcessTreeByPid(child.pid, {
          graceMs: 250,
          pollMs: 25,
          skipAliveCheck: true,
        }).catch(() => {});
      }
    }, timeoutMs);
  });
}

async function runBaseCliRuntimeSmoke({ root, scratch, artifact, archivePath, env }) {
  const timeoutMs = resolveArtifactSmokeTimeoutMs({ serverBinary: false });
  // Version dispatch can succeed before the command catalog and its packaged
  // metadata load. Exercise that native startup path before accepting a CLI.
  const nativeHelp = await runSmokeCommand({
    command: join(root, artifact.os === 'windows' ? 'happier.exe' : 'happier'),
    args: ['--help'],
    cwd: root,
    env,
    timeoutMs,
  });
  if (nativeHelp.timedOut === true) {
    throw new Error(`[release] native CLI help smoke timed out for ${archivePath}: ${formatSmokeOutput(nativeHelp)}`);
  }
  if ((nativeHelp.status ?? 1) !== 0) {
    throw new Error(`[release] native CLI help smoke failed for ${archivePath}: ${formatSmokeOutput(nativeHelp)}`);
  }
  await assertBaseCliProjection({ root, targetOs: artifact.os });
  const packageDistEntrypoint = join(root, 'package-dist', 'index.mjs');
  if (!await fileExists(packageDistEntrypoint)) {
    throw new Error(`[release] missing base CLI package-dist entrypoint in ${archivePath}`);
  }
  const packageDistVersion = await runSmokeCommand({
    command: process.execPath,
    args: [packageDistEntrypoint, '--version'],
    cwd: root,
    env,
    timeoutMs,
  });
  if (packageDistVersion.timedOut === true) {
    throw new Error(`[release] package-dist version smoke timed out for ${archivePath}: ${formatSmokeOutput(packageDistVersion)}`);
  }
  if ((packageDistVersion.status ?? 1) !== 0) {
    throw new Error(`[release] package-dist version smoke failed for ${archivePath}: ${formatSmokeOutput(packageDistVersion)}`);
  }
  const actualPackageDistVersion = String(packageDistVersion.stdout ?? '').trim();
  if (actualPackageDistVersion !== artifact.version) {
    throw new Error(
      `[release] package-dist version mismatch for ${archivePath}: expected ${artifact.version}, got ${actualPackageDistVersion || '<empty>'}`,
    );
  }

  const runRequiredTool = async ({ label, command, args, expectedOutput }) => {
    if (!await fileExists(command)) {
      throw new Error(`[release] missing packaged ${label} in ${archivePath}`);
    }
    const result = await runSmokeCommand({ command, args, cwd: root, env, timeoutMs });
    if (result.timedOut === true) {
      throw new Error(`[release] packaged ${label} smoke timed out for ${archivePath}: ${formatSmokeOutput(result)}`);
    }
    if ((result.status ?? 1) !== 0) {
      throw new Error(`[release] packaged ${label} smoke failed for ${archivePath}: ${formatSmokeOutput(result)}`);
    }
    const output = formatSmokeOutput(result);
    if (!output.includes(expectedOutput)) {
      throw new Error(`[release] packaged ${label} smoke returned unexpected output for ${archivePath}: ${output || '<empty>'}`);
    }
  };

  const rgPath = join(root, 'tools', 'unpacked', artifact.os === 'windows' ? 'rg.exe' : 'rg');
  await runRequiredTool({
    label: 'rg --version',
    command: rgPath,
    args: ['--version'],
    expectedOutput: 'ripgrep',
  });
  const rgNeedle = 'happier-release-rg-smoke';
  const rgFixturePath = join(scratch, 'rg-smoke.txt');
  await writeFile(rgFixturePath, `${rgNeedle}\n`);
  await runRequiredTool({
    label: 'rg search',
    command: rgPath,
    args: ['--fixed-strings', rgNeedle, rgFixturePath],
    expectedOutput: rgNeedle,
  });

  if (artifact.os !== 'windows') {
    await runRequiredTool({
      label: 'zellij --version',
      command: join(root, 'tools', 'unpacked', 'zellij'),
      args: ['--version'],
      expectedOutput: 'zellij',
    });
  }

  const runtime = await runSmokeCommand({
    command: process.execPath,
    args: [
      '--input-type=module',
      '-e',
      createBaseCliRuntimeSmokeSource({ root, scratch, targetOs: artifact.os }),
    ],
    cwd: root,
    env,
    timeoutMs,
  });
  if (runtime.timedOut === true) {
    throw new Error(`[release] base CLI runtime smoke timed out for ${archivePath}: ${formatSmokeOutput(runtime)}`);
  }
  if ((runtime.status ?? 1) !== 0) {
    throw new Error(`[release] base CLI runtime smoke failed for ${archivePath}: ${formatSmokeOutput(runtime)}`);
  }
}

export async function smokeTestArchive({ archivePath, execute = true }) {
  // Opaque publishers install release-runtime only. Binary extraction and smoke
  // still use the canonical runtime owner, but only when a binary is verified.
  const { extractReleasePayloadRootFromArchive, getFirstPartyComponentCatalogEntry } =
    await import('@happier-dev/cli-common/firstPartyRuntime');
  const artifact = parseArtifactFilename(basename(archivePath));
  const scratch = await mkdtemp(join(tmpdir(), 'happier-release-smoke-'));
  try {
    const root = await extractReleasePayloadRootFromArchive({
      archivePath, archiveName: basename(archivePath), extractDir: join(scratch, 'extract'),
    });
    const component = getFirstPartyComponentCatalogEntry(artifact.product === 'happier' ? 'happier-cli' : artifact.product);
    const memoryRuntime = artifact.product === 'happier-memory-runtime';
    const candidate = memoryRuntime
      ? component.nodeEntrypointRelativePath
      : `${component.binaryRelativePath}${artifact.os === 'windows' ? '.exe' : ''}`;
    if (!await fileExists(join(root, candidate))) {
      throw new Error(`[release] missing component entrypoint ${candidate} in ${archivePath}`);
    }
    if (!execute || !shouldSmokeTestReleaseArtifact({ archiveName: basename(archivePath) })) return;
    const binPath = join(root, candidate);
    const serverBinary = isServerBinaryCandidate(candidate);
    const args = memoryRuntime ? ['--input-type=module', '-e', `
      const { Tensor, env } = await import(${JSON.stringify(pathToFileURL(binPath).href)});
      env.allowRemoteModels = false;
      const tensor = new Tensor('float32', new Float32Array([1, 2]), [2]);
      if (tensor.data[1] !== 2 || tensor.dims[0] !== 2) throw new Error('Invalid Transformers/ONNX tensor');
    `] : serverBinary ? [] : ['--version'];
    const env = { ...process.env };
    delete env.NODE_PATH;
    if (serverBinary) {
      env.PORT = '0';
      env.METRICS_PORT = '0';
      env.HAPPIER_SERVER_LIGHT_DATA_DIR = join(scratch, 'server-light-data');
    }
    const result = await runSmokeCommand({
      command: memoryRuntime ? process.execPath : binPath,
      args,
      cwd: root,
      env,
      timeoutMs: resolveArtifactSmokeTimeoutMs({ serverBinary }),
    });
    const timedOut = result.timedOut === true;
    if (timedOut) {
      const output = formatSmokeOutput(result);
      if (serverBinary) {
        if (/ERR_MODULE_NOT_FOUND|Cannot find module/i.test(output)) {
          throw new Error(`[release] smoke test failed for ${archivePath}: ${output.trim()}`);
        }
        return;
      }
      throw new Error(`[release] smoke test timed out for ${archivePath}: ${output.trim()}`);
    }
    if ((result.status ?? 1) !== 0) {
      throw new Error(`[release] smoke test failed for ${archivePath}: ${formatSmokeOutput(result)}`);
    }
    if (serverBinary) {
      throw new Error(`[release] server binary exited before the smoke window for ${archivePath}`);
    }
    if (artifact?.product === 'happier') {
      const actualVersion = String(result.stdout ?? '').trim();
      if (actualVersion !== artifact.version) {
        throw new Error(
          `[release] CLI version mismatch for ${archivePath}: expected ${artifact.version}, got ${actualVersion || '<empty>'}`,
        );
      }
      await runBaseCliRuntimeSmoke({ root, scratch, artifact, archivePath, env });
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function main() {
  const { kv, flags } = parseArgs(process.argv.slice(2));
  const artifactsDir = resolve(String(kv.get('--artifacts-dir') ?? '').trim() || join(process.cwd(), 'dist', 'release-assets'));
  const checksumsPathInput = String(kv.get('--checksums') ?? '').trim();
  let checksumsPath = checksumsPathInput;
  if (!checksumsPath) {
    const candidates = (await readdir(artifactsDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^checksums-.+\.txt$/.test(entry.name));
    if (candidates.length > 1) {
      throw new Error(`[release] multiple checksums files found in ${artifactsDir}; specify --checksums`);
    }
    if (candidates.length === 1) checksumsPath = join(artifactsDir, candidates[0].name);
  }
  if (!checksumsPath) {
    throw new Error(`[release] no checksums file found in ${artifactsDir}`);
  }

  const checksumsRaw = await readFile(checksumsPath, 'utf-8');
  const entries = parseChecksums(checksumsRaw);
  if (flags.has('--require-all-artifacts-checksummed')) {
    const checksummedNames = new Set(entries.map((entry) => entry.name));
    const uncoveredArtifacts = (await readdir(artifactsDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && isBinaryReleaseArtifactFilename(entry.name) && !checksummedNames.has(entry.name))
      .map((entry) => entry.name);
    if (uncoveredArtifacts.length > 0) {
      throw new Error(`[release] artifacts not checksummed: ${uncoveredArtifacts.join(', ')}`);
    }
  }
  for (const entry of entries) {
    const path = join(artifactsDir, entry.name);
    const hash = await fileSha256(path);
    if (hash !== entry.sha256) {
      throw new Error(`[release] checksum mismatch for ${entry.name}`);
    }
  }

  const minisigPath = `${checksumsPath}.minisig`;
  const pubKeyPath = String(kv.get('--public-key') ?? process.env.MINISIGN_PUBLIC_KEY ?? '').trim();
  const signatureExists = await fileExists(minisigPath);
  if (flags.has('--require-signature') && !signatureExists) {
    throw new Error(`[release] required minisign signature is missing: ${minisigPath}`);
  }
  const pubkeyFile = pubKeyPath ? await readFile(pubKeyPath, 'utf8') : '';
  if (signatureExists) {
    if (!pubKeyPath) {
      throw new Error('[release] signature found but no --public-key/MINISIGN_PUBLIC_KEY provided');
    }
    await verifyChecksumSignature({ checksumsPath, pubkeyFile });
  }

  const skipOptionalSmoke = flags.has('--skip-smoke');
  const cliVersionAttestations = [];
  const baseCliRuntimeSmokes = [];
  const verifiedArchives = [];
  const componentEnvelopes = new Map();
  const assets = entries.map((entry) => ({ name: entry.name, url: pathToFileURL(join(artifactsDir, entry.name)).href }));
  for (const entry of entries) {
    const artifact = parseArtifactFilename(entry.name);
    if (!artifact) continue;
    if (CLI_OPTIONAL_COMPONENT_PRODUCTS.includes(artifact.product)) {
      const bundle = resolveReleaseAssetBundle({ assets, product: artifact.product, os: artifact.os, arch: artifact.arch });
      if (bundle.archive.name !== entry.name) throw new Error(`[release] component bundle mismatch for ${entry.name}`);
      if (!componentEnvelopes.has(bundle.checksums.name)) {
        const text = await verifyChecksumSignature({ checksumsPath: join(artifactsDir, bundle.checksums.name), pubkeyFile });
        componentEnvelopes.set(bundle.checksums.name, text);
      }
      const expected = lookupSha256({ checksumsText: componentEnvelopes.get(bundle.checksums.name), filename: entry.name });
      if (expected !== entry.sha256) throw new Error(`[release] component checksum mismatch for ${entry.name}`);
    }
    const compatible = shouldSmokeTestReleaseArtifact({ archiveName: entry.name });
    const requiresCliVersionAttestation = compatible && artifact.product === 'happier';
    await smokeTestArchive({ archivePath: join(artifactsDir, entry.name), execute: compatible && (!skipOptionalSmoke || requiresCliVersionAttestation) });
    verifiedArchives.push(entry.name);
    if (requiresCliVersionAttestation) {
      cliVersionAttestations.push(entry.name);
      baseCliRuntimeSmokes.push(entry.name);
    }
  }

  console.log(JSON.stringify({
    ok: true,
    artifactsDir,
    checksumsPath,
    verified: entries.map((entry) => entry.name),
    smoke: !skipOptionalSmoke,
    cliVersionAttestations,
    baseCliRuntimeSmokes,
    verifiedArchives,
    verifiedComponentEnvelopes: [...componentEnvelopes.keys()],
  }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
