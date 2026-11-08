import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installVersionedPayload, recordDesktopInstallation } from '@happier-dev/cli-common/firstPartyRuntime';
import { runCommandCapture } from '@happier-dev/cli-common/process';

import { runHsetupCli } from './hsetup.js';

const renameFailure = vi.hoisted(() => ({ installRoot: '', afterRemoval: true, consumed: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const fs = await import('node:fs');
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    if (renameFailure.installRoot && !renameFailure.consumed && String(args[1]).endsWith('desktop-installations.json')
      && fs.existsSync(renameFailure.installRoot) !== renameFailure.afterRemoval) {
      renameFailure.consumed = true;
      throw new Error('Injected installation-record rename failure');
    }
    return actual.rename(...args);
  } };
});

// The subprocess is the OS boundary; resolution, installation, ownership and cleanup stay real.
vi.mock('@happier-dev/cli-common/process', async (importOriginal) => ({
  ...await importOriginal<typeof import('@happier-dev/cli-common/process')>(),
  runCommandCapture: vi.fn(),
}));

beforeEach(async () => {
  renameFailure.installRoot = '';
  renameFailure.consumed = false;
  vi.mocked(runCommandCapture).mockReset();
  vi.stubEnv('HOME', await temporaryStateDir());
  vi.stubEnv('SHELL', '/bin/bash');
});

const temporaryDirectories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function runUninstall(stateDir: string, bundleId = 'dev.happier.app') {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runHsetupCli(['desktop', 'uninstall', '--bundle-id', bundleId, '--state-dir', stateDir], {
    stdin: {
      async readAll() { throw new Error('Uninstall must not wait for a task specification.'); },
      async readLine() { throw new Error('Uninstall must not prompt.'); },
    },
    stdout: { write: (chunk) => stdout.push(chunk) },
    stderr: { write: (chunk) => stderr.push(chunk) },
  });
  return { exitCode, stdout: stdout.join(''), stderr: stderr.join('') };
}

async function temporaryStateDir() {
  const path = await mkdtemp(join(tmpdir(), 'hsetup-desktop-uninstall-'));
  temporaryDirectories.push(path);
  return path;
}

