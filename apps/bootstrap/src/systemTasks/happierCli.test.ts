import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { preparePayloadMock, installPayloadMock, resolveInstalledPathsMock, runCommandCaptureMock } = vi.hoisted(() => ({
  preparePayloadMock: vi.fn(),
  installPayloadMock: vi.fn(),
  resolveInstalledPathsMock: vi.fn((params: Readonly<{
    processEnv?: NodeJS.ProcessEnv;
  }>) => ({
    installRoot: join(String(params.processEnv?.HAPPIER_HOME_DIR ?? ''), 'cli'),
    currentPath: join(String(params.processEnv?.HAPPIER_HOME_DIR ?? ''), 'cli', 'current'),
    previousPath: join(String(params.processEnv?.HAPPIER_HOME_DIR ?? ''), 'cli', 'previous'),
    versionsDir: join(String(params.processEnv?.HAPPIER_HOME_DIR ?? ''), 'cli', 'versions'),
    binaryPath: String(params.processEnv?.HAPPIER_HOME_DIR ?? '')
      ? join(String(params.processEnv?.HAPPIER_HOME_DIR ?? ''), 'cli', 'current', 'happier')
      : join(tmpdir(), 'nonexistent', 'happier'),
    nodeEntrypointPath: null,
    shimPaths: [],
  })),
  runCommandCaptureMock: vi.fn(),
}));

vi.mock('@happier-dev/cli-common/firstPartyRuntime', () => ({
  prepareFirstPartyComponentPayloadFromGitHubRelease: preparePayloadMock,
  installVersionedPayload: installPayloadMock,
  resolveInstalledFirstPartyComponentPaths: resolveInstalledPathsMock,
}));

vi.mock('./taskRuntime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./taskRuntime.js')>();
  return {
    ...actual,
    runCommandCapture: runCommandCaptureMock,
  };
});

import { resolveLocalHappierCommand, runLocalHappierJsonCommand } from './happierCli.js';

afterEach(() => {
  vi.clearAllMocks();
});

