import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as managedPnpm from '@/runtime/managedTools/pnpm/managedPnpm';

import { normalizePackageRunnerInvocation } from './normalizePackageRunnerInvocation';

describe('normalizePackageRunnerInvocation', () => {
  let rootDir: string;
  let processEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'happier-normalize-package-runner-'));
    const pnpmPath = join(rootDir, 'pnpm');
    await writeFile(pnpmPath, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(pnpmPath, 0o755);
    processEnv = {
      HAPPIER_PNPM_BIN: pnpmPath,
      PATH: '',
    } as NodeJS.ProcessEnv;
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('rewrites npx invocations to managed pnpm dlx', async () => {
    await expect(
      normalizePackageRunnerInvocation({
        command: 'npx',
        args: ['-y', '--prefer-offline', '@scope/server', '--flag'],
        processEnv,
      }),
    ).resolves.toEqual({
      command: processEnv.HAPPIER_PNPM_BIN,
      args: ['dlx', '@scope/server', '--flag'],
      cwdPolicy: 'neutral',
    });
  });

  it('preserves npm exec invocations without package flags for workspace-local binaries', async () => {
    await expect(
      normalizePackageRunnerInvocation({
        command: 'npm',
        args: ['exec', '--', '@scope/server', '--flag'],
        processEnv,
      }),
    ).resolves.toEqual({
      command: processEnv.HAPPIER_PNPM_BIN,
      args: ['exec', '@scope/server', '--flag'],
      cwdPolicy: 'workspace',
    });
  });

  it('rewrites npm exec package installs to managed pnpm dlx', async () => {
    await expect(
      normalizePackageRunnerInvocation({
        command: 'npm',
        args: ['exec', '--package', '@scope/server', '--', 'server', '--flag'],
        processEnv,
      }),
    ).resolves.toEqual({
      command: processEnv.HAPPIER_PNPM_BIN,
      args: ['dlx', '--package', '@scope/server', 'server', '--flag'],
      cwdPolicy: 'neutral',
    });
  });

  it('rewrites npm exec combined package flags to managed pnpm dlx', async () => {
    await expect(
      normalizePackageRunnerInvocation({
        command: 'npm',
        args: ['exec', '--package=@scope/server', '--', 'server', '--flag'],
        processEnv,
      }),
    ).resolves.toEqual({
      command: processEnv.HAPPIER_PNPM_BIN,
      args: ['dlx', '--package=@scope/server', 'server', '--flag'],
      cwdPolicy: 'neutral',
    });
  });

  it('preserves npm run invocations on managed pnpm for workspace-local scripts', async () => {
    await expect(
      normalizePackageRunnerInvocation({
        command: 'npm',
        args: ['run', 'dev', '--', '--port', '3000'],
        processEnv,
      }),
    ).resolves.toEqual({
      command: processEnv.HAPPIER_PNPM_BIN,
      args: ['run', 'dev', '--', '--port', '3000'],
      cwdPolicy: 'workspace',
    });
  });

  it('preserves pnpm exec invocations on managed pnpm for workspace-local binaries', async () => {
    await expect(
      normalizePackageRunnerInvocation({
        command: 'pnpm',
        args: ['exec', 'tsx', 'server.ts'],
        processEnv,
      }),
    ).resolves.toEqual({
      command: processEnv.HAPPIER_PNPM_BIN,
      args: ['exec', 'tsx', 'server.ts'],
      cwdPolicy: 'workspace',
    });
  });

  it('rewrites yarn dlx invocations to managed pnpm dlx', async () => {
    await expect(
      normalizePackageRunnerInvocation({
        command: 'yarn',
        args: ['dlx', '@scope/server', '--flag'],
        processEnv,
      }),
    ).resolves.toEqual({
      command: processEnv.HAPPIER_PNPM_BIN,
      args: ['dlx', '@scope/server', '--flag'],
      cwdPolicy: 'neutral',
    });
  });

  it('rewrites yarnpkg.cmd dlx invocations to managed pnpm dlx', async () => {
    await expect(
      normalizePackageRunnerInvocation({
        command: 'yarnpkg.cmd',
        args: ['dlx', '@scope/server'],
        processEnv,
      }),
    ).resolves.toEqual({
      command: processEnv.HAPPIER_PNPM_BIN,
      args: ['dlx', '@scope/server'],
      cwdPolicy: 'neutral',
    });
  });

  it('does not bootstrap managed pnpm for unsupported runner commands', async () => {
    const ensureSpy = vi.spyOn(managedPnpm, 'ensureManagedPnpmCommand');

    await expect(
      normalizePackageRunnerInvocation({
        command: 'unsupported-runner',
        args: ['--help'],
        processEnv,
      }),
    ).resolves.toBeNull();

    expect(ensureSpy).not.toHaveBeenCalled();
  });

  it('does not rewrite non-dlx yarn invocations whose semantics depend on yarn', async () => {
    await expect(
      normalizePackageRunnerInvocation({
        command: 'yarn',
        args: ['workspace', 'docs', 'run', 'dev'],
        processEnv,
      }),
    ).resolves.toBeNull();
  });

  it('rewrites bunx invocations to managed pnpm dlx', async () => {
    await expect(
      normalizePackageRunnerInvocation({
        command: 'bunx',
        args: ['@scope/server'],
        processEnv,
      }),
    ).resolves.toEqual({
      command: processEnv.HAPPIER_PNPM_BIN,
      args: ['dlx', '@scope/server'],
      cwdPolicy: 'neutral',
    });
  });

  it('keeps pnpm invocations on managed pnpm', async () => {
    await expect(
      normalizePackageRunnerInvocation({
        command: 'pnpm',
        args: ['dlx', '@scope/server'],
        processEnv,
      }),
    ).resolves.toEqual({
      command: processEnv.HAPPIER_PNPM_BIN,
      args: ['dlx', '@scope/server'],
      cwdPolicy: 'neutral',
    });
  });

  it('fails closed when HAPPIER_PNPM_BIN is set but invalid', async () => {
    processEnv = {
      HAPPIER_PNPM_BIN: join(rootDir, 'missing-pnpm'),
      PATH: rootDir,
    } as NodeJS.ProcessEnv;

    await expect(
      normalizePackageRunnerInvocation({
        command: 'npx',
        args: ['@scope/server'],
        processEnv,
      }),
    ).resolves.toBeNull();
  });

  it('fails closed when HAPPIER_PNPM_BIN points to an executable directory', async () => {
    const pnpmDir = join(rootDir, 'pnpm-dir');
    await mkdir(pnpmDir, { recursive: true });
    await chmod(pnpmDir, 0o755);

    processEnv = {
      HAPPIER_PNPM_BIN: pnpmDir,
      PATH: rootDir,
    } as NodeJS.ProcessEnv;

    await expect(
      normalizePackageRunnerInvocation({
        command: 'npx',
        args: ['@scope/server'],
        processEnv,
      }),
    ).resolves.toBeNull();
  });
});