describe('hsetup desktop uninstall', () => {
  async function installedDesktop() {
    const root = await temporaryStateDir();
    const stateDir = join(root, 'desktop-state');
    const home = join(root, 'custom-home');
    const payload = join(root, 'payload');
    await mkdir(payload);
    const binary = join(payload, process.platform === 'win32' ? 'happier.exe' : 'happier');
    await writeFile(binary, '#!/bin/sh\nexit 0\n');
    await chmod(binary, 0o755);
    const processEnv = { HAPPIER_HOME_DIR: home, HAPPIER_DESKTOP_BUNDLE_ID: 'dev.happier.app', HAPPIER_DESKTOP_STATE_DIR: stateDir };
    await recordDesktopInstallation(processEnv);
    await installVersionedPayload({ componentId: 'happier-cli', versionId: '0.2.21', releaseRing: 'stable', payloadRoot: payload, processEnv, desktopBundleId: 'dev.happier.app' });
    return { stateDir, installRoot: join(home, 'cli') };
  }

  function respondToCli(uninstallResponse: unknown, status = 0) {
    vi.mocked(runCommandCapture).mockImplementation(async ({ args }) => ({
      kind: 'exited', status: args?.includes('--help') ? 0 : status, signal: null, stderr: '',
      stdout: JSON.stringify(args?.includes('--help') ? { flags: ['--desktop-bundle-id'] } : uninstallResponse),
    }));
  }

  it('removes Desktop CLI files after service cleanup exits and makes a repeated cleanup a no-op', async () => {
    const { stateDir, installRoot } = await installedDesktop();
    vi.mocked(runCommandCapture).mockImplementation(async ({ args }) => {
      expect(existsSync(installRoot)).toBe(true);
      return { kind: 'exited', status: 0, signal: null, stderr: '', stdout: JSON.stringify(
        args?.includes('--help') ? { flags: ['--desktop-bundle-id'] } : { ok: true, remainingServiceLaunchers: [] },
      ) };
    });
    expect((await runUninstall(stateDir)).exitCode).toBe(0);
    expect(existsSync(installRoot)).toBe(false);
    expect((await runUninstall(stateDir)).exitCode).toBe(0);
  });

  it('retains CLI files and ownership when service cleanup fails or omits dependency inventory', async () => {
    const { stateDir, installRoot } = await installedDesktop();
    respondToCli({ ok: false }, 1);
    expect((await runUninstall(stateDir)).exitCode).toBe(1);
    expect(existsSync(installRoot)).toBe(true);
    respondToCli({ ok: true });
    expect((await runUninstall(stateDir)).exitCode).toBe(1);
    expect(existsSync(installRoot)).toBe(true);
    expect(existsSync(`${installRoot}.desktop-ownership.json`)).toBe(true);
  });

  it('retries a failed final record write after deleting its only CLI executor', async () => {
    const { stateDir, installRoot } = await installedDesktop();
    respondToCli({ ok: true, remainingServiceLaunchers: [] });
    Object.assign(renameFailure, { installRoot, afterRemoval: true });
    expect((await runUninstall(stateDir)).exitCode).toBe(1);
    expect(existsSync(installRoot)).toBe(false);
    expect((await runUninstall(stateDir)).exitCode).toBe(0);
    expect(JSON.parse(await readFile(join(stateDir, 'desktop-installations.json'), 'utf8')).installations).toEqual([]);
  });

  it('retains the executor if persisting the successful service checkpoint fails', async () => {
    const { stateDir, installRoot } = await installedDesktop();
    respondToCli({ ok: true, remainingServiceLaunchers: [] });
    Object.assign(renameFailure, { installRoot, afterRemoval: false });
    expect((await runUninstall(stateDir)).exitCode).toBe(1);
    expect(existsSync(installRoot)).toBe(true);
    expect((await runUninstall(stateDir)).exitCode).toBe(0);
  });

  it('clears a previous service checkpoint when Desktop setup records the installation again', async () => {
    const { stateDir, installRoot } = await installedDesktop();
    respondToCli({ ok: true, remainingServiceLaunchers: [] });
    Object.assign(renameFailure, { installRoot, afterRemoval: true });
    expect((await runUninstall(stateDir)).exitCode).toBe(1);
    const path = join(stateDir, 'desktop-installations.json');
    const [installation] = JSON.parse(await readFile(path, 'utf8')).installations;
    expect(installation.serviceCleanupLaunchers).toEqual([]);
    await recordDesktopInstallation({ HAPPIER_HOME_DIR: installation.happyHomeDir,
      HAPPIER_FIRST_PARTY_INSTALL_HOME: installation.firstPartyInstallHome,
      HAPPIER_DESKTOP_BUNDLE_ID: 'dev.happier.app', HAPPIER_DESKTOP_STATE_DIR: stateDir });
    expect((await runUninstall(stateDir)).exitCode).toBe(1);
    expect(JSON.parse(await readFile(path, 'utf8')).installations[0].serviceCleanupLaunchers).toBeUndefined();
  });

  it('cleans and audits every recorded home before deleting any CLI executor', async () => {
    const { stateDir, installRoot } = await installedDesktop();
    const path = join(stateDir, 'desktop-installations.json');
    const [installation] = JSON.parse(await readFile(path, 'utf8')).installations;
    const secondHome = `${installation.happyHomeDir}-second`;
    const processEnv = { HAPPIER_HOME_DIR: secondHome,
      HAPPIER_DESKTOP_BUNDLE_ID: 'dev.happier.app', HAPPIER_DESKTOP_STATE_DIR: stateDir };
    await recordDesktopInstallation(processEnv);
    const payloadRoot = await temporaryStateDir();
    await writeFile(join(payloadRoot, process.platform === 'win32' ? 'happier.exe' : 'happier'), 'fixture');
    await installVersionedPayload({ componentId: 'happier-cli', versionId: '0.2.21', releaseRing: 'stable',
      payloadRoot, processEnv, desktopBundleId: 'dev.happier.app' });
    const cleaned = new Set<string>();
    vi.mocked(runCommandCapture).mockImplementation(async ({ args, env }) => {
      expect(existsSync(installRoot)).toBe(true);
      expect(existsSync(join(secondHome, 'cli'))).toBe(true);
      if (!args?.includes('--help') && !args?.includes('--dry-run')) cleaned.add(String(env?.HAPPIER_HOME_DIR));
      if (args?.includes('--dry-run')) expect(cleaned.size).toBe(2);
      const remainingServiceLaunchers = cleaned.size === 2 ? [] : [[join(installRoot, 'current', 'happier')]];
      return { kind: 'exited', status: 0, signal: null, stderr: '', stdout: JSON.stringify(
        args?.includes('--help') ? { flags: ['--desktop-bundle-id'] } : { ok: true, remainingServiceLaunchers },
      ) };
    });
    expect(await runUninstall(stateDir)).toMatchObject({ exitCode: 0, stderr: '' });
    expect(cleaned).toEqual(new Set([installation.happyHomeDir, secondHome]));
    expect(existsSync(installRoot)).toBe(false);
    expect(existsSync(join(secondHome, 'cli'))).toBe(false);
  });

  it('uses the already selected user CLI to remove Desktop-owned services without deleting that CLI', async () => {
    const root = await temporaryStateDir();
    const stateDir = join(root, 'desktop-state');
    const command = join(root, 'user-happier');
    await writeFile(command, 'user installation');
    await mkdir(stateDir);
    await writeFile(join(stateDir, 'desktop-installations.json'), JSON.stringify({
      version: 1, bundleId: 'dev.happier.app',
      installations: [{ happyHomeDir: join(root, 'home'), firstPartyInstallHome: join(root, 'home'), cliPath: command }],
    }));
    respondToCli({ ok: true, remainingServiceLaunchers: [] });
    expect((await runUninstall(stateDir)).exitCode).toBe(0);
    expect(await readFile(command, 'utf8')).toBe('user installation');
  });

  it('succeeds without acquiring a CLI or reading stdin when this app has no recorded installations', async () => {
    const result = await runUninstall(await temporaryStateDir());
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('retains an unreadable installation record and reports failure for repair', async () => {
    const stateDir = await temporaryStateDir();
    const path = join(stateDir, 'desktop-installations.json');
    await writeFile(path, '{broken');
    const result = await runUninstall(stateDir);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toBe('');
    expect(await readFile(path, 'utf8')).toBe('{broken');
  });

  it('refuses a different bundle identity instead of removing another app’s installation record', async () => {
    const stateDir = await temporaryStateDir();
    const path = join(stateDir, 'desktop-installations.json');
    const record = JSON.stringify({ version: 1, bundleId: 'dev.happier.app.preview', installations: [] });
    await writeFile(path, record);
    expect((await runUninstall(stateDir)).exitCode).toBe(1);
    expect(await readFile(path, 'utf8')).toBe(record);
  });
});
