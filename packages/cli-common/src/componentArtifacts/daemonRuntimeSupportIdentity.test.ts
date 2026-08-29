import { existsSync } from 'node:fs';
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import cliDistBuildManifest from '../../cliDistBuildManifest.cjs';
import { CLI_RUNTIME_SIDECAR_ENTRIES } from './cliRuntimeSidecars.js';
import {
  CLI_RUNTIME_EXTERNAL_PACKAGES,
  buildCliBinaryArtifactCodePayload,
  buildCliBinaryArtifactSupportPayload,
  buildCliBinaryArtifactPayload,
  readCliBinaryArtifactSupportIdentity,
} from './buildCliBinaryArtifactPayload.js';
import {
  readCliNodeWorkspaceRuntimeIdentity,
  readCliNodeWorkspaceRuntimeIdentityFromRuntimeRoot,
} from './copyCliNodeRuntimePayload.js';

const tempDirs: string[] = [];

async function makeTempRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'daemon-runtime-support-identity-'));
  tempDirs.push(root);
  return root;
}

async function writeFixtureFile(path: string, contents: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, contents, 'utf8');
}

function targetForHost() {
  const os = process.platform === 'win32' ? 'windows' : process.platform;
  return {
    os,
    arch: process.arch,
    bunTarget: `fixture-${os}-${process.arch}`,
    exeExt: process.platform === 'win32' ? '.exe' : '',
  };
}

async function createSupportIdentityFixture(root: string): Promise<void> {
  await writeFixtureFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture-root', private: true }));
  await writeFixtureFile(join(root, 'yarn.lock'), '');
  await writeFixtureFile(join(root, 'apps', 'cli', 'package.json'), JSON.stringify({
    name: '@happier-dev/cli',
    bundledDependencies: ['@happier-dev/cli-common'],
    dependencies: Object.fromEntries(CLI_RUNTIME_EXTERNAL_PACKAGES.map((name) => [name, '1.0.0'])),
  }));
  await writeFixtureFile(join(root, 'packages', 'cli-common', 'package.json'), JSON.stringify({
    name: '@happier-dev/cli-common',
    version: '1.0.0',
    main: './dist/index.js',
  }));
  await writeFixtureFile(join(root, 'packages', 'cli-common', 'dist', 'index.js'), 'export {};\n');
  await writeFixtureFile(join(root, 'apps', 'cli', 'node_modules', '@happier-dev', 'cli-common', 'package.json'), JSON.stringify({
    name: '@happier-dev/cli-common',
    version: '1.0.0',
    main: './dist/index.js',
  }));
  await writeFixtureFile(join(root, 'apps', 'cli', 'node_modules', '@happier-dev', 'cli-common', 'dist', 'index.js'), 'export {};\n');

  for (const packageName of CLI_RUNTIME_EXTERNAL_PACKAGES) {
    const packageDir = join(root, 'apps', 'cli', 'node_modules', ...packageName.split('/'));
    await writeFixtureFile(join(packageDir, 'package.json'), JSON.stringify({
      name: packageName,
      version: '1.0.0',
      main: './index.js',
    }));
    await writeFixtureFile(join(packageDir, 'index.js'), `export const packageName = ${JSON.stringify(packageName)};\n`);
  }

  for (const segments of CLI_RUNTIME_SIDECAR_ENTRIES) {
    const sourcePath = join(root, 'apps', 'cli', 'scripts', ...segments);
    if (segments.at(-1) === 'runtime' || segments.at(-1) === 'shims') {
      await writeFixtureFile(join(sourcePath, 'fixture.cjs'), 'sidecar\n');
      continue;
    }
    await writeFixtureFile(sourcePath, 'sidecar\n');
  }
  await writeFixtureFile(join(root, 'apps', 'cli', 'tools', 'archives', 'fixture-tool.tar.gz'), 'tool-one\n');
  await writeFixtureFile(join(root, 'apps', 'cli', 'scripts', 'unpack-tools.cjs'), `
const fs = require('node:fs');
const path = require('node:path');

async function unpackTools({ toolsDir }) {
  const unpacked = path.join(toolsDir, 'unpacked');
  fs.mkdirSync(unpacked, { recursive: true });
  fs.writeFileSync(path.join(unpacked, 'fixture-tool'), 'fixture tool');
}

module.exports = { unpackTools };
`);
  await writeFixtureFile(join(root, 'packages', 'plugins', 'cliproxyapi', 'package.json'), JSON.stringify({
    name: '@happier-dev/plugins-cliproxyapi',
    scripts: { 'managed-runtime:build': 'fixture' },
  }));
  await writeFixtureFile(join(root, 'packages', 'plugins', 'cliproxyapi', 'managed-runtime', 'main.go'), 'package main\n');
  await writeFixtureFile(join(root, 'packages', 'plugins', 'cliproxyapi', 'managed-runtime', 'licenses', 'CLIProxyAPI-LICENSE'), 'license\n');
  await writeFixtureFile(join(root, 'packages', 'plugins', 'cliproxyapi', 'managed-runtime', 'licenses', 'THIRD-PARTY-NOTICES'), 'notices\n');
  await writeFixtureFile(join(root, 'apps', 'cli', 'native', 'processcustody', 'main.go'), 'package main\n');

  for (const relativePath of [
    'packages/cli-common/src/componentArtifacts/buildCliBinaryArtifactPayload.ts',
    'packages/cli-common/src/componentArtifacts/copyCliNodeRuntimePayload.ts',
    'packages/cli-common/src/componentArtifacts/finalizeRuntimeArtifactPayload.ts',
    'packages/cli-common/src/componentArtifacts/stageCliProxyApiManagedRuntime.ts',
    'packages/cli-common/src/componentArtifacts/stageProcessCustodyRuntime.ts',
    'packages/cli-common/src/componentArtifacts/deferredVoiceRuntimePackages.ts',
    'packages/cli-common/src/componentArtifacts/cliRuntimeSidecars.ts',
    'packages/cli-common/src/workspaces/index.ts',
    'packages/cli-common/workspaceRuntimeDependencies.mjs',
  ]) {
    await writeFixtureFile(join(root, relativePath), 'owner input\n');
  }
}

