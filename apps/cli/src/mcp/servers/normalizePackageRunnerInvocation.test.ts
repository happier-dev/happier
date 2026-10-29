import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { normalizePackageRunnerInvocation } from './normalizePackageRunnerInvocation';

describe('normalizePackageRunnerInvocation', () => {
  let rootDir: string;
  let processEnv: NodeJS.ProcessEnv;
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'happier-configured-package-runner-'));
    processEnv = { PATH: rootDir, HAPPIER_HOME_DIR: join(rootDir, 'home') };
  });

  afterEach(async () => {
    Object.defineProperty(process, 'platform', platformDescriptor);
    vi.restoreAllMocks();
    await rm(rootDir, { recursive: true, force: true });
  });

  async function installRunner(name: string): Promise<string> {
    const path = join(rootDir, name);
    await writeFile(path, '#!/bin/sh\nexit 0\n');
    await chmod(path, 0o755);
    return path;
  }

  it.each([
    ['npx', ['-y', '--prefer-offline', '@scope/server', '--', '--yes', '-y']],
    ['npm', ['exec', '--package=@scope/server', '--', 'server', '--yes']],
    ['yarn', ['workspace', 'docs', 'run', 'dev']],
    ['yarnpkg', ['dlx', '@scope/server']],
    ['pnpm', ['exec', 'tsx', 'server.ts']],
    ['bunx', ['@scope/server', '--prefer-offline']],
  ])('uses installed %s without translating its arguments', async (command, args) => {
    const path = await installRunner(command);
    await expect(normalizePackageRunnerInvocation({ command, args, processEnv }))
      .resolves.toEqual({ command: path, args });
  });

  it('preserves an explicit executable rather than selecting another runner', async () => {
    const command = await installRunner('npx');
    processEnv.HAPPIER_PNPM_BIN = await installRunner('pnpm');
    const args = ['--package', '@scope/server', '--', 'server', '--yes'];
    await expect(normalizePackageRunnerInvocation({ command, args, processEnv }))
      .resolves.toEqual({ command, args });
  });

  it('does not replace a missing configured runner with an installed package manager', async () => {
    processEnv.HAPPIER_PNPM_BIN = await installRunner('pnpm');
    await expect(normalizePackageRunnerInvocation({ command: 'npx', args: ['server'], processEnv }))
      .resolves.toBeNull();
  });

  it('does not acquire tooling when the configured runner is missing', async () => {
    // Network is the genuine boundary: a missing user command must not acquire tooling.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected download'));
    await expect(normalizePackageRunnerInvocation({ command: 'npx', args: ['server'], processEnv }))
      .resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not fall back from a missing explicit path to a PATH command', async () => {
    await installRunner('npx');
    await expect(normalizePackageRunnerInvocation({ command: join(rootDir, 'missing', 'npx'), args: [], processEnv }))
      .resolves.toBeNull();
  });

  it('resolves relative executable paths against the session workspace', async () => {
    await installRunner('npx');
    await expect(normalizePackageRunnerInvocation({ command: './npx', args: [], processEnv, cwd: rootDir }))
      .resolves.toEqual({ command: './npx', args: [] });
  });

  it('uses Windows Path and PATHEXT to select the configured cmd runner', async () => {
    const command = await installRunner('npx.cmd');
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
    await expect(normalizePackageRunnerInvocation({
      command: 'npx', args: ['--yes', 'server'], processEnv: { Path: rootDir, PATHEXT: '.CMD;.EXE' },
    })).resolves.toEqual({ command, args: ['--yes', 'server'] });
  });

  it('rejects directories and non-executable files', async () => {
    await mkdir(join(rootDir, 'npx'));
    await writeFile(join(rootDir, 'npm'), 'not executable');
    await expect(normalizePackageRunnerInvocation({ command: 'npx', args: [], processEnv })).resolves.toBeNull();
    if (process.platform !== 'win32') {
      await expect(normalizePackageRunnerInvocation({ command: 'npm', args: [], processEnv })).resolves.toBeNull();
    }
  });
});
