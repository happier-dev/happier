import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  ensureManagedJavaScriptRuntimeCommand,
  ensureManagedPnpmCommand,
  installProviderCli,
  managedJavaScriptRuntimeBinPath,
  managedPnpmBinPath,
  planProviderCliInstall,
  resolvePlatformFromNodePlatform,
  resolveProviderCliCommand,
  resolveExistingManagedJavaScriptRuntimeCommand,
  resolveProviderCliManagedCommandPath,
  resolveExistingPnpmCommand,
} from '../dist/providers/index.js';
import { resolveCodexReleaseAsset } from '../dist/providers/codexRelease.js';
import { resolvePnpmReleaseAsset } from '../dist/providers/pnpmRelease.js';

function currentProviderInstallPlatform() {
  const platform = resolvePlatformFromNodePlatform(process.platform);
  if (!platform) {
    throw new Error(`Unsupported test platform: ${process.platform}`);
  }
  return platform;
}

function currentCodexReleaseAssetName() {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'codex-aarch64-apple-darwin.tar.gz';
  if (process.platform === 'darwin' && process.arch === 'x64') return 'codex-x86_64-apple-darwin.tar.gz';
  if (process.platform === 'linux' && process.arch === 'arm64') return 'codex-aarch64-unknown-linux-musl.tar.gz';
  if (process.platform === 'linux' && process.arch === 'x64') return 'codex-x86_64-unknown-linux-musl.tar.gz';
  if (process.platform === 'win32' && process.arch === 'arm64') return 'codex-aarch64-pc-windows-msvc.exe.zip';
  if (process.platform === 'win32' && process.arch === 'x64') return 'codex-x86_64-pc-windows-msvc.exe.zip';
  throw new Error(`Unsupported test arch: ${process.platform}/${process.arch}`);
}

function currentPnpmReleaseAssetName() {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'pnpm-macos-arm64';
  if (process.platform === 'darwin' && process.arch === 'x64') return 'pnpm-macos-x64';
  if (process.platform === 'linux' && process.arch === 'arm64') return 'pnpm-linuxstatic-arm64';
  if (process.platform === 'linux' && process.arch === 'x64') return 'pnpm-linuxstatic-x64';
  if (process.platform === 'win32' && process.arch === 'arm64') return 'pnpm-win-arm64.exe';
  if (process.platform === 'win32' && process.arch === 'x64') return 'pnpm-win-x64.exe';
  throw new Error(`Unsupported test arch: ${process.platform}/${process.arch}`);
}

function sha256Digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

async function withPlatform(platform, run) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  if (!descriptor) return await run();

  Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
}

async function createWindowsCommandShimFixture({ commandName, commandBody }) {
  const dir = await mkdtemp(join(tmpdir(), 'happier-cli-common-provider-winshim-'));
  const binDir = join(dir, 'bin');
  await mkdir(binDir, { recursive: true });

  const nodeExecPath = process.execPath.replace(/\\/g, '\\\\');
  const cmdExePath = join(binDir, 'cmd.exe');
  const wherePath = join(binDir, 'where');
  const commandPath = join(binDir, commandName);

  const cmdExeScript = `#!${nodeExecPath}
const cp = require('node:child_process');

function splitCommandLine(raw) {
  const tokens = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < raw.length; i += 1) {
    let ch = raw[i];
    if (ch === '^' && i + 1 < raw.length) {
      const next = raw[i + 1];
      i += 1;
      if (next === ' ' || next === '\\t') {
        current += next;
        continue;
      }
      ch = next;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && (ch === ' ' || ch === '\\t')) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

const args = process.argv.slice(2);
const cIndex = args.findIndex((a) => String(a).toLowerCase() === '/c');
const rest = cIndex === -1 ? [] : args.slice(cIndex + 1);
if (rest.length === 0) process.exit(1);

let commandLine = rest.join(' ');
if (rest.length === 1) commandLine = rest[0];
if (commandLine.startsWith('"') && commandLine.endsWith('"')) commandLine = commandLine.slice(1, -1);

const tokens = splitCommandLine(commandLine);
if (tokens.length === 0) process.exit(1);

const command = tokens[0];
const commandArgs = tokens.slice(1);
const child = cp.spawn(command, commandArgs, { stdio: 'inherit', env: process.env });

child.on('exit', (code) => process.exit(code ?? 1));
child.on('error', () => process.exit(127));
`;

  const whereScript = `#!${nodeExecPath}
const name = process.argv[2];
if (name === ${JSON.stringify(commandName.replace(/\\.cmd$/i, '').replace(/\\.exe$/i, ''))}) process.exit(0);
process.exit(1);
`;

  await writeFile(cmdExePath, cmdExeScript, 'utf8');
  await chmod(cmdExePath, 0o755);
  await writeFile(wherePath, whereScript, 'utf8');
  await chmod(wherePath, 0o755);
  await writeFile(commandPath, commandBody, 'utf8');
  await chmod(commandPath, 0o755);

  return {
    dir,
    binDir,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('planProviderCliInstall returns source-aware plans for claude/codex/gemini', () => {
  const claude = planProviderCliInstall({ providerId: 'claude', platform: 'darwin' });
  assert.equal(claude.ok, true);
  assert.equal(claude.plan.installMode, 'vendor_recipe');
  assert.ok(JSON.stringify(claude.plan.commands).includes('claude.ai/install.sh'));

  const codex = planProviderCliInstall({ providerId: 'codex', platform: 'linux' });
  assert.equal(codex.ok, true);
  assert.equal(codex.plan.installMode, 'github_release_binary');
  assert.equal(codex.plan.commands.length, 0);

  const gemini = planProviderCliInstall({ providerId: 'gemini', platform: 'win32' });
  assert.equal(gemini.ok, true);
  assert.equal(gemini.plan.installMode, 'managed_package');
  assert.equal(gemini.plan.commands.length, 0);
});

test('planProviderCliInstall uses managed-package installs for qwen', () => {
  const qwen = planProviderCliInstall({ providerId: 'qwen', platform: 'win32' });
  assert.equal(qwen.ok, true);
  assert.equal(qwen.plan.installMode, 'managed_package');
  assert.equal(qwen.plan.commands.length, 0);
});

test('resolvePlatformFromNodePlatform maps supported node platforms and rejects unsupported ones', () => {
  assert.equal(resolvePlatformFromNodePlatform('darwin'), 'darwin');
  assert.equal(resolvePlatformFromNodePlatform('linux'), 'linux');
  assert.equal(resolvePlatformFromNodePlatform('win32'), 'win32');
  assert.equal(resolvePlatformFromNodePlatform('freebsd'), null);
});

test('resolveCodexReleaseAsset parses versions from normal release tags', () => {
  const resolved = resolveCodexReleaseAsset({
    tag_name: 'rust-v0.111.0',
    assets: [{
      name: currentCodexReleaseAssetName(),
      browser_download_url: 'https://example.invalid/codex.tar.gz',
      digest: 'sha256:deadbeef',
    }],
  });

  assert.equal(resolved.version, '0.111.0');
});

test('resolveCodexReleaseAsset rejects selected assets without a digest', () => {
  assert.throws(() => resolveCodexReleaseAsset({
    tag_name: 'rust-v0.111.0',
    assets: [{ name: currentCodexReleaseAssetName(), browser_download_url: 'https://example.invalid/codex.tar.gz' }],
  }), /digest/i);
});

test('resolvePnpmReleaseAsset parses versions from normal release tags', () => {
  const resolved = resolvePnpmReleaseAsset({
    tag_name: 'v10.2.1',
    assets: [{ name: currentPnpmReleaseAssetName(), browser_download_url: 'https://example.invalid/pnpm-bin', digest: sha256Digest('pnpm-binary') }],
  });

  assert.equal(resolved.version, '10.2.1');
});

test('ensureManagedPnpmCommand forwards the caller-provided GitHub token during bootstrap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happier-managed-pnpm-token-'));
  const originalProcessToken = process.env.GITHUB_TOKEN;
  const calls = [];
  try {
    const env = {
      ...process.env,
      HAPPIER_HOME_DIR: join(dir, 'home'),
      PATH: '',
      GITHUB_TOKEN: 'scoped-token',
    };
    process.env.GITHUB_TOKEN = 'global-token';

    const command = await ensureManagedPnpmCommand(env, {
      fetchGitHubLatestRelease: async (params) => {
        calls.push(params);
        return {
          tag_name: 'v10.2.1',
          assets: [{ name: currentPnpmReleaseAssetName(), browser_download_url: 'https://example.invalid/pnpm-bin', digest: sha256Digest('pnpm-binary') }],
        };
      },
      downloadGitHubReleaseAsset: async ({ destinationPath }) => {
        await writeFile(destinationPath, 'pnpm-binary', 'utf8');
      },
    });

    assert.equal(command, managedPnpmBinPath(env));
    assert.equal(calls[0]?.githubToken, 'scoped-token');
  } finally {
    if (originalProcessToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalProcessToken;
    await rm(dir, { recursive: true, force: true });
  }
});

