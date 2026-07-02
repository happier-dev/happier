import type { PluginContextV1 } from '@happier-dev/plugin-sdk';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const clientState = vi.hoisted(() => {
  const handlers = new Map<string, (params: unknown) => void | Promise<void>>();
  const requests: Array<{ method: string; params: unknown }> = [];
  let turnStartCount = 0;

  return {
    handlers,
    requests,
    reset() {
      handlers.clear();
      requests.length = 0;
      turnStartCount = 0;
    },
    async request(method: string, params?: unknown): Promise<unknown> {
      requests.push({ method, params });
      if (method === 'account/rateLimits/read') {
        return {
          rateLimits: {
            primary: { used_percent: 31, resets_at: 1779019200000 },
          },
          plan_type: 'pro',
        };
      }
      if (method === 'thread/start') {
        return { threadId: 'thread-1' };
      }
      if (method === 'turn/start') {
        turnStartCount += 1;
        return { turnId: `turn-${turnStartCount}` };
      }
      throw new Error(`Unexpected Codex app-server request: ${method}`);
    },
    async notify(): Promise<void> {
      return undefined;
    },
    registerNotificationHandler(method: string, handler: (params: unknown) => void | Promise<void>): () => void {
      handlers.set(method, handler);
      return () => {
        handlers.delete(method);
      };
    },
  };
});

vi.mock('./client.js', () => ({
  createCodexAppServerClient: vi.fn(async () => ({
    request: clientState.request,
    notify: clientState.notify,
    registerRequestHandler: vi.fn(() => () => undefined),
    registerNotificationHandler: clientState.registerNotificationHandler,
    dispose: vi.fn(async () => undefined),
  })),
  isCodexAppServerOversizedJsonFrameError: vi.fn(() => false),
  resolveCodexHome: (env: Readonly<Record<string, string | undefined>>) => env.CODEX_HOME ?? '/home/test/.codex',
}));

import { createCodexAppServerRuntime } from './runtime.js';

function createRuntime(overrides: Readonly<{
  ctx?: Partial<PluginContextV1>;
  happierSessionId?: string;
  processEnv?: Readonly<Record<string, string | undefined>>;
}> = {}) {
  return createCodexAppServerRuntime({
    ctx: {
      env: { list: () => ({}) },
      exec: {},
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      ...(overrides.ctx ?? {}),
    } as unknown as PluginContextV1,
    directory: '/workspace',
    happierSessionId: overrides.happierSessionId ?? 'session-1',
    processEnv: overrides.processEnv,
  });
}

function emitNotification(method: string, params: unknown): void {
  const handler = clientState.handlers.get(method);
  if (!handler) throw new Error(`Missing notification handler for ${method}`);
  void handler(params);
}

function failedCapacityTurn(turnId: string, message: string): unknown {
  return {
    threadId: 'thread-1',
    turnId,
    status: 'failed',
    turn: {
      id: turnId,
      status: 'failed',
      error: {
        message,
        codex_error_info: 'other',
      },
    },
  };
}

async function waitForTurnStartCount(expectedCount: number): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    const count = clientState.requests.filter((request) => request.method === 'turn/start').length;
    if (count >= expectedCount) return;
    await Promise.resolve();
  }
  throw new Error(`Expected ${expectedCount} turn/start requests`);
}