describe('daemon runtime support identity', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }));
  });

  it('changes for runtime dependency, tool, and sidecar contents while remaining component-owned', async () => {
    const root = await makeTempRepo();
    await createSupportIdentityFixture(root);
    const input = {
      repoRoot: root,
      target: targetForHost(),
      goVersion: 'go version go1.fixture',
    };

    const initial = readCliBinaryArtifactSupportIdentity(input);
    await writeFixtureFile(
      join(root, 'apps', 'cli', 'src', 'code-only-change.ts'),
      'export const codeOnlyChange = true;\n',
    );
    const changedCodeOnly = readCliBinaryArtifactSupportIdentity(input);
    const changedGoToolchain = readCliBinaryArtifactSupportIdentity({
      ...input,
      goVersion: 'go version go1.fixture-changed',
    });
    await writeFixtureFile(
      join(root, 'apps', 'cli', 'node_modules', 'ffmpeg-static', 'index.js'),
      'export const runtime = "changed";\n',
    );
    const changedRuntimeDependency = readCliBinaryArtifactSupportIdentity(input);
    await writeFixtureFile(
      join(root, 'apps', 'cli', 'tools', 'archives', 'fixture-tool.tar.gz'),
      'tool-two\n',
    );
    const changedTool = readCliBinaryArtifactSupportIdentity(input);
    await writeFixtureFile(
      join(root, 'apps', 'cli', 'scripts', 'ripgrep_launcher.cjs'),
      'changed-sidecar\n',
    );
    const changedSidecar = readCliBinaryArtifactSupportIdentity(input);

    expect(changedCodeOnly.fingerprint).toBe(initial.fingerprint);
    expect(changedGoToolchain.fingerprint).not.toBe(initial.fingerprint);
    expect(changedRuntimeDependency.fingerprint).not.toBe(changedGoToolchain.fingerprint);
    expect(changedTool.fingerprint).not.toBe(changedRuntimeDependency.fingerprint);
    expect(changedSidecar.fingerprint).not.toBe(changedTool.fingerprint);
    expect(changedSidecar.workspaceRuntimeIdentity).toBe(initial.workspaceRuntimeIdentity);
  });

  it('binds native custody provisioning so a helper-less payload cannot share a fingerprint', async () => {
    const root = await makeTempRepo();
    await createSupportIdentityFixture(root);
    const prebuiltCustodyPath = join(root, 'prebuilt', 'happier-process-custody');
    await writeFixtureFile(prebuiltCustodyPath, 'prebuilt custody\n');

    const absent = readCliBinaryArtifactSupportIdentity({
      repoRoot: root,
      target: targetForHost(),
      goVersion: 'go version go1.fixture',
    });
    const present = readCliBinaryArtifactSupportIdentity({
      repoRoot: root,
      target: targetForHost(),
      goVersion: 'go version go1.fixture',
      processCustodyRuntimeExecutablePath: prebuiltCustodyPath,
    });
    expect(present.fingerprint).not.toBe(absent.fingerprint);

    await writeFixtureFile(prebuiltCustodyPath, 'changed custody bytes\n');
    const changedBytes = readCliBinaryArtifactSupportIdentity({
      repoRoot: root,
      target: targetForHost(),
      goVersion: 'go version go1.fixture',
      processCustodyRuntimeExecutablePath: prebuiltCustodyPath,
    });
    expect(changedBytes.fingerprint).not.toBe(present.fingerprint);

    await writeFixtureFile(join(root, 'apps', 'cli', 'native', 'processcustody', 'main.go'), 'package main // changed\n');
    expect(readCliBinaryArtifactSupportIdentity({
      repoRoot: root,
      target: targetForHost(),
      goVersion: 'go version go1.fixture',
    }).fingerprint).not.toBe(absent.fingerprint);
  });

  it('uses a root-hoisted workspace package when the CLI-local copy is absent', async () => {
    const root = await makeTempRepo();
    await createSupportIdentityFixture(root);
    await rm(join(root, 'apps', 'cli', 'node_modules', '@happier-dev', 'cli-common'), {
      recursive: true,
      force: true,
    });
    await writeFixtureFile(join(root, 'node_modules', '@happier-dev', 'cli-common', 'package.json'), JSON.stringify({
      name: '@happier-dev/cli-common',
      version: '1.0.0',
      main: './dist/index.js',
    }));
    await writeFixtureFile(
      join(root, 'node_modules', '@happier-dev', 'cli-common', 'dist', 'index.js'),
      'export const packageLocation = "hoisted";\n',
    );

    const identity = readCliBinaryArtifactSupportIdentity({
      repoRoot: root,
      target: targetForHost(),
      goVersion: 'go version go1.fixture',
    });

    expect(identity.workspaceRuntimeIdentity).toBe(
      readCliNodeWorkspaceRuntimeIdentity({ repoRoot: root }).fingerprint,
    );
  });

  it('stages only daemon support entries and verifies the same owner-local identity', async () => {
    const root = await makeTempRepo();
    await createSupportIdentityFixture(root);
    const prebuiltRuntimePath = join(root, 'prebuilt', 'happier-cliproxyapi-managed');
    const prebuiltCustodyPath = join(root, 'prebuilt', 'happier-process-custody');
    await writeFixtureFile(prebuiltRuntimePath, 'prebuilt runtime\n');
    await writeFixtureFile(prebuiltCustodyPath, 'prebuilt custody\n');
    const identityInput = {
      repoRoot: root,
      target: targetForHost(),
      goVersion: 'go version go1.fixture',
      cliProxyApiManagedRuntimeExecutablePath: prebuiltRuntimePath,
      processCustodyRuntimeExecutablePath: prebuiltCustodyPath,
    };
    const identity = readCliBinaryArtifactSupportIdentity(identityInput);
    const payloadDir = join(root, 'artifacts', 'daemon-support', 'support-fingerprint', 'payload');

    const built = await buildCliBinaryArtifactSupportPayload({
      ...identityInput,
      payloadDir,
      supportArtifactFingerprint: identity.fingerprint,
      commandProbe: (command) => command === 'yarn',
    });

    expect(built.entrypoint).toBe('.happier-daemon-support.json');
    const stagedWorkspaceRuntime = readCliNodeWorkspaceRuntimeIdentityFromRuntimeRoot({
      runtimeRoot: payloadDir,
      packageNames: readCliNodeWorkspaceRuntimeIdentity({ repoRoot: root }).packageNames,
    });
    expect(built.workspaceRuntimeIdentity).toBe(stagedWorkspaceRuntime.fingerprint);
    expect(built.workspaceRuntimeIdentity).not.toBe(identity.workspaceRuntimeIdentity);
    await expect(readFile(join(payloadDir, built.entrypoint), 'utf8')).resolves.toContain(identity.fingerprint);
    expect(existsSync(join(payloadDir, 'node_modules'))).toBe(true);
    expect(existsSync(join(payloadDir, 'tools', 'unpacked', 'happier-cliproxyapi-managed'))).toBe(true);
    expect(existsSync(join(payloadDir, 'scripts', 'ripgrep_launcher.cjs'))).toBe(true);
    expect(existsSync(join(payloadDir, 'package-dist'))).toBe(false);
  });

  it('stages immutable daemon support without waiting for the mutable CLI dist lock', async () => {
    const root = await makeTempRepo();
    await createSupportIdentityFixture(root);
    const target = targetForHost();
    const identityInput = {
      repoRoot: root,
      target,
      goVersion: 'go version go1.fixture',
    };
    const identity = readCliBinaryArtifactSupportIdentity(identityInput);
    const payloadDir = join(root, 'artifacts', 'daemon-support', identity.fingerprint, 'payload');
    const cliDistLockPath = join(root, '.project', 'tmp', 'cli-dist-build.lock');
    await writeFixtureFile(cliDistLockPath, JSON.stringify({
      pid: process.pid,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    }));

    let commandObservedWhileCliDistLocked = false;
    let commandObservedWhileSharedDepsLocked = false;
    let markCommandStarted!: () => void;
    const commandStarted = new Promise<void>((resolvePromise) => {
      markCommandStarted = resolvePromise;
    });
    const build = buildCliBinaryArtifactSupportPayload({
      ...identityInput,
      payloadDir,
      supportArtifactFingerprint: identity.fingerprint,
      commandProbe: (command) => command === 'yarn',
      runCommand: async (command, args) => {
        commandObservedWhileCliDistLocked ||= existsSync(cliDistLockPath);
        commandObservedWhileSharedDepsLocked ||= existsSync(
          join(root, '.project', 'tmp', 'cli-shared-deps.lock'),
        );
        const outputIndex = args.indexOf(
          command === 'go' ? '-o' : '--output',
        );
        const outputPath = args[outputIndex + 1];
        if (outputIndex < 0 || !outputPath) throw new Error('fixture managed-runtime output path missing');
        await writeFixtureFile(outputPath, 'managed runtime\n');
        markCommandStarted();
      },
    });

    const startedBeforeRelease = await Promise.race([
      commandStarted.then(() => true),
      new Promise<false>((resolvePromise) => setTimeout(() => resolvePromise(false), 1_000)),
    ]);
    await rm(cliDistLockPath, { force: true });
    await build;

    expect(startedBeforeRelease).toBe(true);
    expect(commandObservedWhileCliDistLocked).toBe(true);
    expect(commandObservedWhileSharedDepsLocked).toBe(true);
  });

  it('builds daemon code without recopying its stable runtime support closure', async () => {
    const root = await makeTempRepo();
    await createSupportIdentityFixture(root);
    const payloadDir = join(root, 'artifacts', 'daemon', 'code-only', 'payload');
    const target = targetForHost();

    const built = await buildCliBinaryArtifactCodePayload({
      repoRoot: root,
      payloadDir,
      target,
      commandProbe: (command) => command === 'bun' || command === 'yarn',
      ensureWorkspacePackagesBuiltByName: async (_repoRoot, packageNames) => ({
        ok: true,
        built: [],
        skipped: packageNames,
      }),
      runCommand: async () => {
        const entrypoint = join(root, 'apps', 'cli', 'dist', 'index.mjs');
        await writeFixtureFile(entrypoint, 'export const daemonCode = true;\n');
        const workspaceRuntime = readCliNodeWorkspaceRuntimeIdentity({ repoRoot: root });
        cliDistBuildManifest.writeCliDistBuildManifest(entrypoint, {
          workspaceRuntimeIdentity: workspaceRuntime.fingerprint,
          workspaceRuntimePackages: workspaceRuntime.packageNames,
        });
      },
      compileBinary: async ({ outfile }) => {
        await writeFixtureFile(outfile, 'compiled daemon binary\n');
      },
    });

    expect(built.entrypoint).toBe('happier');
    await expect(readFile(join(payloadDir, 'happier'), 'utf8')).resolves.toBe('compiled daemon binary\n');
    await expect(readFile(join(payloadDir, 'package-dist', 'index.mjs'), 'utf8'))
      .resolves.toContain('daemonCode');
    expect(existsSync(join(payloadDir, 'node_modules'))).toBe(false);
    expect(existsSync(join(payloadDir, 'tools'))).toBe(false);
    expect(existsSync(join(payloadDir, 'scripts'))).toBe(false);
  });

  it('retains one flattened self-contained daemon payload for release packaging', async () => {
    const root = await makeTempRepo();
    await createSupportIdentityFixture(root);
    const payloadDir = join(root, 'release-payload');
    const target = targetForHost();
    const prebuiltRuntimePath = join(root, 'prebuilt', `happier-cliproxyapi-managed${target.exeExt}`);
    const prebuiltCustodyPath = join(root, 'prebuilt', `happier-process-custody${target.exeExt}`);
    await writeFixtureFile(prebuiltRuntimePath, 'prebuilt release runtime\n');
    await writeFixtureFile(prebuiltCustodyPath, 'prebuilt release custody\n');

    await buildCliBinaryArtifactPayload({
      repoRoot: root,
      payloadDir,
      target,
      cliProxyApiManagedRuntimeExecutablePath: prebuiltRuntimePath,
      processCustodyRuntimeExecutablePath: prebuiltCustodyPath,
      commandProbe: (command) => command === 'bun' || command === 'yarn',
      ensureWorkspacePackagesBuiltByName: async (_repoRoot, packageNames) => ({
        ok: true,
        built: [],
        skipped: packageNames,
      }),
      runCommand: async () => {
        const entrypoint = join(root, 'apps', 'cli', 'dist', 'index.mjs');
        await writeFixtureFile(entrypoint, 'export const releaseDaemon = true;\n');
        const workspaceRuntime = readCliNodeWorkspaceRuntimeIdentity({ repoRoot: root });
        cliDistBuildManifest.writeCliDistBuildManifest(entrypoint, {
          workspaceRuntimeIdentity: workspaceRuntime.fingerprint,
          workspaceRuntimePackages: workspaceRuntime.packageNames,
        });
      },
      compileBinary: async ({ outfile }) => {
        await writeFixtureFile(outfile, 'compiled release daemon binary\n');
      },
    });

    await expect(readFile(join(payloadDir, 'happier'), 'utf8')).resolves.toBe('compiled release daemon binary\n');
    await expect(readFile(join(payloadDir, 'package-dist', 'index.mjs'), 'utf8'))
      .resolves.toContain('releaseDaemon');
    expect(existsSync(join(payloadDir, 'node_modules', '@happier-dev', 'cli-common', 'dist', 'index.js'))).toBe(true);
    expect(existsSync(join(payloadDir, 'tools', 'unpacked', `happier-cliproxyapi-managed${target.exeExt}`))).toBe(true);
    expect(existsSync(join(payloadDir, 'scripts', 'ripgrep_launcher.cjs'))).toBe(true);
    expect((await lstat(join(payloadDir, 'node_modules'))).isSymbolicLink()).toBe(false);
    expect((await lstat(join(payloadDir, 'tools'))).isSymbolicLink()).toBe(false);
    expect((await lstat(join(payloadDir, 'scripts'))).isSymbolicLink()).toBe(false);
  });
});
