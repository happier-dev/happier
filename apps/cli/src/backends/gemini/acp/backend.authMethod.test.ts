import { afterEach, describe, expect, it } from 'vitest';

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDirSync } from '@/testkit/fs/tempDir';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';

import { createGeminiBackend } from './backend';

type AcpBackendLike = {
  options: {
    authMethodId?: string;
    env?: Record<string, string | undefined>;
  };
};

describe('createGeminiBackend auth method', () => {
  const envKeys = [
    'HOME',
    'HAPPIER_GEMINI_PATH',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GEMINI_MODEL',
    'GEMINI_CLI_HOME',
  ] as const;
  let envScope = createEnvKeyScope(envKeys);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
  });

  function withTempHome<T>(fn: (homeDir: string) => Promise<T> | T): Promise<T> | T {
    return withTempDirSync('happier-gemini-home-', (homeDir) => {
      envScope.patch({ HOME: homeDir });
      return fn(homeDir);
    });
  }

  function withFakeGeminiCli<T>(fn: (geminiPath: string) => Promise<T> | T): Promise<T> | T {
    return withTempDirSync('happier-gemini-bin-', (dir) => {
      const geminiPath = writeExecutableShimSync({
        dir,
        fileName: 'gemini',
        contents: '#!/bin/sh\nexit 0\n',
      });
      envScope.patch({ HAPPIER_GEMINI_PATH: geminiPath });
      return fn(geminiPath);
    });
  }

  it('defaults to oauth-personal when no API key is present', async () => {
    await withTempHome(() =>
      withFakeGeminiCli(() => {
        envScope.patch({
          GEMINI_API_KEY: undefined,
          GOOGLE_API_KEY: undefined,
        });
        const result = createGeminiBackend({
          cwd: '/tmp',
          env: {},
          model: null,
        });

        const backend = result.backend as unknown as AcpBackendLike;
        expect(backend.options.authMethodId).toBe('oauth-personal');
      }),
    );
  });

  it('uses gemini-api-key when GEMINI_API_KEY is present', async () => {
    await withTempHome(() =>
      withFakeGeminiCli(() => {
        envScope.patch({
          GEMINI_API_KEY: 'AIzaFakeKey',
          GOOGLE_API_KEY: undefined,
        });
        const result = createGeminiBackend({
          cwd: '/tmp',
          env: {},
          model: null,
        });

        const backend = result.backend as unknown as AcpBackendLike;
        expect(backend.options.authMethodId).toBe('gemini-api-key');
      }),
    );
  });

  it('uses the scoped GEMINI_API_KEY from options.env instead of host process env', async () => {
    await withTempHome(() =>
      withFakeGeminiCli(() => {
        envScope.patch({
          GEMINI_API_KEY: undefined,
          GOOGLE_API_KEY: undefined,
        });
        const result = createGeminiBackend({
          cwd: '/tmp',
          env: {
            GEMINI_API_KEY: 'AIzaScopedKey',
          },
          model: null,
        });

        const backend = result.backend as unknown as AcpBackendLike;
        expect(backend.options.authMethodId).toBe('gemini-api-key');
      }),
    );
  });

  it('uses the scoped GEMINI_MODEL env from options.env instead of host process env', async () => {
    await withTempHome(() =>
      withFakeGeminiCli(() => {
        envScope.patch({
          GEMINI_API_KEY: undefined,
          GOOGLE_API_KEY: undefined,
          GEMINI_MODEL: 'host-model',
        } as any);
        const result = createGeminiBackend({
          cwd: '/tmp',
          env: {
            GEMINI_MODEL: 'scoped-model',
          },
        });

        const backend = result.backend as unknown as AcpBackendLike;
        expect(result.model).toBe('scoped-model');
        expect(result.modelSource).toBe('env-var');
        expect(backend.options.env?.GEMINI_MODEL).toBe('scoped-model');
      }),
    );
  });

  it('reads Gemini local config from the scoped HOME in options.env', async () => {
    await withTempHome((hostHomeDir) =>
      withFakeGeminiCli(() =>
        withTempDirSync('happier-gemini-scoped-home-', (scopedHomeDir) => {
          mkdirSync(join(hostHomeDir, '.gemini'), { recursive: true });
          mkdirSync(join(scopedHomeDir, '.gemini'), { recursive: true });
          writeFileSync(join(hostHomeDir, '.gemini', 'config.json'), JSON.stringify({ model: 'host-home-model' }), 'utf8');
          writeFileSync(join(scopedHomeDir, '.gemini', 'config.json'), JSON.stringify({ model: 'scoped-home-model' }), 'utf8');
          envScope.patch({
            GEMINI_API_KEY: undefined,
            GOOGLE_API_KEY: undefined,
            GEMINI_MODEL: undefined,
          } as any);

          const result = createGeminiBackend({
            cwd: '/tmp',
            env: {
              HOME: scopedHomeDir,
            },
          });

          const backend = result.backend as unknown as AcpBackendLike;
          expect(result.model).toBe('scoped-home-model');
          expect(result.modelSource).toBe('local-config');
          expect(backend.options.env?.GEMINI_MODEL).toBe('scoped-home-model');
        }),
      ),
    );
  });

  it('uses gemini-api-key when GEMINI_API_KEY is present only in scoped backend env', async () => {
    await withTempHome(() =>
      withFakeGeminiCli(() => {
        envScope.patch({
          GEMINI_API_KEY: undefined,
          GOOGLE_API_KEY: undefined,
        });
        const result = createGeminiBackend({
          cwd: '/tmp',
          env: { GEMINI_API_KEY: 'AIzaScopedKey' },
          model: null,
        });

        const backend = result.backend as unknown as AcpBackendLike;
        expect(backend.options.authMethodId).toBe('gemini-api-key');
      }),
    );
  });

  it('resolves the local Gemini model from scoped GEMINI_CLI_HOME', async () => {
    await withTempHome(() =>
      withFakeGeminiCli(() =>
        withTempDirSync('happier-gemini-cli-home-', (cliHomeDir) => {
          mkdirSync(join(cliHomeDir, '.gemini'), { recursive: true });
          mkdirSync(join(cliHomeDir, '.config', 'gemini'), { recursive: true });
          envScope.patch({
            GEMINI_API_KEY: undefined,
            GOOGLE_API_KEY: undefined,
          });

          const scopedModel = 'gemini-2.5-pro-scoped';
          const hostModel = 'gemini-2.5-pro-host';
          const hostHomeDir = process.env.HOME as string;
          mkdirSync(join(hostHomeDir, '.gemini'), { recursive: true });
          writeFileSync(join(hostHomeDir, '.gemini', 'config.json'), JSON.stringify({ model: hostModel }), 'utf8');
          writeFileSync(join(cliHomeDir, '.gemini', 'config.json'), JSON.stringify({ model: scopedModel }), 'utf8');

          const result = createGeminiBackend({
            cwd: '/tmp',
            env: { GEMINI_CLI_HOME: cliHomeDir },
            model: undefined,
          });

          expect(result.model).toBe(scopedModel);
          expect(result.modelSource).toBe('local-config');
        }),
      ),
    );
  });

  it('creates a temporary Gemini CLI home for MCP-backed sessions and cleans it up on dispose', async () => {
    await withTempHome((homeDir) => withFakeGeminiCli(async () => {
      mkdirSync(join(homeDir, '.gemini'), { recursive: true });

      const result = createGeminiBackend({
        cwd: '/tmp/workspace',
        env: {},
        model: null,
        mcpServers: {
          qa_stdio: {
            command: 'node',
            args: ['server.js'],
            env: { QA_TOKEN: 'secret' },
          },
        },
      });

      const backend = result.backend as unknown as AcpBackendLike;
      const cliHomeDir = backend.options.env?.GEMINI_CLI_HOME;

      expect(cliHomeDir).toBeTruthy();
      expect(cliHomeDir).not.toBe(homeDir);
      expect(backend.options.env?.HOME).toBe(cliHomeDir);
      expect(backend.options.env?.HAPPIER_GEMINI_MCP_ENV_QA_STDIO_QA_TOKEN).toBe('secret');

      const settingsPath = join(String(cliHomeDir), '.gemini', 'settings.json');
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
        mcpServers?: Record<string, { command?: string; env?: Record<string, string> }>;
      };
      expect(settings.mcpServers?.qa_stdio?.command).toBe('node');
      expect(settings.mcpServers?.qa_stdio?.env).toEqual({
        QA_TOKEN: '$HAPPIER_GEMINI_MCP_ENV_QA_STDIO_QA_TOKEN',
      });
      expect(JSON.stringify(settings)).not.toContain('secret');

      await result.backend.dispose();
      expect(() => readFileSync(settingsPath, 'utf8')).toThrow();
    }));
  });

  // Connected-services Gemini OAuth is materialized via ~/.gemini/oauth_creds.json and uses oauth-personal,
  // not GEMINI_API_KEY injection. That behavior is validated in connected-services materialization tests.
});