test('ensureManagedPnpmCommand replaces a non-executable managed pnpm binary instead of falling back to PATH', async () => {
  if (process.platform === 'win32') {
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'happier-managed-pnpm-fallback-'));
  const originalFetch = globalThis.fetch;
  try {
    const homeDir = join(dir, 'home');
    const binDir = join(dir, 'bin');
    await mkdir(homeDir, { recursive: true });
    await mkdir(binDir, { recursive: true });

    const managedPath = managedPnpmBinPath({ ...process.env, HAPPIER_HOME_DIR: homeDir });
    await mkdir(dirname(managedPath), { recursive: true });
    await writeFile(managedPath, '#!/bin/sh\necho stale\n', 'utf8');
    await chmod(managedPath, 0o644);

    const pathPnpm = join(binDir, 'pnpm');
    await writeFile(pathPnpm, '#!/bin/sh\necho real\n', 'utf8');
    await chmod(pathPnpm, 0o755);

    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/releases/latest')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            tag_name: 'v10.2.1',
            assets: [{ name: currentPnpmReleaseAssetName(), browser_download_url: 'https://example.invalid/pnpm-bin', digest: sha256Digest('managed-pnpm') }],
          }),
        };
      }

      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new TextEncoder().encode('managed-pnpm').buffer,
      };
    };

    const command = await ensureManagedPnpmCommand({
      ...process.env,
      HAPPIER_HOME_DIR: homeDir,
      PATH: binDir,
    });

    assert.equal(command, managedPnpmBinPath({ ...process.env, HAPPIER_HOME_DIR: homeDir }));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('ensureManagedPnpmCommand bootstraps a managed pnpm binary even when PATH already contains pnpm', async () => {
  if (process.platform === 'win32') {
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'happier-managed-pnpm-prefers-managed-'));
  const originalFetch = globalThis.fetch;
  try {
    const homeDir = join(dir, 'home');
    const binDir = join(dir, 'bin');
    await mkdir(homeDir, { recursive: true });
    await mkdir(binDir, { recursive: true });

    const pathPnpm = join(binDir, 'pnpm');
    await writeFile(pathPnpm, '#!/bin/sh\necho path-pnpm\n', 'utf8');
    await chmod(pathPnpm, 0o755);

    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/releases/latest')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            tag_name: 'v10.2.1',
            assets: [{ name: currentPnpmReleaseAssetName(), browser_download_url: 'https://example.invalid/pnpm-bin', digest: sha256Digest('managed-pnpm') }],
          }),
        };
      }

      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new TextEncoder().encode('managed-pnpm').buffer,
      };
    };

    const env = {
      ...process.env,
      HAPPIER_HOME_DIR: homeDir,
      PATH: binDir,
    };

    const command = await ensureManagedPnpmCommand(env);

    assert.equal(command, managedPnpmBinPath(env));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('ensureManagedPnpmCommand fails closed for an invalid explicit override instead of bootstrapping or falling back', async () => {
  if (process.platform === 'win32') {
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'happier-managed-pnpm-invalid-override-'));
  try {
    const overridePath = join(dir, 'pnpm');
    await writeFile(overridePath, '#!/bin/sh\necho fake\n', 'utf8');
    await chmod(overridePath, 0o644);

    const pathDir = join(dir, 'path');
    await mkdir(pathDir, { recursive: true });
    const pathPnpm = join(pathDir, 'pnpm');
    await writeFile(pathPnpm, '#!/bin/sh\necho path-pnpm\n', 'utf8');
    await chmod(pathPnpm, 0o755);

    const fetchCalls = [];
    const command = await ensureManagedPnpmCommand({
      ...process.env,
      HAPPIER_HOME_DIR: join(dir, 'home'),
      HAPPIER_PNPM_BIN: overridePath,
      PATH: pathDir,
    }, {
      fetchGitHubLatestRelease: async () => {
        fetchCalls.push('bootstrapped');
        throw new Error('should not bootstrap managed pnpm when explicit override is invalid');
      },
    });

    assert.equal(command, null);
    assert.deepEqual(fetchCalls, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ensureManagedJavaScriptRuntimeCommand installs a managed Node runtime and creates a wrapper that delegates to it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happier-managed-js-runtime-'));
  try {
    const homeDir = join(dir, 'home');
    await mkdir(homeDir, { recursive: true });
    const expectedScratchRoot = join(homeDir, 'tools', 'js-runtime', '.tmp');
    let downloadedArchivePath = null;

    const env = {
      ...process.env,
      HAPPIER_HOME_DIR: homeDir,
      PATH: '',
    };

    const command = await ensureManagedJavaScriptRuntimeCommand(env, {
      fetchNodeRuntimeReleaseAsset: async () => ({
        name: process.platform === 'win32' ? 'node-v25.8.0-win-x64.zip' : 'node-v25.8.0-linux-x64.tar.gz',
        url: 'https://nodejs.org/download/release/v25.8.0/fake-node-archive',
        digest: 'sha256:deadbeef',
        tag: 'v25.8.0',
        version: '25.8.0',
        binaryRelativePath: process.platform === 'win32' ? 'node.exe' : join('bin', 'node'),
      }),
      downloadGitHubReleaseAsset: async ({ destinationPath }) => {
        downloadedArchivePath = destinationPath;
        await writeFile(destinationPath, 'fake archive payload', 'utf8');
      },
      extractGitHubReleaseAsset: async ({ outputPath }) => {
        const nodeBinaryPath =
          process.platform === 'win32' ? join(outputPath, 'node.exe') : join(outputPath, 'bin', 'node');
        await mkdir(dirname(nodeBinaryPath), { recursive: true });
        await writeFile(nodeBinaryPath, process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n', 'utf8');
        if (process.platform !== 'win32') {
          await chmod(nodeBinaryPath, 0o755);
        }
      },
    });
    assert.equal(command, managedJavaScriptRuntimeBinPath(env));
    assert.equal(downloadedArchivePath?.startsWith(expectedScratchRoot), true);

    const wrapper = await readFile(command, 'utf8');
    assert.doesNotMatch(wrapper, /pnpm|fake-pnpm/);
    assert.match(wrapper, /runtime/);
    assert.match(wrapper, /node(?:\.exe)?/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ensureManagedJavaScriptRuntimeCommand serializes concurrent first-run bootstraps', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happier-managed-js-runtime-concurrent-'));
  try {
    const homeDir = join(dir, 'home');
    await mkdir(homeDir, { recursive: true });

    const env = {
      ...process.env,
      HAPPIER_HOME_DIR: homeDir,
      PATH: '',
    };

    let fetchCalls = 0;
    let releaseGateResolve;
    const releaseGate = new Promise((resolve) => {
      releaseGateResolve = resolve;
    });

    const deps = {
      fetchNodeRuntimeReleaseAsset: async () => {
        fetchCalls += 1;
        if (fetchCalls === 1) {
          await releaseGate;
        }
        return {
          name: process.platform === 'win32' ? 'node-v25.8.0-win-x64.zip' : 'node-v25.8.0-linux-x64.tar.gz',
          url: 'https://nodejs.org/download/release/v25.8.0/fake-node-archive',
          digest: 'sha256:deadbeef',
          tag: 'v25.8.0',
          version: '25.8.0',
          binaryRelativePath: process.platform === 'win32' ? 'node.exe' : join('bin', 'node'),
        };
      },
      downloadGitHubReleaseAsset: async ({ destinationPath }) => {
        await writeFile(destinationPath, 'fake archive payload', 'utf8');
      },
      extractGitHubReleaseAsset: async ({ outputPath }) => {
        const nodeBinaryPath =
          process.platform === 'win32' ? join(outputPath, 'node.exe') : join(outputPath, 'bin', 'node');
        await mkdir(dirname(nodeBinaryPath), { recursive: true });
        await writeFile(nodeBinaryPath, process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n', 'utf8');
        if (process.platform !== 'win32') {
          await chmod(nodeBinaryPath, 0o755);
        }
      },
    };

    const firstInstall = ensureManagedJavaScriptRuntimeCommand(env, deps);
    const secondInstall = ensureManagedJavaScriptRuntimeCommand(env, deps);
    releaseGateResolve();

    const [firstCommand, secondCommand] = await Promise.all([firstInstall, secondInstall]);

    assert.equal(firstCommand, managedJavaScriptRuntimeBinPath(env));
    assert.equal(secondCommand, managedJavaScriptRuntimeBinPath(env));
    assert.equal(fetchCalls, 1);
    assert.equal(existsSync(join(homeDir, 'tools', 'js-runtime', 'next')), false);
    assert.equal(existsSync(join(homeDir, 'tools', 'js-runtime', '.lock', 'bootstrap.lock')), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('installProviderCli runs vendor recipe commands on Windows', async () => {
  const fixture = await createWindowsCommandShimFixture({
    commandName: 'powershell',
    commandBody: `#!${process.execPath.replace(/\\/g, '\\\\')}
process.exit(0);
`,
  });
  try {
    await withPlatform('win32', async () => {
      const res = await installProviderCli({
        providerId: 'claude',
        platform: 'win32',
        skipIfInstalled: false,
        allowVendorRecipeExecution: true,
        env: {
          PATH: fixture.binDir,
          PATHEXT: '.CMD;.EXE',
          ComSpec: 'cmd.exe',
        },
      });
      assert.equal(res.ok, true);
    });
  } finally {
    await fixture.cleanup();
  }
});

test('installProviderCli gives vendor recipes a managed scratch TMPDIR on Unix', async () => {
  if (process.platform === 'win32') {
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'happier-provider-install-vendor-tmpdir-'));
  try {
    const homeDir = join(dir, 'home');
    const binDir = join(dir, 'bin');
    const envLogPath = join(dir, 'vendor-env.log');
    const expectedScratchRoot = join(homeDir, 'tools', 'providers', 'opencode', '.tmp');
    await mkdir(homeDir, { recursive: true });
    await mkdir(binDir, { recursive: true });

    const bashPath = join(binDir, 'bash');
    await writeFile(
      bashPath,
      `#!/bin/sh
printf '%s\\n' "${'${TMPDIR:-}'}" > ${JSON.stringify(envLogPath)}
exit 0
`,
      'utf8',
    );
    await chmod(bashPath, 0o755);

    const res = await installProviderCli({
      providerId: 'opencode',
      platform: 'linux',
      skipIfInstalled: false,
      allowVendorRecipeExecution: true,
      env: {
        ...process.env,
        HAPPIER_HOME_DIR: homeDir,
        PATH: `${binDir}${process.platform === 'win32' ? ';' : ':'}/bin`,
      },
    });

    assert.equal(res.ok, true);
    const loggedTmpDir = (await readFile(envLogPath, 'utf8')).trim();
    assert.equal(loggedTmpDir.startsWith(expectedScratchRoot), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('installProviderCli prepends common and provider-specific user bin dirs for vendor recipes on Unix', async () => {
  if (process.platform === 'win32') {
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'happier-provider-install-vendor-path-'));
  try {
    const homeDir = join(dir, 'home');
    const binDir = join(dir, 'bin');
    const envLogPath = join(dir, 'vendor-path.log');
    await mkdir(homeDir, { recursive: true });
    await mkdir(binDir, { recursive: true });

    const bashPath = join(binDir, 'bash');
    await writeFile(
      bashPath,
      `#!/bin/sh
printf '%s\\n' "${'${PATH:-}'}" > ${JSON.stringify(envLogPath)}
exit 0
`,
      'utf8',
    );
    await chmod(bashPath, 0o755);

    const res = await installProviderCli({
      providerId: 'opencode',
      platform: 'linux',
      skipIfInstalled: false,
      allowVendorRecipeExecution: true,
      env: {
        ...process.env,
        HAPPIER_HOME_DIR: homeDir,
        HOME: homeDir,
        PATH: `${binDir}:/bin`,
      },
    });

    assert.equal(res.ok, true);
    const loggedPath = (await readFile(envLogPath, 'utf8')).trim();
    const entries = loggedPath.split(':');
    assert.equal(entries[0], join(homeDir, '.local', 'bin'));
    assert.equal(entries[1], join(homeDir, '.opencode', 'bin'));
    assert.ok(entries.includes(binDir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('installProviderCli treats vendor recipe exits as success when the CLI becomes resolvable anyway', async () => {
  if (process.platform === 'win32') {
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'happier-provider-install-vendor-nonzero-success-'));
  try {
    const homeDir = join(dir, 'home');
    const binDir = join(dir, 'bin');
    const installedCliPath = join(homeDir, '.local', 'bin', 'claude');
    await mkdir(homeDir, { recursive: true });
    await mkdir(binDir, { recursive: true });

    const bashPath = join(binDir, 'bash');
    await writeFile(
      bashPath,
      `#!/bin/sh
mkdir -p ${JSON.stringify(dirname(installedCliPath))}
cat > ${JSON.stringify(installedCliPath)} <<'EOF'
#!/bin/sh
echo installed claude "$@"
EOF
chmod +x ${JSON.stringify(installedCliPath)}
exit 1
`,
      'utf8',
    );
    await chmod(bashPath, 0o755);

    const res = await installProviderCli({
      providerId: 'claude',
      platform: 'linux',
      skipIfInstalled: false,
      allowVendorRecipeExecution: true,
      env: {
        ...process.env,
        HAPPIER_HOME_DIR: homeDir,
        HOME: homeDir,
        PATH: `${binDir}:/bin`,
      },
    });

    assert.equal(res.ok, true);
    assert.equal(res.alreadyInstalled, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('installProviderCli times out vendor recipe execution instead of hanging indefinitely', async () => {
  if (process.platform === 'win32') {
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'happier-provider-install-vendor-timeout-'));
  try {
    const homeDir = join(dir, 'home');
    const binDir = join(dir, 'bin');
    await mkdir(homeDir, { recursive: true });
    await mkdir(binDir, { recursive: true });

    const bashPath = join(binDir, 'bash');
    await writeFile(
      bashPath,
      '#!/bin/sh\nsleep 10\n',
      'utf8',
    );
    await chmod(bashPath, 0o755);

    const res = await installProviderCli({
      providerId: 'claude',
      platform: 'linux',
      skipIfInstalled: false,
      allowVendorRecipeExecution: true,
      env: {
        ...process.env,
        HAPPIER_HOME_DIR: homeDir,
        HOME: homeDir,
        PATH: `${binDir}:/bin`,
        HAPPIER_VENDOR_INSTALL_TIMEOUT_MS: '250',
      },
    });

    assert.equal(res.ok, false);
    assert.equal(res.errorCode, 'command-timed-out');
    assert.match(res.errorMessage, /timed out/i);
    assert.equal(typeof res.logPath, 'string');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('installProviderCli writes default install logs under HAPPIER_HOME instead of tmpdir', async () => {
  if (process.platform === 'win32') {
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'happier-provider-install-log-path-'));
  try {
    const homeDir = join(dir, 'home');
    const binDir = join(dir, 'bin');
    const expectedLogRoot = join(homeDir, 'logs', 'provider-installs');
    await mkdir(homeDir, { recursive: true });
    await mkdir(binDir, { recursive: true });

    const bashPath = join(binDir, 'bash');
    await writeFile(bashPath, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(bashPath, 0o755);

    const res = await installProviderCli({
      providerId: 'opencode',
      platform: 'linux',
      skipIfInstalled: false,
      allowVendorRecipeExecution: true,
      env: {
        ...process.env,
        HAPPIER_HOME_DIR: homeDir,
        PATH: `${binDir}:/bin`,
      },
    });

    assert.equal(res.ok, true);
    assert.equal((res.logPath ?? '').startsWith(expectedLogRoot), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('installProviderCli installs managed package-backed CLIs into the managed provider path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happier-provider-install-managed-package-'));
  try {
    const homeDir = join(dir, 'home');
    const pnpmPath = join(dir, 'fake-pnpm');
    const pnpmLogPath = join(dir, 'pnpm.log');
    const runtimeDir = join(dir, 'runtime-bin');
    const runtimePath = join(runtimeDir, process.platform === 'win32' ? 'node.exe' : 'node');
    await mkdir(homeDir, { recursive: true });
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(
      pnpmPath,
      `#!/bin/sh
printf '%s\\n' "$@" >> ${JSON.stringify(pnpmLogPath)}
exit 0
`,
      'utf8',
    );
    await chmod(pnpmPath, 0o755);
    await writeFile(runtimePath, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(runtimePath, 0o755);

    const result = await installProviderCli({
      providerId: 'gemini',
      platform: 'linux',
      skipIfInstalled: false,
      env: {
        ...process.env,
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_PNPM_BIN: pnpmPath,
        HAPPIER_JS_RUNTIME_PATH: runtimePath,
        PATH: '',
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.plan.installMode, 'managed_package');

    const managedPath = resolveProviderCliManagedCommandPath('gemini', { happyHomeDir: homeDir });
    const wrapper = await readFile(managedPath, 'utf8');
    assert.match(wrapper, /pnpm.*exec/);
    assert.match(wrapper, /exec\s+"gemini"/);
    assert.doesNotMatch(wrapper, /\/next\/workspace/);
    assert.match(wrapper, /\/current\/workspace/);
    assert.match(wrapper, new RegExp(runtimeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const pnpmLog = await readFile(pnpmLogPath, 'utf8');
    assert.match(pnpmLog, /add/);
    assert.match(pnpmLog, /@google\/gemini-cli/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('installProviderCli bootstraps a managed JavaScript runtime for managed package-backed CLIs when no explicit runtime override exists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happier-provider-install-managed-package-runtime-'));
  try {
    const homeDir = join(dir, 'home');
    const pnpmPath = join(dir, 'fake-pnpm');
    const pnpmLogPath = join(dir, 'pnpm.log');
    const managedRuntimeWrapperPath = managedJavaScriptRuntimeBinPath({ ...process.env, HAPPIER_HOME_DIR: homeDir });
    const managedRuntimeNodeDir = join(dirname(managedRuntimeWrapperPath), '..', 'runtime', process.platform === 'win32' ? '' : 'bin');
    const managedRuntimeNodePath = join(managedRuntimeNodeDir, process.platform === 'win32' ? 'node.exe' : 'node');
    await mkdir(homeDir, { recursive: true });
    await mkdir(dirname(managedRuntimeNodePath), { recursive: true });
    await writeFile(
      pnpmPath,
      `#!/bin/sh
printf '%s\\n' "$@" >> ${JSON.stringify(pnpmLogPath)}
exit 0
`,
      'utf8',
    );
    await chmod(pnpmPath, 0o755);
    await writeFile(managedRuntimeNodePath, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(managedRuntimeNodePath, 0o755);

    const result = await installProviderCli({
      providerId: 'gemini',
      platform: 'linux',
      skipIfInstalled: false,
      env: {
        ...process.env,
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_PNPM_BIN: pnpmPath,
        PATH: '',
      },
      deps: {
        ensureManagedJavaScriptRuntimeCommand: async () => managedRuntimeWrapperPath,
      },
    });

    assert.equal(result.ok, true);
    const managedPath = resolveProviderCliManagedCommandPath('gemini', { happyHomeDir: homeDir });
    const wrapper = await readFile(managedPath, 'utf8');
    assert.match(wrapper, new RegExp(managedRuntimeNodeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('installProviderCli reports managed-runtime-unavailable when no JavaScript runtime can be resolved for a managed package-backed CLI', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happier-provider-install-managed-package-missing-runtime-'));
  try {
    const homeDir = join(dir, 'home');
    const pnpmPath = join(dir, 'fake-pnpm');
    await mkdir(homeDir, { recursive: true });
    await writeFile(pnpmPath, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(pnpmPath, 0o755);

    const result = await installProviderCli({
      providerId: 'gemini',
      platform: 'linux',
      skipIfInstalled: false,
      env: {
        ...process.env,
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_PNPM_BIN: pnpmPath,
        PATH: '',
      },
      deps: {
        ensureManagedJavaScriptRuntimeCommand: async () => null,
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'managed-runtime-unavailable');
    assert.match(result.errorMessage, /javaScript runtime/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('installProviderCli names HAPPIER_PNPM_BIN when an explicit pnpm override is invalid', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happier-provider-install-invalid-pnpm-override-'));
  try {
    const homeDir = join(dir, 'home');
    const runtimePath = join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
    await mkdir(homeDir, { recursive: true });
    await writeFile(runtimePath, '#!/bin/sh\nexit 0\n', 'utf8');
    if (process.platform !== 'win32') {
      await chmod(runtimePath, 0o755);
    }

    const result = await installProviderCli({
      providerId: 'gemini',
      platform: 'linux',
      skipIfInstalled: false,
      env: {
        ...process.env,
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_PNPM_BIN: join(dir, 'missing-pnpm'),
        HAPPIER_JS_RUNTIME_PATH: runtimePath,
        PATH: '',
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'managed-runtime-unavailable');
    assert.match(result.errorMessage, /HAPPIER_PNPM_BIN/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('installProviderCli names HAPPIER_JS_RUNTIME_PATH when an explicit JS runtime override is invalid', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happier-provider-install-invalid-js-runtime-'));
  try {
    const homeDir = join(dir, 'home');
    const pnpmPath = join(dir, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm');
    await mkdir(homeDir, { recursive: true });
    await writeFile(pnpmPath, '#!/bin/sh\nexit 0\n', 'utf8');
    if (process.platform !== 'win32') {
      await chmod(pnpmPath, 0o755);
    }

    const result = await installProviderCli({
      providerId: 'gemini',
      platform: 'linux',
      skipIfInstalled: false,
      env: {
        ...process.env,
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_PNPM_BIN: pnpmPath,
        HAPPIER_JS_RUNTIME_PATH: join(dir, 'missing-node'),
        PATH: '',
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'managed-runtime-unavailable');
    assert.match(result.errorMessage, /HAPPIER_JS_RUNTIME_PATH/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('installProviderCli does not treat a system CLI as already-installed when explicitly installing a managed package-backed backend', async () => {
  if (process.platform === 'win32') {
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'happier-provider-install-managed-package-system-'));
  try {
    const homeDir = join(dir, 'home');
    const binDir = join(dir, 'bin');
    await mkdir(homeDir, { recursive: true });
    await mkdir(binDir, { recursive: true });

    const systemGeminiPath = join(binDir, 'gemini');
    await writeFile(systemGeminiPath, '#!/bin/sh\necho system gemini\n', 'utf8');
    await chmod(systemGeminiPath, 0o755);

    const result = await installProviderCli({
      providerId: 'gemini',
      platform: 'linux',
      skipIfInstalled: true,
      dryRun: true,
      env: {
        ...process.env,
        HAPPIER_HOME_DIR: homeDir,
        PATH: binDir,
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.alreadyInstalled, false);
    assert.equal(result.plan.installMode, 'managed_package');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('installProviderCli still treats an existing managed package-backed backend as already-installed', async () => {
  if (process.platform === 'win32') {
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'happier-provider-install-managed-package-current-'));
  try {
    const homeDir = join(dir, 'home');
    await mkdir(homeDir, { recursive: true });

    const managedPath = resolveProviderCliManagedCommandPath('gemini', { happyHomeDir: homeDir });
    await mkdir(dirname(managedPath), { recursive: true });
    await writeFile(managedPath, '#!/bin/sh\necho managed gemini\n', 'utf8');
    await chmod(managedPath, 0o755);

    const result = await installProviderCli({
      providerId: 'gemini',
      platform: 'linux',
      skipIfInstalled: true,
      dryRun: true,
      env: {
        ...process.env,
        HAPPIER_HOME_DIR: homeDir,
        PATH: '',
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.alreadyInstalled, true);
    assert.equal(result.plan.installMode, 'managed_package');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('installProviderCli installs managed github-release CLIs into the managed provider path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happier-provider-install-managed-binary-'));
  try {
    const homeDir = join(dir, 'home');
    const expectedScratchRoot = join(homeDir, 'tools', 'providers', 'codex', '.tmp');
    let downloadedArchivePath = null;
    await mkdir(homeDir, { recursive: true });

    const result = await installProviderCli({
      providerId: 'codex',
      platform: currentProviderInstallPlatform(),
      skipIfInstalled: false,
      env: {
        ...process.env,
        HAPPIER_HOME_DIR: homeDir,
        PATH: '',
      },
      deps: {
        fetchGitHubLatestRelease: async () => ({
          tag_name: 'rust-v0.111.0',
          assets: [{
            name: currentCodexReleaseAssetName(),
            browser_download_url: 'https://example.invalid/codex.tar.gz',
            digest: 'sha256:deadbeef',
          }],
        }),
        downloadGitHubReleaseAsset: async ({ destinationPath }) => {
          downloadedArchivePath = destinationPath;
          await writeFile(destinationPath, 'archive', 'utf8');
        },
        extractGitHubReleaseAsset: async ({ outputPath }) => {
          await mkdir(dirname(outputPath), { recursive: true });
          await writeFile(outputPath, '#!/bin/sh\necho codex\n', 'utf8');
          await chmod(outputPath, 0o755);
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.plan.installMode, 'github_release_binary');
    assert.equal(downloadedArchivePath?.startsWith(expectedScratchRoot), true);

    const managedPath = resolveProviderCliManagedCommandPath('codex', { happyHomeDir: homeDir });
    const binary = await readFile(managedPath, 'utf8');
    assert.match(binary, /echo codex/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('installProviderCli fails closed for codex releases without a digest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happier-provider-install-managed-binary-missing-digest-'));
  const calls = [];
  try {
    const homeDir = join(dir, 'home');
    await mkdir(homeDir, { recursive: true });

    const result = await installProviderCli({
      providerId: 'codex',
      platform: currentProviderInstallPlatform(),
      skipIfInstalled: false,
      env: {
        ...process.env,
        HAPPIER_HOME_DIR: homeDir,
        PATH: '',
      },
      deps: {
        fetchGitHubLatestRelease: async () => ({
          tag_name: 'rust-v0.111.0',
          assets: [{ name: currentCodexReleaseAssetName(), browser_download_url: 'https://example.invalid/codex.tar.gz' }],
        }),
        downloadGitHubReleaseAsset: async () => {
          calls.push('download');
        },
        extractGitHubReleaseAsset: async () => {
          calls.push('extract');
        },
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.errorMessage ?? '', /digest/i);
    assert.deepEqual(calls, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('installProviderCli does not treat a system CLI as already-installed when explicitly installing a managed binary-backed backend', async () => {
  if (process.platform === 'win32') {
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'happier-provider-install-managed-binary-system-'));
  try {
    const homeDir = join(dir, 'home');
    const binDir = join(dir, 'bin');
    await mkdir(homeDir, { recursive: true });
    await mkdir(binDir, { recursive: true });

    const systemCodexPath = join(binDir, 'codex');
    await writeFile(systemCodexPath, '#!/bin/sh\necho system codex\n', 'utf8');
    await chmod(systemCodexPath, 0o755);

    const result = await installProviderCli({
      providerId: 'codex',
      platform: currentProviderInstallPlatform(),
      skipIfInstalled: true,
      dryRun: true,
      env: {
        ...process.env,
        HAPPIER_HOME_DIR: homeDir,
        PATH: binDir,
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.alreadyInstalled, false);
    assert.equal(result.plan.installMode, 'github_release_binary');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('installProviderCli still treats an existing managed binary-backed backend as already-installed', async () => {
  if (process.platform === 'win32') {
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'happier-provider-install-managed-binary-current-'));
  try {
    const homeDir = join(dir, 'home');
    await mkdir(homeDir, { recursive: true });

    const managedPath = resolveProviderCliManagedCommandPath('codex', { happyHomeDir: homeDir });
    await mkdir(dirname(managedPath), { recursive: true });
    await writeFile(managedPath, '#!/bin/sh\necho managed codex\n', 'utf8');
    await chmod(managedPath, 0o755);

    const result = await installProviderCli({
      providerId: 'codex',
      platform: currentProviderInstallPlatform(),
      skipIfInstalled: true,
      dryRun: true,
      env: {
        ...process.env,
        HAPPIER_HOME_DIR: homeDir,
        PATH: '',
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.alreadyInstalled, true);
    assert.equal(result.plan.installMode, 'github_release_binary');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveProviderCliCommand does not treat non-executable PATH files as system commands on Unix', async () => {
  if (process.platform === 'win32') {
    // This test is Unix-specific
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'happier-provider-nonexec-'));
  try {
    const homeDir = join(dir, 'home');
    const binDir = join(dir, 'bin');
    await mkdir(homeDir, { recursive: true });
    await mkdir(binDir, { recursive: true });

    // Create a non-executable file named 'codex' on PATH
    const nonExecPath = join(binDir, 'codex');
    await writeFile(nonExecPath, '#!/bin/sh\necho fake\n', 'utf8');
    await chmod(nonExecPath, 0o644); // Not executable

    // Create a valid managed codex binary
    const managedPath = resolveProviderCliManagedCommandPath('codex', { happyHomeDir: homeDir });
    await mkdir(dirname(managedPath), { recursive: true });
    await writeFile(managedPath, '#!/bin/sh\necho real\n', 'utf8');
    await chmod(managedPath, 0o755); // Executable

    const env = {
      ...process.env,
      HAPPIER_HOME_DIR: homeDir,
      PATH: binDir,
    };

    const resolution = resolveProviderCliCommand('codex', { processEnv: env });

    // Should prefer the managed CLI over the non-executable PATH file
    assert.notEqual(resolution, null);
    assert.equal(resolution.source, 'managed');
    assert.equal(resolution.command, managedPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveProviderCliCommand falls back to ~/.local/bin for vendor-installed CLIs when PATH is missing the binary', async () => {
  if (process.platform === 'win32') {
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'happier-provider-local-bin-'));
  try {
    const homeDir = join(dir, 'home');
    const localBinDir = join(homeDir, '.local', 'bin');
    await mkdir(localBinDir, { recursive: true });

    const claudePath = join(localBinDir, 'claude');
    await writeFile(claudePath, '#!/bin/sh\necho claude\n', 'utf8');
    await chmod(claudePath, 0o755);

    const resolution = resolveProviderCliCommand('claude', {
      processEnv: {
        ...process.env,
        HOME: homeDir,
        PATH: '/usr/bin:/bin',
      },
    });

    assert.notEqual(resolution, null);
    assert.equal(resolution.source, 'system');
    assert.equal(resolution.command, claudePath);

    const kimiPath = join(localBinDir, 'kimi');
    await writeFile(kimiPath, '#!/bin/sh\necho kimi\n', 'utf8');
    await chmod(kimiPath, 0o755);

    const kimiResolution = resolveProviderCliCommand('kimi', {
      processEnv: {
        ...process.env,
        HOME: homeDir,
        PATH: '/usr/bin:/bin',
      },
    });

    assert.notEqual(kimiResolution, null);
    assert.equal(kimiResolution.source, 'system');
    assert.equal(kimiResolution.command, kimiPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveProviderCliCommand falls back to provider-specific user bin directories when PATH is missing the binary', async () => {
  if (process.platform === 'win32') {
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'happier-provider-opencode-user-bin-'));
  try {
    const homeDir = join(dir, 'home');
    const userBinDir = join(homeDir, '.opencode', 'bin');
    const opencodePath = join(userBinDir, 'opencode');
    await mkdir(userBinDir, { recursive: true });
    await writeFile(opencodePath, '#!/bin/sh\necho opencode\n', 'utf8');
    await chmod(opencodePath, 0o755);

    const resolution = resolveProviderCliCommand('opencode', {
      processEnv: {
        ...process.env,
        HOME: homeDir,
        PATH: '',
      },
    });

    assert.deepEqual(resolution, {
      source: 'system',
      command: opencodePath,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveExistingPnpmCommand does not return non-executable PATH files on Unix when managed pnpm does not exist', async () => {
  if (process.platform === 'win32') {
    // This test is Unix-specific
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'happier-pnpm-nonexec-'));
  try {
    const homeDir = join(dir, 'home');
    const binDir = join(dir, 'bin');
    await mkdir(homeDir, { recursive: true });
    await mkdir(binDir, { recursive: true });

    // Create a non-executable file named 'pnpm' on PATH
    const nonExecPath = join(binDir, 'pnpm');
    await writeFile(nonExecPath, '#!/bin/sh\necho fake\n', 'utf8');
    await chmod(nonExecPath, 0o644); // Not executable

    // Do NOT create a managed pnpm binary - we want to test the PATH fallback

    const env = {
      ...process.env,
      HAPPIER_HOME_DIR: homeDir,
      PATH: binDir,
    };

    const command = resolveExistingPnpmCommand(env);

    // Should return null, not the non-executable PATH file
    assert.equal(command, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveExistingPnpmCommand ignores a non-executable managed pnpm binary on Unix', async () => {
  if (process.platform === 'win32') {
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'happier-pnpm-managed-nonexec-'));
  try {
    const homeDir = join(dir, 'home');
    await mkdir(homeDir, { recursive: true });

    const managedPath = managedPnpmBinPath({ ...process.env, HAPPIER_HOME_DIR: homeDir });
    await mkdir(dirname(managedPath), { recursive: true });
    await writeFile(managedPath, '#!/bin/sh\necho fake\n', 'utf8');
    await chmod(managedPath, 0o644);

    const command = resolveExistingPnpmCommand({
      ...process.env,
      HAPPIER_HOME_DIR: homeDir,
      PATH: '',
    });

    assert.equal(command, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveExistingPnpmCommand ignores a non-executable override on Unix', async () => {
  if (process.platform === 'win32') {
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'happier-pnpm-override-nonexec-'));
  try {
    const overridePath = join(dir, 'pnpm');
    await writeFile(overridePath, '#!/bin/sh\necho fake\n', 'utf8');
    await chmod(overridePath, 0o644);

    const command = resolveExistingPnpmCommand({
      ...process.env,
      HAPPIER_PNPM_BIN: overridePath,
      PATH: '',
    });

    assert.equal(command, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveExistingManagedJavaScriptRuntimeCommand ignores a non-executable managed wrapper on Unix', async () => {
  if (process.platform === 'win32') {
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'happier-js-runtime-managed-nonexec-'));
  try {
    const homeDir = join(dir, 'home');
    await mkdir(homeDir, { recursive: true });

    const managedPath = managedJavaScriptRuntimeBinPath({ ...process.env, HAPPIER_HOME_DIR: homeDir });
    await mkdir(dirname(managedPath), { recursive: true });
    await writeFile(managedPath, '#!/bin/sh\necho fake\n', 'utf8');
    await chmod(managedPath, 0o644);

    const command = resolveExistingManagedJavaScriptRuntimeCommand({
      ...process.env,
      HAPPIER_HOME_DIR: homeDir,
    });

    assert.equal(command, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveExistingManagedJavaScriptRuntimeCommand ignores a non-executable override on Unix', async () => {
  if (process.platform === 'win32') {
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'happier-js-runtime-override-nonexec-'));
  try {
    const overridePath = join(dir, 'happier-js-runtime');
    await writeFile(overridePath, '#!/bin/sh\necho fake\n', 'utf8');
    await chmod(overridePath, 0o644);

    const command = resolveExistingManagedJavaScriptRuntimeCommand({
      ...process.env,
      HAPPIER_JS_RUNTIME_PATH: overridePath,
    });

    assert.equal(command, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ensureManagedJavaScriptRuntimeCommand returns explicit node-binary overrides without bootstrapping', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happier-js-runtime-node-override-'));
  try {
    const runtimePath = join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
    await writeFile(runtimePath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\nexit 0\n', 'utf8');
    if (process.platform !== 'win32') {
      await chmod(runtimePath, 0o755);
    }

    for (const envKey of ['HAPPIER_MANAGED_NODE_BIN', 'HAPPIER_NODE_PATH']) {
      const fetchCalls = [];
      const command = await ensureManagedJavaScriptRuntimeCommand(
        {
          ...process.env,
          HAPPIER_HOME_DIR: join(dir, `home-${envKey}`),
          HAPPIER_JS_RUNTIME_PATH: '',
          HAPPIER_MANAGED_NODE_BIN: '',
          HAPPIER_NODE_PATH: '',
          [envKey]: runtimePath,
        },
        {
          fetchNodeRuntimeReleaseAsset: async () => {
            fetchCalls.push(envKey);
            throw new Error('should not bootstrap managed runtime when explicit node override exists');
          },
        },
      );

      assert.equal(command, runtimePath);
      assert.deepEqual(fetchCalls, []);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ensureManagedJavaScriptRuntimeCommand fails closed for a non-executable explicit override instead of bootstrapping', async () => {
  if (process.platform === 'win32') {
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'happier-js-runtime-invalid-override-'));
  try {
    const overridePath = join(dir, 'managed-node');
    await writeFile(overridePath, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(overridePath, 0o644);

    const fetchCalls = [];
    const command = await ensureManagedJavaScriptRuntimeCommand(
      {
        ...process.env,
        HAPPIER_HOME_DIR: join(dir, 'home'),
        HAPPIER_MANAGED_NODE_BIN: overridePath,
      },
      {
        fetchNodeRuntimeReleaseAsset: async () => {
          fetchCalls.push('bootstrapped');
          throw new Error('should not bootstrap managed runtime when explicit override is invalid');
        },
      },
    );

    assert.equal(command, null);
    assert.deepEqual(fetchCalls, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveExistingManagedJavaScriptRuntimeCommand ignores a managed wrapper when the bundled runtime binary is missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happier-js-runtime-missing-runtime-'));
  try {
    const homeDir = join(dir, 'home');
    await mkdir(homeDir, { recursive: true });

    const managedPath = managedJavaScriptRuntimeBinPath({ ...process.env, HAPPIER_HOME_DIR: homeDir });
    await mkdir(dirname(managedPath), { recursive: true });
    await writeFile(
      managedPath,
      process.platform === 'win32'
        ? '@echo off\r\n"%~dp0..\\runtime\\node.exe" %*\r\n'
        : '#!/bin/sh\nexec "$(dirname "$0")/../runtime/bin/node" "$@"\n',
      'utf8',
    );
    if (process.platform !== 'win32') {
      await chmod(managedPath, 0o755);
    }

    const command = resolveExistingManagedJavaScriptRuntimeCommand({
      ...process.env,
      HAPPIER_HOME_DIR: homeDir,
    });

    assert.equal(command, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