describe('resolveLocalHappierCommand', () => {
  it('falls back to the installed first-party happier binary when present', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-installed-cli-'));
    const happyHomeDir = join(rootDir, '.happier-home');
    const binaryPath = join(happyHomeDir, 'cli', 'current', 'happier');

    try {
      mkdirSync(join(happyHomeDir, 'cli', 'current'), { recursive: true });
      writeFileSync(binaryPath, '#!/usr/bin/env node\n', { mode: 0o755 });
      chmodSync(binaryPath, 0o755);

      expect(resolveLocalHappierCommand({
        processEnv: {
          HAPPIER_HOME_DIR: happyHomeDir,
          HAPPIER_STACK_REPO_DIR: rootDir,
        },
      })).toBe(binaryPath);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('prefers the repo-local Happier CLI when running from a stack-scoped repo checkout', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-repo-local-cli-'));
    const repoCliPath = join(rootDir, 'apps', 'cli', 'bin', 'happier.mjs');

    try {
      mkdirSync(join(rootDir, 'apps', 'cli', 'bin'), { recursive: true });
      writeFileSync(repoCliPath, '#!/usr/bin/env node\n', { mode: 0o755 });
      chmodSync(repoCliPath, 0o755);

      expect(resolveLocalHappierCommand({
        processEnv: {
          HAPPIER_STACK_REPO_DIR: rootDir,
          PATH: '',
        },
      })).toBe(repoCliPath);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('falls back to the repo-local Happier CLI when the current working directory is inside a monorepo checkout', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-repo-local-cwd-'));
    const repoCliPath = join(rootDir, 'apps', 'cli', 'bin', 'happier.mjs');
    const uiDir = join(rootDir, 'apps', 'ui');
    const previousCwd = process.cwd();

    try {
      mkdirSync(join(rootDir, 'apps', 'cli', 'bin'), { recursive: true });
      mkdirSync(uiDir, { recursive: true });
      writeFileSync(repoCliPath, '#!/usr/bin/env node\n', { mode: 0o755 });
      chmodSync(repoCliPath, 0o755);

      process.chdir(uiDir);
      expect(resolveLocalHappierCommand({
        processEnv: {
          PATH: '',
        },
      })).toBe(realpathSync(repoCliPath));
    } finally {
      process.chdir(previousCwd);
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe('runLocalHappierJsonCommand', () => {
  it('acquires the managed happier cli on demand before running local bootstrap commands', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-cli-install-'));
    const happyHomeDir = join(rootDir, '.happier-home');
    const payloadRoot = join(rootDir, 'payload');
    const installedBinaryPath = join(payloadRoot, 'happier');

    try {
      mkdirSync(payloadRoot, { recursive: true });
      writeFileSync(
        installedBinaryPath,
        '#!/bin/sh\nprintf \'%s\\n\' \'{"ok":true,"data":{"authenticated":true,"machineId":"machine-auto-installed"}}\'\n',
        'utf8',
      );
      chmodSync(installedBinaryPath, 0o755);
      mkdirSync(join(payloadRoot, 'package-dist'), { recursive: true });
      writeFileSync(join(payloadRoot, 'package-dist', 'index.mjs'), 'export default "machine-auto-installed";\n', 'utf8');

      preparePayloadMock.mockResolvedValue({
        versionId: '1.2.3',
        payloadRoot,
        cleanup: async () => {},
      });
      installPayloadMock.mockImplementation(async (params: Readonly<{
        processEnv?: NodeJS.ProcessEnv;
      }>) => {
        const installRoot = join(String(params.processEnv?.HAPPIER_HOME_DIR ?? happyHomeDir), 'cli');
        const currentPath = join(installRoot, 'current');
        mkdirSync(currentPath, { recursive: true });
        writeFileSync(join(currentPath, 'happier'), '#!/bin/sh\nprintf \'%s\\n\' \'{"ok":true,"data":{"authenticated":true,"machineId":"machine-auto-installed"}}\'\n', 'utf8');
        chmodSync(join(currentPath, 'happier'), 0o755);
      });
      runCommandCaptureMock.mockResolvedValue({
        status: 0,
        stdout: '{"ok":true,"data":{"authenticated":true,"machineId":"machine-auto-installed"}}\n',
        stderr: '',
      });

      await expect(runLocalHappierJsonCommand({
        args: ['auth', 'status', '--json'],
        processEnv: {
          ...process.env,
          HAPPIER_HOME_DIR: happyHomeDir,
        },
      })).resolves.toMatchObject({
        ok: true,
        data: {
          authenticated: true,
          machineId: 'machine-auto-installed',
        },
      });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('treats a signal-terminated happier process as a failed command', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-cli-signal-'));
    const cliPath = join(rootDir, 'fake-happier');

    try {
      writeFileSync(cliPath, '#!/usr/bin/env node\nprocess.kill(process.pid, "SIGTERM");\n', 'utf8');
      chmodSync(cliPath, 0o755);
      runCommandCaptureMock.mockResolvedValue({
        status: 1,
        stdout: '',
        stderr: '',
      });

      await expect(runLocalHappierJsonCommand({
        args: ['auth', 'status', '--json'],
        processEnv: {
          ...process.env,
          HAPPIER_BOOTSTRAP_CLI_PATH: cliPath,
        },
      })).rejects.toMatchObject({
        code: 'cli_command_failed',
      });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('treats ok:false json responses as failed commands', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-cli-json-failure-'));
    const cliPath = join(rootDir, 'fake-happier');

    try {
      writeFileSync(
        cliPath,
        '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ ok: false, error: { code: "not_installed" }, message: "service missing" }) + "\\n");\n',
        'utf8',
      );
      chmodSync(cliPath, 0o755);
      runCommandCaptureMock.mockResolvedValue({
        status: 0,
        stdout: '{"ok":false,"error":{"code":"not_installed"},"message":"service missing"}\n',
        stderr: '',
      });

      await expect(runLocalHappierJsonCommand({
        args: ['daemon', 'service', 'start', '--json'],
        processEnv: {
          ...process.env,
          HAPPIER_BOOTSTRAP_CLI_PATH: cliPath,
        },
      })).rejects.toMatchObject({
        code: 'cli_command_failed',
        message: 'service missing',
      });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('returns ok:false json envelopes when allowJsonFailure is set even if the CLI exits non-zero', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-cli-json-exit-1-'));
    const cliPath = join(rootDir, 'fake-happier');

    try {
      writeFileSync(
        cliPath,
        '#!/usr/bin/env node\nprocess.exitCode = 1;\nprocess.stdout.write(JSON.stringify({ ok: false, kind: "auth_status", error: { code: "not_authenticated" } }) + "\\n");\n',
        'utf8',
      );
      chmodSync(cliPath, 0o755);
      runCommandCaptureMock.mockResolvedValue({
        status: 1,
        stdout: '{"ok":false,"kind":"auth_status","error":{"code":"not_authenticated"}}\n',
        stderr: '',
      });

      await expect(runLocalHappierJsonCommand({
        args: ['auth', 'status', '--json'],
        allowJsonFailure: true,
        processEnv: {
          ...process.env,
          HAPPIER_BOOTSTRAP_CLI_PATH: cliPath,
        },
      })).resolves.toMatchObject({
        ok: false,
        kind: 'auth_status',
        error: {
          code: 'not_authenticated',
        },
      });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
