import { afterEach, describe, expect, it } from 'vitest';

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir, withTempDirSync } from '@/testkit/fs/tempDir';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { resolveAcpSdkEntryFromCwd } from '@/capabilities/probes/agentModelsProbe.testkit';
import type { AcpAuthentication } from '@/agent/acp/AcpAuthentication';

import { createGeminiBackend } from './backend';

type AcpBackendLike = {
  options: {
    authentication?: AcpAuthentication;
    env?: Record<string, string | undefined>;
    unsetEnv?: readonly string[];
    mcpServers?: Record<string, unknown>;
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
    'GOOGLE_GENAI_USE_VERTEXAI',
    'GOOGLE_CLOUD_PROJECT',
    'GOOGLE_CLOUD_PROJECT_ID',
    'GOOGLE_CLOUD_LOCATION',
    'HAPPIER_GEMINI_ACP_AUTH_METHOD',
    'HAPPIER_GEMINI_ACP_AUTH_META',
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

  async function withFakeGeminiAcpCli<T>(
    params: { newSessionLogPath: string; authenticateLogPath?: string },
    fn: (geminiPath: string) => Promise<T> | T,
  ): Promise<T> {
    return await withTempDir('happier-gemini-bin-', async (dir) => {
  const acpSdkEntry = resolveAcpSdkEntryFromCwd(process.cwd());
  const geminiPath = writeExecutableShimSync({
        dir,
        fileName: 'gemini',
        contents: `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { Readable, Writable } = require('node:stream');
const { pathToFileURL } = require('node:url');

if (process.argv.includes('--help')) {
  process.stdout.write('Usage: gemini --acp\\n');
  process.exit(0);
}

function normalizeServer(server) {
  const envEntries = Array.isArray(server && server.env) ? server.env : [];
  return {
    name: typeof (server && server.name) === 'string' ? server.name : null,
    command: typeof (server && server.command) === 'string' ? server.command : null,
    args: Array.isArray(server && server.args) ? server.args.map((arg) => String(arg)) : [],
    env: Object.fromEntries(envEntries.map((entry) => [String(entry && entry.name), String(entry && entry.value)])),
  };
}

async function main() {
  const acp = await import(pathToFileURL(${JSON.stringify(acpSdkEntry)}).href);
  const newSessionLogPath = ${JSON.stringify(params.newSessionLogPath)};
  const authenticateLogPath = ${JSON.stringify(params.authenticateLogPath ?? null)};

  const app = acp.agent({ name: 'happier-gemini-auth-test-agent' })
    .onRequest('initialize', async () => {
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        authMethods: [
          { id: 'oauth-personal', name: 'OAuth' },
          { id: 'gemini-api-key', name: 'Gemini API key' },
          { id: 'vertex-ai', name: 'Vertex AI' },
          { id: 'gateway', name: 'AI API Gateway', _meta: { gateway: { protocol: 'google', restartRequired: 'false' } } },
        ],
        agentCapabilities: { loadSession: false },
      };
    })
    .onRequest('authenticate', async ({ params }) => {
      if (authenticateLogPath) {
        appendFileSync(authenticateLogPath, JSON.stringify(params) + '\\n', 'utf8');
      }
      return {};
    })
    .onRequest('session/new', async ({ params }) => {
      const mcpServers = Array.isArray(params && params.mcpServers)
        ? params.mcpServers.map(normalizeServer)
        : [];
      let copiedSettings = null;
      const settingsPath = process.env.GEMINI_CLI_HOME
        ? process.env.GEMINI_CLI_HOME + '/.gemini/settings.json'
        : null;
      if (settingsPath) {
        try {
          copiedSettings = JSON.parse(readFileSync(settingsPath, 'utf8'));
        } catch {
          copiedSettings = null;
        }
      }
      appendFileSync(newSessionLogPath, JSON.stringify({
        mcpServers,
        copiedSettings,
        env: {
          GEMINI_MODEL: Object.prototype.hasOwnProperty.call(process.env, 'GEMINI_MODEL')
            ? process.env.GEMINI_MODEL
            : null,
          HAPPIER_SESSION_ID: Object.prototype.hasOwnProperty.call(process.env, 'HAPPIER_SESSION_ID')
            ? process.env.HAPPIER_SESSION_ID
            : null,
          HAPPIER_GEMINI_ACP_AUTH_METHOD: Object.prototype.hasOwnProperty.call(process.env, 'HAPPIER_GEMINI_ACP_AUTH_METHOD')
            ? process.env.HAPPIER_GEMINI_ACP_AUTH_METHOD
            : null,
          HAPPIER_GEMINI_ACP_AUTH_META: Object.prototype.hasOwnProperty.call(process.env, 'HAPPIER_GEMINI_ACP_AUTH_META')
            ? process.env.HAPPIER_GEMINI_ACP_AUTH_META
            : null,
        },
      }) + '\\n', 'utf8');
      return { sessionId: randomUUID() };
    })
    .onRequest('session/prompt', async ({ params, client }) => {
      await client.notify('session/update', {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'OK' },
        },
      });
      return { stopReason: 'end_turn' };
    })
    .onNotification('session/cancel', async () => {});

  const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
  const connection = app.connect(stream);
  await connection.closed;
}

main().catch((error) => {
  process.stderr.write(String(error && error.stack ? error.stack : error) + '\\n');
  process.exit(1);
});
`,
      });
      envScope.patch({ HAPPIER_GEMINI_PATH: geminiPath });
      return await fn(geminiPath);
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
        expect(backend.options.authentication).toEqual({ kind: 'static', methodId: 'oauth-personal' });
        expect(result.model).toBeUndefined();
        expect(result.modelSource).toBe('default');
      }),
    );
  });

  it('preserves the managed Happier session id in the Gemini child environment', async () => {
    await withTempHome(async () => {
      await withTempDir('happier-gemini-acp-session-env-', async (testDir) => {
        const newSessionLogPath = join(testDir, 'new-session-log.jsonl');
        await withFakeGeminiAcpCli({ newSessionLogPath }, async () => {
          const result = createGeminiBackend({
            cwd: testDir,
            env: { HAPPIER_SESSION_ID: 'session-1' },
            model: null,
          });

          try {
            await expect(result.backend.startSession()).resolves.toMatchObject({ sessionId: expect.any(String) });
            const payload = JSON.parse(readFileSync(newSessionLogPath, 'utf8').trim()) as {
              env?: { HAPPIER_SESSION_ID?: string | null };
            };
            expect(payload.env?.HAPPIER_SESSION_ID).toBe('session-1');
          } finally {
            await result.backend.dispose().catch(() => {});
          }
        });
      });
    });
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
        expect(backend.options.authentication).toEqual({ kind: 'static', methodId: 'gemini-api-key' });
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
        expect(backend.options.authentication).toEqual({ kind: 'static', methodId: 'gemini-api-key' });
      }),
    );
  });

  it('ignores scoped and host GEMINI_MODEL env when no model is selected', async () => {
    await withTempHome((homeDir) =>
      withFakeGeminiCli(() => {
        mkdirSync(join(homeDir, '.gemini'), { recursive: true });
        writeFileSync(
          join(homeDir, '.gemini', 'settings.json'),
          JSON.stringify({ model: { name: 'settings-model' } }),
          'utf8',
        );
        envScope.patch({
          GEMINI_API_KEY: undefined,
          GOOGLE_API_KEY: undefined,
          GEMINI_MODEL: 'host-model',
        });
        const result = createGeminiBackend({
          cwd: '/tmp',
          env: {
            GEMINI_MODEL: 'scoped-model',
          },
        });

        const backend = result.backend as unknown as AcpBackendLike;
        expect(result.model).toBe('settings-model');
        expect(result.modelSource).toBe('local-config');
        expect(backend.options.env?.GEMINI_MODEL).toBeUndefined();
        expect(backend.options.unsetEnv).toContain('GEMINI_MODEL');
      }),
    );
  });

  it('passes GEMINI_MODEL only when the model is explicitly selected', async () => {
    await withTempHome(() =>
      withFakeGeminiCli(() => {
        envScope.patch({
          GEMINI_API_KEY: undefined,
          GOOGLE_API_KEY: undefined,
          GEMINI_MODEL: 'host-model',
        });
        const result = createGeminiBackend({
          cwd: '/tmp',
          env: {},
          model: 'explicit-model',
        });

        const backend = result.backend as unknown as AcpBackendLike;
        expect(result.model).toBe('explicit-model');
        expect(result.modelSource).toBe('explicit');
        expect(backend.options.env?.GEMINI_MODEL).toBe('explicit-model');
      }),
    );
  });

  it('does not pass GEMINI_MODEL=auto or leak the host model env when auto is selected', async () => {
    await withTempDir('happier-gemini-home-', async (homeDir) => {
      await withTempDir('happier-gemini-acp-auto-', async (testDir) => {
        const newSessionLogPath = join(testDir, 'new-session-log.jsonl');
        await withFakeGeminiAcpCli({ newSessionLogPath }, async () => {
          envScope.patch({
            HOME: homeDir,
            GEMINI_API_KEY: undefined,
            GOOGLE_API_KEY: undefined,
            GEMINI_MODEL: 'host-model',
          });

          const result = createGeminiBackend({
            cwd: testDir,
            env: {},
            model: 'auto',
          });

          const backend = result.backend as unknown as AcpBackendLike;
          expect(result.model).toBe('auto');
          expect(result.modelSource).toBe('explicit');
          expect(backend.options.env?.GEMINI_MODEL).toBeUndefined();
          expect(backend.options.unsetEnv).toContain('GEMINI_MODEL');

          try {
            await expect(result.backend.startSession()).resolves.toMatchObject({ sessionId: expect.any(String) });
            const lines = readFileSync(newSessionLogPath, 'utf8')
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean);
            expect(lines).toHaveLength(1);
            expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
              env: { GEMINI_MODEL: null },
            });
          } finally {
            await result.backend.dispose().catch(() => {});
          }
        });
      });
    });
  }, 20_000);

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
          });

          const result = createGeminiBackend({
            cwd: '/tmp',
            env: {
              HOME: scopedHomeDir,
            },
          });

          const backend = result.backend as unknown as AcpBackendLike;
          expect(result.model).toBe('scoped-home-model');
          expect(result.modelSource).toBe('local-config');
          expect(backend.options.env?.GEMINI_MODEL).toBeUndefined();
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
        expect(backend.options.authentication).toEqual({ kind: 'static', methodId: 'gemini-api-key' });
      }),
    );
  });

  it('uses vertex-ai when Vertex AI env is present and does not copy OAuth tokens into API-key env', async () => {
    await withTempHome(() =>
      withFakeGeminiCli(() => {
        envScope.patch({
          GEMINI_API_KEY: undefined,
          GOOGLE_API_KEY: undefined,
        });
        const result = createGeminiBackend({
          cwd: '/tmp',
          env: {
            GOOGLE_GENAI_USE_VERTEXAI: '1',
            GOOGLE_CLOUD_PROJECT: 'vertex-project',
            GOOGLE_CLOUD_LOCATION: 'us-central1',
            HOME: '/tmp/gemini-oauth-home',
          },
          model: null,
        });

        const backend = result.backend as unknown as AcpBackendLike;
        expect(backend.options.authentication).toEqual({ kind: 'static', methodId: 'vertex-ai' });
        expect(backend.options.env).toMatchObject({
          GOOGLE_GENAI_USE_VERTEXAI: '1',
          GOOGLE_CLOUD_PROJECT: 'vertex-project',
          GOOGLE_CLOUD_LOCATION: 'us-central1',
        });
        expect(backend.options.env?.GEMINI_API_KEY).toBeUndefined();
        expect(backend.options.env?.GOOGLE_API_KEY).toBeUndefined();
      }),
    );
  });

  it('scrubs ambient Google projects from an exact connected-service OAuth selection', async () => {
    await withTempHome((homeDir) =>
      withFakeGeminiCli(() => {
        mkdirSync(join(homeDir, '.gemini'), { recursive: true });
        writeFileSync(join(homeDir, '.gemini', 'settings.json'), JSON.stringify({
          googleCloudProject: 'persisted-project-a',
        }));
        envScope.patch({
          GOOGLE_CLOUD_PROJECT: 'ambient-project-a',
          GOOGLE_CLOUD_PROJECT_ID: 'ambient-project-a',
        });
        const result = createGeminiBackend({
          cwd: '/tmp',
          env: {
            HOME: homeDir,
            HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
              kind: 'profile',
              serviceId: 'gemini',
              profileId: 'selected-b',
              credentialRevision: 'csr_abcdefghijklmnopqrstuv',
            }]),
          },
          model: null,
        });

        const backend = result.backend as unknown as AcpBackendLike;
        expect(backend.options.authentication).toEqual({ kind: 'static', methodId: 'oauth-personal' });
        expect(backend.options.env?.GOOGLE_CLOUD_PROJECT).toBeUndefined();
        expect(backend.options.env?.GOOGLE_CLOUD_PROJECT_ID).toBeUndefined();
        expect(backend.options.unsetEnv).toEqual(expect.arrayContaining([
          'GOOGLE_CLOUD_PROJECT',
          'GOOGLE_CLOUD_PROJECT_ID',
        ]));
      }),
    );
  });

  it('passes gateway metadata on the Gemini ACP authenticate call', async () => {
    await withTempDir('happier-gemini-home-', async (homeDir) => {
      await withTempDir('happier-gemini-acp-gateway-', async (testDir) => {
        const newSessionLogPath = join(testDir, 'new-session-log.jsonl');
        const authenticateLogPath = join(testDir, 'authenticate-log.jsonl');
        await withFakeGeminiAcpCli({ newSessionLogPath, authenticateLogPath }, async () => {
          envScope.patch({
            HOME: homeDir,
            GEMINI_API_KEY: undefined,
            GOOGLE_API_KEY: undefined,
          });

          const result = createGeminiBackend({
            cwd: testDir,
            env: {
              HAPPIER_GEMINI_ACP_AUTH_METHOD: 'gateway',
              HAPPIER_GEMINI_ACP_AUTH_META: JSON.stringify({
                gateway: {
                  baseUrl: 'https://gateway.example.test/v1',
                  headers: {
                    Authorization: 'Bearer gateway-token',
                    'X-Gateway-Account': 'acct-1',
                  },
                },
              }),
            },
            model: null,
          });

          try {
            const backend = result.backend as unknown as AcpBackendLike;
            expect(backend.options.authentication).toEqual({
              kind: 'static',
              methodId: 'gateway',
              meta: {
                gateway: {
                  baseUrl: 'https://gateway.example.test/v1',
                  headers: {
                    Authorization: 'Bearer gateway-token',
                    'X-Gateway-Account': 'acct-1',
                  },
                },
              },
            });

            await expect(result.backend.startSession()).resolves.toMatchObject({ sessionId: expect.any(String) });

            const lines = readFileSync(authenticateLogPath, 'utf8')
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean);
            expect(lines.map((line) => JSON.parse(line))).toEqual([
              {
                methodId: 'gateway',
                _meta: {
                  gateway: {
                    baseUrl: 'https://gateway.example.test/v1',
                    headers: {
                      Authorization: 'Bearer gateway-token',
                      'X-Gateway-Account': 'acct-1',
                    },
                  },
                },
              },
            ]);
          } finally {
            await result.backend.dispose().catch(() => {});
          }
        });
      });
    });
  }, 20_000);

  it('uses parent gateway auth controls for ACP authenticate without leaking them to the child env', async () => {
    await withTempDir('happier-gemini-home-', async (homeDir) => {
      await withTempDir('happier-gemini-acp-parent-gateway-', async (testDir) => {
        const newSessionLogPath = join(testDir, 'new-session-log.jsonl');
        const authenticateLogPath = join(testDir, 'authenticate-log.jsonl');
        const gatewayMeta = {
          gateway: {
            baseUrl: 'https://gateway.example.test/v1',
            headers: {
              Authorization: 'Bearer parent-gateway-token',
              'X-Gateway-Account': 'acct-parent',
            },
          },
        };
        await withFakeGeminiAcpCli({ newSessionLogPath, authenticateLogPath }, async () => {
          envScope.patch({
            HOME: homeDir,
            GEMINI_API_KEY: undefined,
            GOOGLE_API_KEY: undefined,
            HAPPIER_GEMINI_ACP_AUTH_METHOD: 'gateway',
            HAPPIER_GEMINI_ACP_AUTH_META: JSON.stringify(gatewayMeta),
          });

          const result = createGeminiBackend({
            cwd: testDir,
            env: {},
            model: null,
          });

          try {
            await expect(result.backend.startSession()).resolves.toMatchObject({ sessionId: expect.any(String) });

            const authenticateLines = readFileSync(authenticateLogPath, 'utf8')
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean);
            expect(authenticateLines.map((line) => JSON.parse(line))).toEqual([
              {
                methodId: 'gateway',
                _meta: gatewayMeta,
              },
            ]);

            const newSessionLines = readFileSync(newSessionLogPath, 'utf8')
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean);
            expect(newSessionLines).toHaveLength(1);
            expect(JSON.parse(newSessionLines[0] ?? '{}')).toMatchObject({
              env: {
                HAPPIER_GEMINI_ACP_AUTH_METHOD: null,
                HAPPIER_GEMINI_ACP_AUTH_META: null,
              },
            });
          } finally {
            await result.backend.dispose().catch(() => {});
          }
        });
      });
    });
  }, 20_000);

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

  it('creates an isolated Gemini CLI home even when no MCP servers are configured', async () => {
    await withTempHome((homeDir) => withFakeGeminiCli(async () => {
      mkdirSync(join(homeDir, '.gemini'), { recursive: true });
      writeFileSync(join(homeDir, '.gemini', 'oauth_creds.json'), JSON.stringify({ access_token: 'oauth-token' }), 'utf8');

      const result = createGeminiBackend({
        cwd: '/tmp/workspace',
        env: {},
        model: null,
      });

      const backend = result.backend as unknown as AcpBackendLike;
      const cliHomeDir = backend.options.env?.GEMINI_CLI_HOME;

      expect(cliHomeDir).toBeTruthy();
      expect(cliHomeDir).not.toBe(homeDir);
      expect(backend.options.env?.HOME).toBe(cliHomeDir);
      expect(readFileSync(join(String(cliHomeDir), '.gemini', 'oauth_creds.json'), 'utf8')).toContain('oauth-token');

      await result.backend.dispose();
      expect(() => readFileSync(join(String(cliHomeDir), '.gemini', 'oauth_creds.json'), 'utf8')).toThrow();
    }));
  });

  it('keeps MCP-backed sessions single-sourced through ACP session options', async () => {
    await withTempHome((homeDir) => withFakeGeminiCli(async () => {
      mkdirSync(join(homeDir, '.gemini'), { recursive: true });
      writeFileSync(join(homeDir, '.gemini', 'settings.json'), JSON.stringify({
        theme: 'dark',
        mcpServers: {
          user_stdio: { command: 'user-server', env: { USER_TOKEN: 'user-secret' } },
        },
      }), 'utf8');

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
      expect(backend.options.env?.HAPPIER_GEMINI_MCP_ENV_QA_STDIO_QA_TOKEN).toBeUndefined();
      expect(Object.keys(backend.options.mcpServers ?? {})).toEqual(['qa_stdio']);

      const settingsPath = join(String(cliHomeDir), '.gemini', 'settings.json');
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
        theme?: string;
        mcpServers?: Record<string, { command?: string; env?: Record<string, string> }>;
      };
      expect(settings.theme).toBe('dark');
      expect(settings).not.toHaveProperty('mcpServers');
      expect(JSON.stringify(settings)).not.toContain('secret');
      expect(JSON.stringify(settings)).not.toContain('user-secret');

      await result.backend.dispose();
      expect(() => readFileSync(settingsPath, 'utf8')).toThrow();
    }));
  });

  it('passes Happier MCP servers exactly once through Gemini ACP session/new without copied settings duplication', async () => {
    await withTempDir('happier-gemini-home-', async (homeDir) => {
      envScope.patch({ HOME: homeDir });
      await withTempDir('happier-gemini-acp-mcp-', async (testDir) => {
        const newSessionLogPath = join(testDir, 'new-session-log.jsonl');
        await withFakeGeminiAcpCli({ newSessionLogPath }, async () => {
          mkdirSync(join(homeDir, '.gemini'), { recursive: true });
          writeFileSync(join(homeDir, '.gemini', 'settings.json'), JSON.stringify({
            theme: 'dark',
            mcpServers: {
              user_stdio: { command: 'user-server', env: { USER_TOKEN: 'user-secret' } },
            },
          }), 'utf8');

          const result = createGeminiBackend({
            cwd: testDir,
            env: {},
            model: null,
            mcpServers: {
              happier: {
                command: process.execPath,
                args: ['-e', 'process.exit(0)'],
                env: { HAPPIER_MCP_TEST: '1' },
              },
            },
          });

          try {
            await expect(result.backend.startSession()).resolves.toMatchObject({ sessionId: expect.any(String) });

            const lines = readFileSync(newSessionLogPath, 'utf8')
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean);
            expect(lines).toHaveLength(1);

            const payload = JSON.parse(lines[0] ?? '{}') as {
              mcpServers?: Array<{ name?: string; command?: string; args?: string[]; env?: Record<string, string> }>;
              copiedSettings?: { mcpServers?: unknown } | null;
            };
            const happierServers = (payload.mcpServers ?? []).filter((server) => server.name === 'happier');

            expect(happierServers).toHaveLength(1);
            expect(happierServers[0]).toMatchObject({
              command: process.execPath,
              args: ['-e', 'process.exit(0)'],
              env: { HAPPIER_MCP_TEST: '1' },
            });
            expect(payload.copiedSettings).toMatchObject({ theme: 'dark' });
            expect(payload.copiedSettings).not.toHaveProperty('mcpServers');
            expect(JSON.stringify(payload)).not.toContain('user-secret');
          } finally {
            await result.backend.dispose().catch(() => {});
          }
        });
      });
    });
  }, 15_000);

  // Connected-services Gemini OAuth is materialized via ~/.gemini/oauth_creds.json and uses oauth-personal,
  // not GEMINI_API_KEY injection. That behavior is validated in connected-services materialization tests.
});