async function waitForUsageRecordCount(records: unknown[], expectedCount: number): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (records.length >= expectedCount) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected ${expectedCount} provider-account usage records`);
}

function createAccountUsageService(
  overrides: Partial<PluginContextV1['accountUsage']>,
): PluginContextV1['accountUsage'] {
  return {
    resolveAliasContext: async () => null,
    recordSnapshot: async () => ({ status: 'recorded', recordId: 'paug_v1_test' }),
    adoptProvisionalRecord: async () => ({
      status: 'adopted',
      fromRecordId: 'paug_v1_from',
      toRecordId: 'paug_v1_to',
    }),
    ...overrides,
  };
}

describe('Codex app-server temporary recoverable turn failures', () => {
  beforeEach(() => {
    clientState.reset();
  });

  it('surfaces the original temporary failure when the host retry fails too', async () => {
    const runtime = createRuntime();

    await runtime.sendTurnPrompt('original prompt');
    emitNotification(
      'turn/completed',
      failedCapacityTurn('turn-1', 'ORIGINAL_CAPACITY_FAILURE: Selected model is at capacity. Please try a different model.'),
    );

    const waitForCompletion = runtime.waitForTurnCompletion();
    await waitForTurnStartCount(2);
    emitNotification(
      'turn/completed',
      failedCapacityTurn('turn-2', 'RETRY_CAPACITY_FAILURE: Selected model is at capacity. Please try a different model.'),
    );

    await expect(waitForCompletion).rejects.toThrow('ORIGINAL_CAPACITY_FAILURE');
  });

  it('records plugin-native app-server rate-limit reads with stable Codex auth-store account identity', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-plugin-usage-'));
    const records: unknown[] = [];
    const adoptions: unknown[] = [];
    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(
        join(codexHome, 'auth.json'),
        JSON.stringify({ tokens: { id_token: { chatgpt_account_id: 'acct_plugin_native' } } }),
      );

      const runtime = createRuntime({
        processEnv: { CODEX_HOME: codexHome },
        ctx: {
          accountUsage: createAccountUsageService({
            recordSnapshot: async (input: unknown) => {
              records.push(input);
              return { status: 'recorded', recordId: 'paug_v1_test' };
            },
            adoptProvisionalRecord: async (input: unknown) => {
              adoptions.push(input);
              return { status: 'adopted', fromRecordId: 'paug_v1_from', toRecordId: 'paug_v1_to' };
            },
          }),
        },
      });

      await runtime.startOrLoadSession();
      await waitForUsageRecordCount(records, 1);

      expect(records[0]).toMatchObject({
        snapshot: {
          providerId: 'openai-codex',
          accountSubject: {
            kind: 'providerSubject',
            id: 'acct_plugin_native',
          },
          aliases: [
            expect.objectContaining({
              kind: 'appServerNative',
              sessionId: 'session-1',
              localCredentialRef: expect.stringMatching(/^opaque:openai-codex:appServerNative:/),
            }),
          ],
          meters: [
            expect.objectContaining({
              utilizationPct: 31,
            }),
          ],
        },
      });
      expect(adoptions).toHaveLength(1);
      expect(adoptions[0]).toMatchObject({
        adoption: {
          providerId: 'openai-codex',
          proof: { kind: 'id_token_account_id', issuer: 'chatgpt' },
          stableRecordKey: {
            providerId: 'openai-codex',
            accountSubjectId: 'acct_plugin_native',
            subjectKind: 'account',
            quotaScope: 'account',
          },
          aliases: [
            expect.objectContaining({
              kind: 'appServerNative',
              sessionId: 'session-1',
              accountSubjectId: 'acct_plugin_native',
            }),
          ],
        },
      });
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('records app-server rate-limit reads with connected-service group alias context', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-plugin-usage-group-'));
    const records: unknown[] = [];
    const adoptions: unknown[] = [];
    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(
        join(codexHome, 'auth.json'),
        JSON.stringify({ tokens: { id_token: { chatgpt_account_id: 'acct_plugin_group' } } }),
      );

      const runtime = createRuntime({
        processEnv: { CODEX_HOME: codexHome },
        ctx: {
          accountUsage: createAccountUsageService({
            resolveAliasContext: async (input: unknown) => {
              expect(input).toMatchObject({
                serviceId: 'openai-codex',
                env: {
                  CODEX_HOME: codexHome,
                },
              });
              return {
                serviceId: 'openai-codex',
                profileId: 'backup',
                groupId: 'primary-group',
              };
            },
            recordSnapshot: async (input: unknown) => {
              records.push(input);
              return { status: 'recorded', recordId: 'paug_v1_test' };
            },
            adoptProvisionalRecord: async (input: unknown) => {
              adoptions.push(input);
              return { status: 'adopted', fromRecordId: 'paug_v1_from', toRecordId: 'paug_v1_to' };
            },
          }),
        },
      });

      await runtime.startOrLoadSession();
      await waitForUsageRecordCount(records, 1);

      expect(records[0]).toMatchObject({
        snapshot: {
          providerId: 'openai-codex',
          accountSubject: {
            kind: 'providerSubject',
            id: 'acct_plugin_group',
          },
          aliases: [
            expect.objectContaining({
              kind: 'connectedServiceGroupMember',
              serviceId: 'openai-codex',
              profileId: 'backup',
              groupId: 'primary-group',
            }),
          ],
        },
      });
      expect(adoptions[0]).toMatchObject({
        adoption: {
          aliases: [
            expect.objectContaining({
              kind: 'connectedServiceGroupMember',
              serviceId: 'openai-codex',
              profileId: 'backup',
              groupId: 'primary-group',
              accountSubjectId: 'acct_plugin_group',
            }),
          ],
        },
      });
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('records plugin-native app-server rate-limit notifications as isolated provisional subjects when stable identity is missing', async () => {
    const records: unknown[] = [];
    const runtime = createRuntime({
      happierSessionId: 'session-provisional',
      processEnv: { CODEX_HOME: '/missing/codex-home' },
      ctx: {
        accountUsage: createAccountUsageService({
          recordSnapshot: async (input: unknown) => {
            records.push(input);
            return { status: 'recorded', recordId: 'paug_v1_test' };
          },
        }),
      },
    });

    await runtime.startOrLoadSession();
    emitNotification('account/rateLimits/updated', {
      rateLimits: {
        primary: { used_percent: 64, resets_at: 1779019200000 },
      },
      account: { email: 'label-only@example.test' },
    });
    await waitForUsageRecordCount(records, 2);

    expect(records.at(-1)).toMatchObject({
      snapshot: {
        providerId: 'openai-codex',
        accountSubject: {
          kind: 'provisionalLocalSubject',
        },
        accountLabel: 'label-only@example.test',
        aliases: [
          expect.objectContaining({
            kind: 'appServerNative',
            sessionId: 'session-provisional',
            localCredentialRef: expect.stringMatching(/^opaque:openai-codex:appServerNative:/),
          }),
        ],
        meters: [
          expect.objectContaining({
            utilizationPct: 64,
          }),
        ],
      },
    });
  });
});
