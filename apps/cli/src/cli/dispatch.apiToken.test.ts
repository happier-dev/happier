import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const { debugSpy } = vi.hoisted(() => ({ debugSpy: vi.fn() }));

vi.mock('@/ui/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/ui/logger')>();
  return {
    ...actual,
    logger: { ...actual.logger, debug: debugSpy },
  };
});

import { reloadConfiguration, configuration } from '@/configuration';
import { readStoredCredentials } from '@/persistence';
import { commandRegistry, type CommandHandler } from '@/cli/commandRegistry';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { captureStderr, captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';
import { CLI_API_TOKEN_HANDOFF_ENV } from '@/auth/cliApiToken';

import { dispatchCli } from './dispatch';

const probeCommand = '__api_token_probe__';
const envKeys = [
  'DEBUG',
  'HAPPIER_HOME_DIR',
  'HAPPIER_TOKEN',
  CLI_API_TOKEN_HANDOFF_ENV,
  'HAPPIER_ACTIVE_SERVER_ID',
  'HAPPIER_SERVER_URL',
  'HAPPIER_LOCAL_SERVER_URL',
  'HAPPIER_PUBLIC_SERVER_URL',
  'HAPPIER_WEBAPP_URL',
] as const;

let envScope = createEnvKeyScope(envKeys);

async function writeStoredToken(token: string): Promise<void> {
  await mkdir(dirname(configuration.privateKeyFile), { recursive: true });
  await writeFile(configuration.privateKeyFile, JSON.stringify({ token }), 'utf8');
}

describe('dispatchCli API Token globals', () => {
  beforeEach(() => {
    debugSpy.mockReset();
  });

  afterEach(() => {
    delete (commandRegistry as Record<string, CommandHandler>)[probeCommand];
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
    reloadConfiguration();
    vi.restoreAllMocks();
  });

  it('lets --api-token override HAPPIER_TOKEN and redacts the command context and debug argv', async () => {
    await withTempDir('happier-cli-api-token-', async (homeDir) => {
      const envToken = 'hap_v1_envtoken_envsecret';
      const flagToken = 'hap_v1_flagtoken_flagsecret';
      let observedCredentials: Awaited<ReturnType<typeof readStoredCredentials>> = null;
      let observedRawArgv: string[] = [];
      (commandRegistry as Record<string, CommandHandler>)[probeCommand] = async (context) => {
        observedCredentials = await readStoredCredentials();
        observedRawArgv = context.rawArgv;
      };
      envScope.patch({
        DEBUG: '1',
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_TOKEN: envToken,
        HAPPIER_ACTIVE_SERVER_ID: undefined,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_LOCAL_SERVER_URL: undefined,
        HAPPIER_PUBLIC_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });
      reloadConfiguration();
      await writeStoredToken('stored-session-bearer');

      await dispatchCli({
        args: ['--api-token', flagToken, probeCommand],
        rawArgv: ['happier', '--api-token', flagToken, probeCommand],
        terminalRuntime: null,
      });

      expect(observedCredentials).toEqual({
        token: flagToken,
        encryption: null,
        credentialProvenance: 'api_token',
      });
      expect(observedRawArgv).toEqual(['happier', '--api-token', '<redacted>', probeCommand]);
      await vi.waitFor(() => expect(debugSpy).toHaveBeenCalled());
      expect(JSON.stringify(debugSpy.mock.calls)).not.toContain(flagToken);
      expect(JSON.stringify(debugSpy.mock.calls)).toContain('<redacted>');
    });
  });

  it.each([
    ['token before server selection', ['--api-token', 'hap_v1_flagtoken_flagsecret', '--server-url', 'https://automation.example.test', probeCommand]],
    ['server selection before token', ['--server-url', 'https://automation.example.test', '--api-token', 'hap_v1_flagtoken_flagsecret', probeCommand]],
  ])('preserves global --server-url selection when %s', async (_label, args) => {
    await withTempDir('happier-cli-api-token-', async (homeDir) => {
      let observedServerUrl = '';
      let observedCredentials: Awaited<ReturnType<typeof readStoredCredentials>> = null;
      (commandRegistry as Record<string, CommandHandler>)[probeCommand] = async () => {
        observedServerUrl = configuration.serverUrl;
        observedCredentials = await readStoredCredentials();
      };
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_TOKEN: undefined,
        HAPPIER_ACTIVE_SERVER_ID: undefined,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_LOCAL_SERVER_URL: undefined,
        HAPPIER_PUBLIC_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });
      reloadConfiguration();

      await dispatchCli({ args, rawArgv: ['happier', ...args], terminalRuntime: null });

      expect(observedServerUrl).toBe('https://automation.example.test');
      expect(observedCredentials).toEqual({
        token: 'hap_v1_flagtoken_flagsecret',
        encryption: null,
        credentialProvenance: 'api_token',
      });
    });
  });

  it('does not leak an explicit API Token into a later invocation', async () => {
    await withTempDir('happier-cli-api-token-', async (homeDir) => {
      const observedCredentials: Array<Awaited<ReturnType<typeof readStoredCredentials>>> = [];
      (commandRegistry as Record<string, CommandHandler>)[probeCommand] = async () => {
        observedCredentials.push(await readStoredCredentials());
      };
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_TOKEN: undefined,
        HAPPIER_ACTIVE_SERVER_ID: undefined,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_LOCAL_SERVER_URL: undefined,
        HAPPIER_PUBLIC_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });
      reloadConfiguration();
      await writeStoredToken('stored-session-bearer');

      await dispatchCli({
        args: ['--api-token', 'hap_v1_flagtoken_flagsecret', probeCommand],
        rawArgv: ['happier', '--api-token', 'hap_v1_flagtoken_flagsecret', probeCommand],
        terminalRuntime: null,
      });
      await dispatchCli({
        args: [probeCommand],
        rawArgv: ['happier', probeCommand],
        terminalRuntime: null,
      });

      expect(observedCredentials).toEqual([
        {
          token: 'hap_v1_flagtoken_flagsecret',
          encryption: null,
          credentialProvenance: 'api_token',
        },
        {
          token: 'stored-session-bearer',
          encryption: null,
          credentialProvenance: 'stored_session',
        },
      ]);
    });
  });

  it('consumes the one-shot continuation transfer ahead of HAPPIER_TOKEN and removes both from process.env', async () => {
    await withTempDir('happier-cli-api-token-', async (homeDir) => {
      const observedCredentials: Array<Awaited<ReturnType<typeof readStoredCredentials>>> = [];
      (commandRegistry as Record<string, CommandHandler>)[probeCommand] = async () => {
        observedCredentials.push(await readStoredCredentials());
      };
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_TOKEN: 'hap_v1_ambient_token_secret',
        [CLI_API_TOKEN_HANDOFF_ENV]: 'hap_v1_flag_token_secret',
        HAPPIER_ACTIVE_SERVER_ID: undefined,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_LOCAL_SERVER_URL: undefined,
        HAPPIER_PUBLIC_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });
      reloadConfiguration();
      await writeStoredToken('stored-session-bearer');

      await dispatchCli({ args: [probeCommand], rawArgv: ['happier', probeCommand], terminalRuntime: null });
      expect(process.env.HAPPIER_TOKEN).toBeUndefined();
      expect(process.env[CLI_API_TOKEN_HANDOFF_ENV]).toBeUndefined();

      await dispatchCli({ args: [probeCommand], rawArgv: ['happier', probeCommand], terminalRuntime: null });

      expect(observedCredentials).toEqual([
        {
          token: 'hap_v1_flag_token_secret',
          encryption: null,
          credentialProvenance: 'api_token',
        },
        {
          token: 'stored-session-bearer',
          encryption: null,
          credentialProvenance: 'stored_session',
        },
      ]);
    });
  });

  it('returns one redacted invalid_arguments envelope for a malformed --api-token', async () => {
    const token = 'malformed-secret-value';
    const stdout = captureStdoutJsonOutput<{
      v: number;
      ok: boolean;
      kind: string;
      error?: { code?: string; message?: string };
    }>();
    const stderr = captureStderr();
    try {
      await dispatchCli({
        args: ['--api-token', token, probeCommand, '--json'],
        rawArgv: ['happier', '--api-token', token, probeCommand, '--json'],
        terminalRuntime: null,
      });

      expect(stdout.chunks).toHaveLength(1);
      expect(stdout.json()).toMatchObject({
        v: 1,
        ok: false,
        kind: 'cli_dispatch',
        error: { code: 'invalid_arguments' },
      });
      expect(stdout.chunks.join('')).not.toContain(token);
      expect(stderr.text()).not.toContain(token);
    } finally {
      stderr.restore();
      stdout.restore();
    }
  });

  it('returns the same invalid_arguments envelope for a malformed HAPPIER_TOKEN', async () => {
    const token = 'malformed-env-secret';
    const stdout = captureStdoutJsonOutput<{
      v: number;
      ok: boolean;
      kind: string;
      error?: { code?: string; message?: string };
    }>();
    const stderr = captureStderr();
    try {
      envScope.patch({ HAPPIER_TOKEN: token });
      await dispatchCli({
        args: [probeCommand, '--json'],
        rawArgv: ['happier', probeCommand, '--json'],
        terminalRuntime: null,
      });

      expect(stdout.chunks).toHaveLength(1);
      expect(stdout.json()).toMatchObject({
        v: 1,
        ok: false,
        kind: 'cli_dispatch',
        error: { code: 'invalid_arguments' },
      });
      expect(stdout.chunks.join('')).not.toContain(token);
      expect(stderr.text()).not.toContain(token);
    } finally {
      stderr.restore();
      stdout.restore();
    }
  });
});
