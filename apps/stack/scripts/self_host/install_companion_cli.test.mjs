import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findExtractedExecutableByName } from './findExtractedExecutableByName.mjs';
import { buildInstallCompanionCliPlan, installCompanionCli } from './install_companion_cli.mjs';

async function withTempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'hstack-self-host-companion-cli-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('findExtractedExecutableByName finds nested executable files on posix', async (t) => {
  const root = await withTempRoot(t);
  const nestedDir = join(root, 'extract', 'bundle', 'bin');
  const binaryPath = join(nestedDir, 'happier-server');
  await mkdir(nestedDir, { recursive: true });
  await writeFile(binaryPath, '#!/bin/sh\nexit 0\n', 'utf-8');
  await chmod(binaryPath, 0o755);

  const resolved = await findExtractedExecutableByName({
    rootDir: join(root, 'extract'),
    binaryName: 'happier-server',
    platform: 'linux',
  });

  assert.equal(resolved, binaryPath);
});

test('findExtractedExecutableByName ignores non-executable matches on posix', async (t) => {
  const root = await withTempRoot(t);
  const nestedDir = join(root, 'extract', 'bundle');
  const binaryPath = join(nestedDir, 'happier-server');
  await mkdir(nestedDir, { recursive: true });
  await writeFile(binaryPath, 'plain\n', 'utf-8');

  const resolved = await findExtractedExecutableByName({
    rootDir: join(root, 'extract'),
    binaryName: 'happier-server',
    platform: 'linux',
  });

  assert.equal(resolved, '');
});

test('findExtractedExecutableByName accepts matching files on windows without execute bits', async (t) => {
  const root = await withTempRoot(t);
  const nestedDir = join(root, 'extract');
  const binaryPath = join(nestedDir, 'happier.exe');
  await mkdir(nestedDir, { recursive: true });
  await writeFile(binaryPath, 'binary\n', 'utf-8');

  const resolved = await findExtractedExecutableByName({
    rootDir: join(root, 'extract'),
    binaryName: 'happier.exe',
    platform: 'win32',
  });

  assert.equal(resolved, binaryPath);
});

test('buildInstallCompanionCliPlan disables companion CLI installation when withCli is false', () => {
  assert.deepEqual(
    buildInstallCompanionCliPlan({
      withCli: false,
      hasCompanionCli: false,
      hasCurl: true,
      hasBash: true,
    }),
    {
      shouldInstall: false,
      reason: 'disabled',
    },
  );
});

test('buildInstallCompanionCliPlan skips installation when companion CLI already exists', () => {
  assert.deepEqual(
    buildInstallCompanionCliPlan({
      withCli: true,
      hasCompanionCli: true,
      hasCurl: true,
      hasBash: true,
    }),
    {
      shouldInstall: false,
      reason: 'already-installed',
    },
  );
});

test('buildInstallCompanionCliPlan requires curl and bash before installing', () => {
  assert.deepEqual(
    buildInstallCompanionCliPlan({
      withCli: true,
      hasCompanionCli: false,
      hasCurl: false,
      hasBash: true,
    }),
    {
      shouldInstall: false,
      reason: 'missing-curl-or-bash',
    },
  );
});

test('installCompanionCli runs the published installer with channel and non-interactive env', async () => {
  const observed = [];
  const result = await installCompanionCli({
    channel: 'preview',
    nonInteractive: true,
    withCli: true,
    env: { BASE: '1' },
    commandExists: (name) => name === 'curl' || name === 'bash',
    runCommand: async (cmd, args, options) => {
      observed.push({ cmd, args, options });
      return { status: 0 };
    },
  });

  assert.deepEqual(result, {
    installed: true,
    reason: 'installed',
  });
  assert.deepEqual(observed, [
    {
      cmd: 'bash',
      args: ['-lc', 'curl -fsSL https://happier.dev/install | bash'],
      options: {
        allowFail: true,
        env: {
          BASE: '1',
          HAPPIER_CHANNEL: 'preview',
          HAPPIER_NONINTERACTIVE: '1',
        },
        stdio: 'inherit',
      },
    },
  ]);
});

test('installCompanionCli reports installer failure without throwing', async () => {
  const result = await installCompanionCli({
    channel: 'stable',
    nonInteractive: false,
    withCli: true,
    commandExists: (name) => name === 'curl' || name === 'bash',
    runCommand: async () => ({ status: 1 }),
  });

  assert.deepEqual(result, {
    installed: false,
    reason: 'installer-failed',
  });
});
