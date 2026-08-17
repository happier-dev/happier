import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV,
} from '@happier-dev/agents/request-auth';

import {
  PI_REQUEST_AUTH_PRODUCER_VERSION_ENV,
} from './env.js';
import { buildPiRequestAuthExtensionAssetSource } from './assets.js';
import {
  buildPiRequestAuthExtensionSource,
  type PiRequestAuthPurposeMap,
} from './source.js';
import { PI_REQUEST_AUTH_PROVIDER_MATERIALIZATIONS } from './purposes.js';

type TestEvent = Readonly<Record<string, unknown> & { type: string }>;

type TestStreamOptions = Readonly<{
  apiKey?: string;
  headers?: Readonly<Record<string, string | null>>;
  maxRetries?: number;
  onPayload?: (payload: unknown, model: unknown) => unknown | Promise<unknown>;
  onResponse?: (
    response: Readonly<{ status: number; headers: Readonly<Record<string, string>> }>,
    model: unknown,
  ) => void | Promise<void>;
  signal?: AbortSignal;
  transport?: string;
}>;

type TestProvider = Readonly<{
  id: string;
  baseUrl: string;
  auth: Readonly<Record<string, unknown>>;
  stream: (
    model: Readonly<Record<string, unknown>>,
    context: Readonly<Record<string, unknown>>,
    options?: TestStreamOptions,
  ) => AsyncIterable<TestEvent>;
  streamSimple: (
    model: Readonly<Record<string, unknown>>,
    context: Readonly<Record<string, unknown>>,
    options?: TestStreamOptions,
  ) => AsyncIterable<TestEvent>;
}>;

type TestRequestAuthClient = Readonly<{
  lookup: (input: Readonly<{ purpose: unknown; signal?: AbortSignal }>) => Promise<Readonly<{
    accessToken: string;
    requiredHeaders?: Readonly<Record<string, string>>;
    credentialContext: Readonly<Record<string, unknown>>;
  }>>;
  reportAuth: (input: Readonly<Record<string, unknown>>) => Promise<Readonly<{ status: string }>>;
  reportQuota: (input: Readonly<Record<string, unknown>>) => Promise<Readonly<{ status: string }>>;
}>;

type PiGeneratedTestState = {
  providers: readonly TestProvider[];
  requestAuth: TestRequestAuthClient;
};

declare global {
  // Test-only system-boundary state consumed by the generated extension fixtures.
  // eslint-disable-next-line no-var
  var __happierPiRequestAuthTest: PiGeneratedTestState | undefined;
}

const PURPOSES: PiRequestAuthPurposeMap = {
  anthropic: {
    consumer: { pluginId: 'happier.agent.pi', localId: 'pi' },
    purpose: 'anthropic-upstream',
  },
  'openai-codex': {
    consumer: { pluginId: 'happier.agent.pi', localId: 'pi' },
    purpose: 'openai-codex-upstream',
  },
};

const TEST_CLIENT_SOURCE = `
async function lookupConnectedAccountRequestAuth(input) {
  return globalThis.__happierPiRequestAuthTest.requestAuth.lookup(input);
}
async function reportConnectedAccountAuthFailure(input) {
  return globalThis.__happierPiRequestAuthTest.requestAuth.reportAuth(input);
}
async function reportConnectedAccountQuotaFailure(input) {
  return globalThis.__happierPiRequestAuthTest.requestAuth.reportQuota(input);
}
`;

function message(provider: string, stopReason: string, errorMessage?: string): Readonly<Record<string, unknown>> {
  return {
    role: 'assistant',
    content: [],
    api: provider === 'anthropic' ? 'anthropic-messages' : 'openai-codex-responses',
    provider,
    model: 'test-model',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: 1,
  };
}

function events(provider: string, values: readonly TestEvent[]): TestProvider['stream'] {
  return () => (async function* streamEvents() {
    yield* values;
  }());
}

function provider(
  id: string,
  stream: TestProvider['stream'],
  streamSimple: TestProvider['stream'] = stream,
): TestProvider {
  const providerId = id as keyof typeof PI_REQUEST_AUTH_PROVIDER_MATERIALIZATIONS;
  return {
    id,
    name: id,
    baseUrl: PI_REQUEST_AUTH_PROVIDER_MATERIALIZATIONS[providerId].origin,
    auth: { oauth: { name: 'ambient-must-not-survive' } },
    getModels: () => [],
    stream,
    streamSimple,
  } as unknown as TestProvider;
}

function testModel(
  providerId: keyof typeof PI_REQUEST_AUTH_PROVIDER_MATERIALIZATIONS,
): Readonly<Record<string, unknown>> {
  return {
    provider: providerId,
    id: 'test-model',
    baseUrl: PI_REQUEST_AUTH_PROVIDER_MATERIALIZATIONS[providerId].origin,
  };
}

function defaultRequestAuth(overrides: Partial<TestRequestAuthClient> = {}): TestRequestAuthClient {
  return {
    lookup: async () => ({
      accessToken: 'lease-token',
      credentialContext: {
        account: {
          service: { pluginId: 'happier.connected-accounts', localId: 'service' },
          profileId: 'profile-1',
        },
        credentialRevision: 'revision-1',
      },
    }),
    reportAuth: async () => ({ status: 'current_unchanged' }),
    reportQuota: async () => ({ status: 'current_unchanged' }),
    ...overrides,
  };
}

async function writePiAiFixture(root: string): Promise<void> {
  const packageDir = join(root, 'node_modules', '@earendil-works', 'pi-ai');
  await mkdir(join(packageDir, 'providers'), { recursive: true });
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({
    name: '@earendil-works/pi-ai',
    type: 'module',
    exports: {
      '.': './index.js',
      './providers/all': './providers/all.js',
    },
  }), 'utf8');
  await writeFile(join(packageDir, 'index.js'), `
export class AssistantMessageEventStream {
  constructor() {
    this.queue = [];
    this.waiters = [];
    this.done = false;
  }
  push(event) {
    if (this.done) return;
    if (event.type === "done" || event.type === "error") this.done = true;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.queue.push(event);
  }
  end() {
    this.done = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }
  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.queue.length > 0) yield this.queue.shift();
      else if (this.done) return;
      else {
        const item = await new Promise((resolve) => this.waiters.push(resolve));
        if (item.done) return;
        yield item.value;
      }
    }
  }
}
export function createAssistantMessageEventStream() {
  return new AssistantMessageEventStream();
}
`, 'utf8');
  await writeFile(join(packageDir, 'providers', 'all.js'), `
export function builtinProviders() {
  return globalThis.__happierPiRequestAuthTest.providers;
}
`, 'utf8');
}

async function loadExtension(params: Readonly<{
  providers: readonly TestProvider[];
  requestAuth?: TestRequestAuthClient;
  purposes?: PiRequestAuthPurposeMap;
  producerVersion?: string;
}>): Promise<readonly TestProvider[]> {
  const root = await mkdtemp(join(tmpdir(), 'happier-pi-request-auth-'));
  await writePiAiFixture(root);
  const extensionPath = join(root, 'extension.mjs');
  await writeFile(extensionPath, buildPiRequestAuthExtensionSource({
    purposes: params.purposes ?? PURPOSES,
    requestAuthClientSource: TEST_CLIENT_SOURCE,
  }), 'utf8');
  globalThis.__happierPiRequestAuthTest = {
    providers: params.providers,
    requestAuth: params.requestAuth ?? defaultRequestAuth(),
  };
  const previousProducerVersion = process.env[PI_REQUEST_AUTH_PRODUCER_VERSION_ENV];
  process.env[PI_REQUEST_AUTH_PRODUCER_VERSION_ENV] = params.producerVersion ?? '0.82.0';
  try {
    const extension = await import(`${pathToFileURL(extensionPath).href}?${Math.random()}`);
    const registered: TestProvider[] = [];
    await extension.default({
      registerProvider(candidate: TestProvider) {
        registered.push(candidate);
      },
    });
    return registered;
  } finally {
    if (previousProducerVersion === undefined) {
      delete process.env[PI_REQUEST_AUTH_PRODUCER_VERSION_ENV];
    } else {
      process.env[PI_REQUEST_AUTH_PRODUCER_VERSION_ENV] = previousProducerVersion;
    }
  }
}

async function collect(stream: AsyncIterable<TestEvent>): Promise<TestEvent[]> {
  const result: TestEvent[] = [];
  for await (const event of stream) result.push(event);
  return result;
}

afterEach(() => {
  delete globalThis.__happierPiRequestAuthTest;
});

describe('buildPiRequestAuthExtensionSource', () => {
  it('executes the assembled asset through its file-backed request-auth transport', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-pi-request-auth-asset-'));
    const capabilityPath = join(root, 'request-auth-capability.json');
    const capability = 'a'.repeat(43);
    const previousCapabilityPath =
      process.env[CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV];
    const previousProducerVersion = process.env[PI_REQUEST_AUTH_PRODUCER_VERSION_ENV];
    const previousFetch = globalThis.fetch;
    try {
      await writePiAiFixture(root);
      await writeFile(capabilityPath, JSON.stringify({
        v: 2,
        materializationId: 'asset-runtime-test',
        subjectScopeDigest: 'd'.repeat(64),
        capability,
        httpPort: 43210,
      }), 'utf8');
      process.env[CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV] = capabilityPath;
      process.env[PI_REQUEST_AUTH_PRODUCER_VERSION_ENV] = '0.82.0';

      const upstreamOptions: TestStreamOptions[] = [];
      const successfulStream: TestProvider['stream'] = (
        _model,
        _context,
        options,
      ) => (async function* success() {
        upstreamOptions.push(options ?? {});
        yield {
          type: 'done',
          reason: 'stop',
          message: message('anthropic', 'stop'),
        };
      }());
      globalThis.__happierPiRequestAuthTest = {
        providers: [
          provider('anthropic', successfulStream),
          provider('openai-codex', events('openai-codex', [])),
        ],
        requestAuth: defaultRequestAuth(),
      };
      const requestAuthCalls: Array<Readonly<{
        url: string;
        headers: Readonly<Record<string, string>>;
      }>> = [];
      globalThis.fetch = async (input, init) => {
        requestAuthCalls.push({
          url: String(input),
          headers: init?.headers as Readonly<Record<string, string>>,
        });
        return new Response(JSON.stringify({
          ok: true,
          value: {
            accessToken: 'asset-lease-token',
            credentialContext: {
              account: {
                service: {
                  pluginId: 'happier.agent.claude',
                  localId: 'claude-subscription',
                },
                accountId: 'work',
              },
              credentialRevision: 'csr_abcdefghijklmnopqrstuv',
            },
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };

      const extensionPath = join(root, 'extension.mjs');
      await writeFile(
        extensionPath,
        buildPiRequestAuthExtensionAssetSource(PURPOSES),
        'utf8',
      );
      const extension = await import(
        `${pathToFileURL(extensionPath).href}?${Math.random()}`
      );
      const registered: TestProvider[] = [];
      await extension.default({
        registerProvider(candidate: TestProvider) {
          registered.push(candidate);
        },
      });
      const anthropic = registered.find((candidate) => candidate.id === 'anthropic');
      expect(anthropic).toBeDefined();
      if (!anthropic) return;

      await expect(collect(anthropic.stream(
        testModel('anthropic'),
        { messages: [] },
      ))).resolves.toEqual([
        expect.objectContaining({ type: 'done' }),
      ]);
      expect(requestAuthCalls).toEqual([
        expect.objectContaining({
          url: expect.stringContaining('/connected-accounts/request-auth/lookup'),
          headers: expect.objectContaining({
            'x-happier-connected-account-capability': capability,
          }),
        }),
      ]);
      expect(upstreamOptions).toEqual([
        expect.objectContaining({
          apiKey: 'asset-lease-token',
          maxRetries: 0,
        }),
      ]);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousCapabilityPath === undefined) {
        delete process.env[CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV];
      } else {
        process.env[CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV] =
          previousCapabilityPath;
      }
      if (previousProducerVersion === undefined) {
        delete process.env[PI_REQUEST_AUTH_PRODUCER_VERSION_ENV];
      } else {
        process.env[PI_REQUEST_AUTH_PRODUCER_VERSION_ENV] = previousProducerVersion;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it('registers complete providers with request-auth-only configuration', async () => {
    const registered = await loadExtension({
      providers: [
        provider('anthropic', events('anthropic', [])),
        provider('openai-codex', events('openai-codex', [])),
      ],
    });

    expect(registered.map((item) => item.id)).toEqual(['anthropic', 'openai-codex']);
    for (const item of registered) {
      expect(item.auth).toEqual({
        apiKey: expect.objectContaining({
          name: 'Happier connected account',
          check: expect.any(Function),
          resolve: expect.any(Function),
        }),
      });
      expect(item.auth).not.toHaveProperty('oauth');
    }
  });

  it.each([
    ['anthropic', 'https://not-anthropic.example'],
    ['openai-codex', 'https://api.openai.com'],
  ] as const)(
    'refuses a mismatched %s model origin before credential lookup or upstream execution',
    async (providerId, mismatchedBaseUrl) => {
      let lookupCount = 0;
      let upstreamCount = 0;
      const base = provider(providerId, () => {
        upstreamCount += 1;
        return (async function* unexpectedUpstream() {
          yield {
            type: 'done',
            reason: 'stop',
            message: message(providerId, 'stop'),
          };
        }());
      });
      const registered = await loadExtension({
        providers: [base],
        purposes: { [providerId]: PURPOSES[providerId] },
        requestAuth: defaultRequestAuth({
          lookup: async (input) => {
            lookupCount += 1;
            return await defaultRequestAuth().lookup(input);
          },
        }),
      });

      const output = await collect(registered[0].stream(
        { provider: providerId, id: 'test-model', baseUrl: mismatchedBaseUrl },
        { messages: [] },
      ));

      expect(output).toEqual([
        expect.objectContaining({
          type: 'error',
          error: expect.objectContaining({
            errorMessage: `happier_pi_request_auth_provider_origin_mismatch:${providerId}`,
          }),
        }),
      ]);
      expect(lookupCount).toBe(0);
      expect(upstreamCount).toBe(0);
    },
  );

  it('looks up the next current lease independently for every upstream attempt', async () => {
    const seenTokens: string[] = [];
    let lookupCount = 0;
    const base = provider('anthropic', (_model, _context, options) => {
      seenTokens.push(options?.apiKey ?? '');
      const done = { type: 'done', reason: 'stop', message: message('anthropic', 'stop') };
      return (async function* doneEvents() { yield done; }());
    });
    const registered = await loadExtension({
      providers: [base],
      purposes: { anthropic: PURPOSES.anthropic },
      requestAuth: defaultRequestAuth({
        lookup: async () => {
          lookupCount += 1;
          return {
            accessToken: `lease-${lookupCount}`,
            credentialContext: {
              account: {
                service: { pluginId: 'happier.connected-accounts', localId: 'anthropic' },
                profileId: `profile-${lookupCount}`,
              },
              credentialRevision: `revision-${lookupCount}`,
            },
          };
        },
      }),
    });
    const wrapped = registered[0];

    await collect(wrapped.stream(testModel('anthropic'), { messages: [] }));
    await collect(wrapped.stream(testModel('anthropic'), { messages: [] }));

    expect(lookupCount).toBe(2);
    expect(seenTokens).toEqual(['lease-1', 'lease-2']);
  });

  it('enforces authoritative headers case-insensitively and disables provider-native retries', async () => {
    const attempts: TestStreamOptions[] = [];
    const base = provider('anthropic', (_model, _context, options) => {
      attempts.push(options ?? {});
      const done = { type: 'done', reason: 'stop', message: message('anthropic', 'stop') };
      return (async function* doneEvents() { yield done; }());
    });
    const registered = await loadExtension({
      providers: [base],
      purposes: { anthropic: PURPOSES.anthropic },
      requestAuth: defaultRequestAuth({
        lookup: async () => ({
          accessToken: 'current-token',
          requiredHeaders: {
            'X-Account-Identity': 'current-account',
          },
          credentialContext: {
            account: {
              service: { pluginId: 'happier.connected-accounts', localId: 'anthropic' },
              profileId: 'profile-current',
            },
            credentialRevision: 'revision-current',
          },
        }),
      }),
    });

    await collect(registered[0].stream(
      testModel('anthropic'),
      { messages: [] },
      {
        apiKey: 'ambient-token-must-not-survive',
        headers: {
          'x-account-identity': 'stale-account',
          Authorization: 'Bearer ambient-token-must-not-survive',
          'X-aPi-KeY': 'ambient-token-must-not-survive',
          'X-Unrelated': 'preserved',
        },
        maxRetries: 9,
      },
    ));

    expect(attempts).toEqual([expect.objectContaining({
      apiKey: 'current-token',
      maxRetries: 0,
      headers: {
        'X-Unrelated': 'preserved',
        'X-Account-Identity': 'current-account',
      },
    })]);
  });

  it('reports an exact Codex 401 and retries once with a fresh lookup before response content', async () => {
    const attempts: TestStreamOptions[] = [];
    let payloadHookCalls = 0;
    let lookupCount = 0;
    const reportInputs: Readonly<Record<string, unknown>>[] = [];
    const base = provider('openai-codex', (_model, _context, options) => {
      attempts.push(options ?? {});
      const attempt = attempts.length;
      return (async function* attemptEvents() {
        await options?.onPayload?.({ stable: true }, { provider: 'openai-codex' });
        await options?.onResponse?.(
          { status: attempt === 1 ? 401 : 200, headers: {} },
          { provider: 'openai-codex' },
        );
        if (attempt === 1) {
          yield {
            type: 'error',
            reason: 'error',
            error: message('openai-codex', 'error', 'unauthorized'),
          };
          return;
        }
        yield { type: 'start', partial: message('openai-codex', 'stop') };
        yield { type: 'done', reason: 'stop', message: message('openai-codex', 'stop') };
      }());
    });
    const registered = await loadExtension({
      providers: [base],
      purposes: { 'openai-codex': PURPOSES['openai-codex'] },
      requestAuth: defaultRequestAuth({
        lookup: async () => {
          lookupCount += 1;
          return {
            accessToken: `header.${btoa(JSON.stringify({
              'https://api.openai.com/auth': { chatgpt_account_id: 'account-current' },
            }))}.signature`,
            requiredHeaders: { 'ChatGPT-Account-ID': 'account-current' },
            credentialContext: {
              account: {
                service: { pluginId: 'happier.connected-accounts', localId: 'openai-codex' },
                profileId: `profile-${lookupCount}`,
              },
              credentialRevision: `revision-${lookupCount}`,
            },
          };
        },
        reportAuth: async (input) => {
          reportInputs.push(input);
          return { status: 'current_changed' };
        },
      }),
    });

    const output = await collect(registered[0].stream(
      testModel('openai-codex'),
      { messages: [] },
      {
        onPayload: async (payload) => {
          payloadHookCalls += 1;
          return payload;
        },
      },
    ));

    expect(output.map((event) => event.type)).toEqual(['start', 'done']);
    expect(lookupCount).toBe(2);
    expect(attempts).toHaveLength(2);
    expect(attempts.every((options) => options.maxRetries === 0)).toBe(true);
    expect(attempts.every((options) => options.transport === 'sse')).toBe(true);
    expect(payloadHookCalls).toBe(1);
    expect(reportInputs).toEqual([expect.objectContaining({
      normalizedFailure: {
        class: 'authentication',
        evidence: {
          httpStatus: 401,
          limitCategory: 'auth_invalid',
          quotaScope: 'unknown',
          evidenceSource: { kind: 'structured' },
        },
      },
    })]);
  });

  it('leaf-replays exact Codex usage-limit 429 once because Pi does not retry its normalized message', async () => {
    let lookupCount = 0;
    let attemptCount = 0;
    const reportInputs: Readonly<Record<string, unknown>>[] = [];
    const base = provider('openai-codex', (_model, _context, options) => {
      attemptCount += 1;
      const attempt = attemptCount;
      return (async function* quotaEvents() {
        await options?.onPayload?.({ stable: true }, { provider: 'openai-codex' });
        await options?.onResponse?.(
          { status: attempt === 1 ? 429 : 200, headers: {} },
          { provider: 'openai-codex' },
        );
        if (attempt === 1) {
          yield {
            type: 'error',
            reason: 'error',
            error: message('openai-codex', 'error', 'You have hit your ChatGPT usage limit.'),
          };
          return;
        }
        yield { type: 'done', reason: 'stop', message: message('openai-codex', 'stop') };
      }());
    });
    const registered = await loadExtension({
      providers: [base],
      purposes: { 'openai-codex': PURPOSES['openai-codex'] },
      requestAuth: defaultRequestAuth({
        lookup: async () => {
          lookupCount += 1;
          return {
            accessToken: `lease-${lookupCount}`,
            credentialContext: {
              account: {
                service: { pluginId: 'happier.connected-accounts', localId: 'openai-codex' },
                profileId: `profile-${lookupCount}`,
              },
              credentialRevision: `revision-${lookupCount}`,
            },
          };
        },
        reportQuota: async (input) => {
          reportInputs.push(input);
          return { status: 'current_changed' };
        },
      }),
    });

    const output = await collect(registered[0].stream(
      testModel('openai-codex'),
      { messages: [] },
    ));

    expect(output.map((event) => event.type)).toEqual(['done']);
    expect(attemptCount).toBe(2);
    expect(lookupCount).toBe(2);
    expect(reportInputs).toEqual([
      expect.objectContaining({
        normalizedFailure: {
          class: 'quota',
          evidence: {
            httpStatus: 429,
            limitCategory: 'usage_limit',
            quotaScope: 'account',
            evidenceSource: {
              kind: 'pinnedProviderTerminal',
              producer: 'pi',
              producerVersion: '0.82.0',
              provider: 'openai-codex',
              signatureId: 'openai-codex-chatgpt-usage-limit-v1',
            },
          },
        },
      }),
    ]);
  });

  it('preserves the final Provider diagnostic when the one leaf replay is exhausted', async () => {
    let attemptCount = 0;
    let lookupCount = 0;
    let reportCount = 0;
    const exactDiagnostic = 'You have hit your ChatGPT usage limit.';
    const base = provider('openai-codex', (_model, _context, options) => {
      attemptCount += 1;
      return (async function* quotaEvents() {
        await options?.onPayload?.({ stable: true }, { provider: 'openai-codex' });
        await options?.onResponse?.({ status: 429, headers: {} }, { provider: 'openai-codex' });
        yield {
          type: 'error',
          reason: 'error',
          error: message('openai-codex', 'error', exactDiagnostic),
        };
      }());
    });
    const registered = await loadExtension({
      providers: [base],
      purposes: { 'openai-codex': PURPOSES['openai-codex'] },
      requestAuth: defaultRequestAuth({
        lookup: async () => {
          lookupCount += 1;
          const accountId = `account-${lookupCount}`;
          return {
            accessToken: `header.${btoa(JSON.stringify({
              'https://api.openai.com/auth': { chatgpt_account_id: accountId },
            }))}.signature`,
            requiredHeaders: { 'ChatGPT-Account-ID': accountId },
            credentialContext: {
              account: {
                service: { pluginId: 'happier.connected-accounts', localId: 'openai-codex' },
                profileId: accountId,
              },
              credentialRevision: `revision-${lookupCount}`,
            },
          };
        },
        reportQuota: async () => {
          reportCount += 1;
          return { status: 'current_changed' };
        },
      }),
    });

    const output = await collect(registered[0].stream(
      testModel('openai-codex'),
      { messages: [] },
    ));

    expect(attemptCount).toBe(2);
    expect(lookupCount).toBe(2);
    expect(reportCount).toBe(2);
    expect(output).toEqual([expect.objectContaining({
      type: 'error',
      error: expect.objectContaining({
        errorMessage: 'Provider request failed without a safe automatic continuation.',
        happierRequestAuthProviderDiagnostic: exactDiagnostic,
      }),
    })]);
  });

  it.each(['lookup_denied', 'codex_header_mismatch'] as const)(
    'restores the withheld Provider diagnostic when leaf replay setup fails: %s',
    async (setupFailure) => {
      let lookupCount = 0;
      let upstreamCount = 0;
      const exactDiagnostic = 'You have hit your ChatGPT usage limit.';
      const base = provider('openai-codex', (_model, _context, options) => {
        upstreamCount += 1;
        return (async function* quotaEvents() {
          await options?.onPayload?.({ stable: true }, { provider: 'openai-codex' });
          await options?.onResponse?.({ status: 429, headers: {} }, { provider: 'openai-codex' });
          yield {
            type: 'error',
            reason: 'error',
            error: message('openai-codex', 'error', exactDiagnostic),
          };
        }());
      });
      const registered = await loadExtension({
        providers: [base],
        purposes: { 'openai-codex': PURPOSES['openai-codex'] },
        requestAuth: defaultRequestAuth({
          lookup: async () => {
            lookupCount += 1;
            if (lookupCount === 2 && setupFailure === 'lookup_denied') {
              throw new Error('request_auth_binding_unavailable');
            }
            const tokenAccountId = `account-${lookupCount}`;
            const projectedAccountId = lookupCount === 2
              && setupFailure === 'codex_header_mismatch'
              ? 'different-account'
              : tokenAccountId;
            return {
              accessToken: `header.${btoa(JSON.stringify({
                'https://api.openai.com/auth': { chatgpt_account_id: tokenAccountId },
              }))}.signature`,
              requiredHeaders: { 'ChatGPT-Account-ID': projectedAccountId },
              credentialContext: {
                account: {
                  service: { pluginId: 'happier.connected-accounts', localId: 'openai-codex' },
                  profileId: tokenAccountId,
                },
                credentialRevision: `revision-${lookupCount}`,
              },
            };
          },
          reportQuota: async () => ({ status: 'current_changed' }),
        }),
      });

      const output = await collect(registered[0].stream(
        testModel('openai-codex'),
        { messages: [] },
      ));

      expect(lookupCount).toBe(2);
      expect(upstreamCount).toBe(1);
      expect(output).toEqual([expect.objectContaining({
        type: 'error',
        error: expect.objectContaining({
          errorMessage: 'Provider request failed without a safe automatic continuation.',
          happierRequestAuthProviderDiagnostic: exactDiagnostic,
        }),
      })]);
    },
  );

  it('does not retry when exact failure reporting says the credential is still current', async () => {
    let lookupCount = 0;
    const base = provider('openai-codex', (_model, _context, options) => (async function* authEvents() {
      await options?.onPayload?.({ stable: true }, { provider: 'openai-codex' });
      await options?.onResponse?.({ status: 401, headers: {} }, { provider: 'openai-codex' });
      yield {
        type: 'error',
        reason: 'error',
        error: message('openai-codex', 'error', 'unauthorized'),
      };
    }()));
    const registered = await loadExtension({
      providers: [base],
      purposes: { 'openai-codex': PURPOSES['openai-codex'] },
      requestAuth: defaultRequestAuth({
        lookup: async () => {
          lookupCount += 1;
          return {
            accessToken: `lease-${lookupCount}`,
            credentialContext: {
              account: {
                service: { pluginId: 'happier.connected-accounts', localId: 'openai-codex' },
                profileId: 'profile-current',
              },
              credentialRevision: 'revision-current',
            },
          };
        },
        reportAuth: async () => ({ status: 'current_unchanged' }),
      }),
    });

    const output = await collect(registered[0].stream(
      testModel('openai-codex'),
      { messages: [] },
    ));

    expect(output.map((event) => event.type)).toEqual(['error']);
    expect(lookupCount).toBe(1);
  });

  it('reports an exact response even when the caller response observer rejects', async () => {
    let reportCount = 0;
    const base = provider('openai-codex', (_model, _context, options) => (async function* authEvents() {
      await options?.onPayload?.({ stable: true }, { provider: 'openai-codex' });
      try {
        await options?.onResponse?.({ status: 401, headers: {} }, { provider: 'openai-codex' });
      } catch {
        yield {
          type: 'error',
          reason: 'error',
          error: message('openai-codex', 'error', 'response observer failed'),
        };
      }
    }()));
    const registered = await loadExtension({
      providers: [base],
      purposes: { 'openai-codex': PURPOSES['openai-codex'] },
      requestAuth: defaultRequestAuth({
        reportAuth: async () => {
          reportCount += 1;
          return { status: 'current_unchanged' };
        },
      }),
    });

    const output = await collect(registered[0].stream(
      testModel('openai-codex'),
      { messages: [] },
      {
        onResponse: async () => {
          throw new Error('caller observer failed');
        },
      },
    ));

    expect(output.map((event) => event.type)).toEqual(['error']);
    expect(reportCount).toBe(1);
  });

  it('does not report or retry after any response event escaped', async () => {
    let lookupCount = 0;
    let reportCount = 0;
    const base = provider('openai-codex', (_model, _context, options) => (async function* responseEvents() {
      await options?.onResponse?.({ status: 401, headers: {} }, { provider: 'openai-codex' });
      yield { type: 'start', partial: message('openai-codex', 'stop') };
      yield {
        type: 'text_delta',
        contentIndex: 0,
        delta: 'partial',
        partial: message('openai-codex', 'stop'),
      };
      yield {
        type: 'error',
        reason: 'error',
        error: message('openai-codex', 'error', 'late unauthorized'),
      };
    }()));
    const registered = await loadExtension({
      providers: [base],
      purposes: { 'openai-codex': PURPOSES['openai-codex'] },
      requestAuth: defaultRequestAuth({
        lookup: async () => {
          lookupCount += 1;
          return {
            accessToken: 'header.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYSJ9fQ.signature',
            credentialContext: {
              account: {
                service: { pluginId: 'happier.connected-accounts', localId: 'openai-codex' },
                profileId: 'profile-1',
              },
              credentialRevision: 'revision-1',
            },
          };
        },
        reportAuth: async () => {
          reportCount += 1;
          return { status: 'current_changed' };
        },
      }),
    });

    const output = await collect(registered[0].stream(
      testModel('openai-codex'),
      { messages: [] },
    ));

    expect(output.map((event) => event.type)).toEqual(['start', 'text_delta', 'error']);
    expect(reportCount).toBe(0);
    expect(lookupCount).toBe(1);
  });

  it('admits exact version-pinned Anthropic terminal rate evidence without leaf replay', async () => {
    const reportInputs: Readonly<Record<string, unknown>>[] = [];
    let lookupCount = 0;
    const base = provider('anthropic', (_model, _context, options) => (async function* rateEvents() {
      await options?.onPayload?.({ stable: true }, { provider: 'anthropic' });
      yield {
        type: 'error',
        reason: 'error',
        error: message(
          'anthropic',
          'error',
          '429 {"type":"error","error":{"type":"rate_limit_error","message":"rate limit exceeded"}}',
        ),
      };
    }()));
    const registered = await loadExtension({
      providers: [base],
      purposes: { anthropic: PURPOSES.anthropic },
      requestAuth: defaultRequestAuth({
        lookup: async (input) => {
          lookupCount += 1;
          return defaultRequestAuth().lookup(input);
        },
        reportQuota: async (input) => {
          reportInputs.push(input);
          return { status: 'current_changed' };
        },
      }),
    });

    const output = await collect(registered[0].stream(
      testModel('anthropic'),
      { messages: [] },
    ));

    expect(output.map((event) => event.type)).toEqual(['error']);
    expect(lookupCount).toBe(1);
    expect(output[0]?.error).toMatchObject({
      errorMessage:
        '429 {"type":"error","error":{"type":"rate_limit_error","message":"rate limit exceeded"}}',
      happierRequestAuthProviderDiagnostic:
        '429 {"type":"error","error":{"type":"rate_limit_error","message":"rate limit exceeded"}}',
    });
    expect(reportInputs).toEqual([expect.objectContaining({
      normalizedFailure: {
        class: 'quota',
        evidence: {
          httpStatus: 429,
          limitCategory: 'rate_limit',
          quotaScope: 'unknown',
          evidenceSource: {
            kind: 'pinnedProviderTerminal',
            producer: 'pi',
            producerVersion: '0.82.0',
            provider: 'anthropic',
            signatureId: 'anthropic-sdk-429-rate-limit-v1',
          },
        },
      },
    })]);
  });

  it.each([
    {
      status: 503,
      providerType: 'api_error',
      providerMessage: 'service unavailable',
      piRetryable: true,
      expectedProviderCode: undefined,
    },
    {
      status: 501,
      providerType: 'api_error',
      providerMessage: 'unmapped upstream failure',
      piRetryable: false,
      expectedProviderCode: undefined,
    },
    {
      status: 529,
      providerType: 'overloaded_error',
      providerMessage: 'Overloaded',
      piRetryable: true,
      expectedProviderCode: 'overloaded_error',
    },
  ])(
    'reports exact structured $status capacity evidence without inferring Provider scope',
    async ({
      status,
      providerType,
      providerMessage,
      piRetryable,
      expectedProviderCode,
    }) => {
      const reportInputs: Readonly<Record<string, unknown>>[] = [];
      const exactDiagnostic = `${status} ${JSON.stringify({
        type: 'error',
        error: { type: providerType, message: providerMessage },
      })}`;
      const base = provider(
        'anthropic',
        (_model, _context, options) => (async function* capacityEvents() {
          await options?.onPayload?.({ stable: true }, { provider: 'anthropic' });
          await options?.onResponse?.(
            { status, headers: {} },
            { provider: 'anthropic' },
          );
          yield {
            type: 'error',
            reason: 'error',
            error: message('anthropic', 'error', exactDiagnostic),
          };
        }()),
      );
      const registered = await loadExtension({
        providers: [base],
        purposes: { anthropic: PURPOSES.anthropic },
        requestAuth: defaultRequestAuth({
          reportQuota: async (input) => {
            reportInputs.push(input);
            return { status: 'current_unchanged' };
          },
        }),
      });

      const output = await collect(registered[0].stream(
        testModel('anthropic'),
        { messages: [] },
      ));

      expect(reportInputs).toEqual([expect.objectContaining({
        normalizedFailure: {
          class: 'quota',
          evidence: {
            httpStatus: status,
            limitCategory: 'capacity',
            quotaScope: 'unknown',
            ...(expectedProviderCode
              ? { providerCode: expectedProviderCode }
              : {}),
            evidenceSource: { kind: 'structured' },
          },
        },
      })]);
      expect(output).toHaveLength(1);
      expect(output[0]?.error).toMatchObject({
        errorMessage: piRetryable
          ? exactDiagnostic
          : 'Provider request failed without a safe automatic continuation.',
        happierRequestAuthProviderDiagnostic: exactDiagnostic,
      });
    },
  );

  it('reports retained exact 503 transient evidence when Pi omits onResponse', async () => {
    const reportInputs: Readonly<Record<string, unknown>>[] = [];
    const exactDiagnostic =
      '503 {"type":"error","error":{"type":"api_error","message":"service unavailable"}}';
    const base = provider('anthropic', (_model, _context, options) => (
      async function* transientEvents() {
        await options?.onPayload?.({ stable: true }, { provider: 'anthropic' });
        yield {
          type: 'error',
          reason: 'error',
          error: message('anthropic', 'error', exactDiagnostic),
        };
      }()
    ));
    const registered = await loadExtension({
      providers: [base],
      purposes: { anthropic: PURPOSES.anthropic },
      requestAuth: defaultRequestAuth({
        reportQuota: async (input) => {
          reportInputs.push(input);
          return { status: 'current_unchanged' };
        },
      }),
    });

    const output = await collect(registered[0].stream(
      testModel('anthropic'),
      { messages: [] },
    ));

    expect(reportInputs).toEqual([expect.objectContaining({
      normalizedFailure: {
        class: 'quota',
        evidence: {
          httpStatus: 503,
          limitCategory: 'capacity',
          quotaScope: 'unknown',
          evidenceSource: {
            kind: 'pinnedProviderTerminal',
            producer: 'pi',
            producerVersion: '0.82.0',
            provider: 'anthropic',
            signatureId: 'anthropic-sdk-503-api-error-v1',
          },
        },
      },
    })]);
    expect(output[0]?.error).toMatchObject({
      errorMessage: exactDiagnostic,
      happierRequestAuthProviderDiagnostic: exactDiagnostic,
    });
  });

  it.each([
    {
      status: 400,
      providerType: 'api_error',
      providerMessage: 'invalid request',
      expectedCategory: 'validation_failed',
      expectedProviderCode: undefined,
    },
    {
      status: 402,
      providerType: 'api_error',
      providerMessage: 'payment required',
      expectedCategory: 'plan_invalid',
      expectedProviderCode: undefined,
    },
    {
      status: 403,
      providerType: 'account_disabled',
      providerMessage: 'account disabled',
      expectedCategory: 'disabled',
      expectedProviderCode: 'account_disabled',
    },
    {
      status: 403,
      providerType: 'not_entitled',
      providerMessage: 'not entitled',
      expectedCategory: 'plan_invalid',
      expectedProviderCode: 'not_entitled',
    },
  ])(
    'reports canonical Level-A $status/$providerType evidence once',
    async ({
      status,
      providerType,
      providerMessage,
      expectedCategory,
      expectedProviderCode,
    }) => {
      const reportInputs: Readonly<Record<string, unknown>>[] = [];
      const exactDiagnostic = `${status} ${JSON.stringify({
        type: 'error',
        error: { type: providerType, message: providerMessage },
      })}`;
      const base = provider(
        'anthropic',
        (_model, _context, options) => (async function* structuredEvents() {
          await options?.onPayload?.({ stable: true }, { provider: 'anthropic' });
          await options?.onResponse?.(
            { status, headers: {} },
            { provider: 'anthropic' },
          );
          yield {
            type: 'error',
            reason: 'error',
            error: message('anthropic', 'error', exactDiagnostic),
          };
        }()),
      );
      const registered = await loadExtension({
        providers: [base],
        purposes: { anthropic: PURPOSES.anthropic },
        requestAuth: defaultRequestAuth({
          reportQuota: async (input) => {
            reportInputs.push(input);
            return { status: 'current_unchanged' };
          },
        }),
      });

      const output = await collect(registered[0].stream(
        testModel('anthropic'),
        { messages: [] },
      ));

      expect(reportInputs).toEqual([expect.objectContaining({
        normalizedFailure: {
          class: 'quota',
          evidence: {
            httpStatus: status,
            limitCategory: expectedCategory,
            quotaScope: 'unknown',
            ...(expectedProviderCode
              ? { providerCode: expectedProviderCode }
              : {}),
            evidenceSource: { kind: 'structured' },
          },
        },
      })]);
      expect(output[0]?.error).toMatchObject({
        errorMessage: 'Provider request failed without a safe automatic continuation.',
        happierRequestAuthProviderDiagnostic: exactDiagnostic,
      });
    },
  );

  it('does not promote an unretained terminal-only Provider code to Level-A evidence', async () => {
    const reportInputs: Readonly<Record<string, unknown>>[] = [];
    const exactDiagnostic =
      '403 {"type":"error","error":{"type":"account_disabled","message":"account disabled"}}';
    const base = provider('anthropic', events('anthropic', [{
      type: 'error',
      reason: 'error',
      error: message('anthropic', 'error', exactDiagnostic),
    }]));
    const registered = await loadExtension({
      providers: [base],
      purposes: { anthropic: PURPOSES.anthropic },
      requestAuth: defaultRequestAuth({
        reportAuth: async (input) => {
          reportInputs.push(input);
          return { status: 'current_changed' };
        },
        reportQuota: async (input) => {
          reportInputs.push(input);
          return { status: 'current_changed' };
        },
      }),
    });

    const output = await collect(registered[0].stream(
      testModel('anthropic'),
      { messages: [] },
    ));

    expect(reportInputs).toEqual([]);
    expect(output[0]?.error).toMatchObject({
      errorMessage: 'Provider request failed without a safe automatic continuation.',
      happierRequestAuthProviderDiagnostic: exactDiagnostic,
    });
  });

  it('does not treat a bare 403 response as authentication evidence', async () => {
    const reportInputs: Readonly<Record<string, unknown>>[] = [];
    const exactDiagnostic =
      '403 {"type":"error","error":{"type":"api_error","message":"request rejected"}}';
    const base = provider(
      'anthropic',
      (_model, _context, options) => (async function* forbiddenEvents() {
        await options?.onPayload?.({ stable: true }, { provider: 'anthropic' });
        await options?.onResponse?.(
          { status: 403, headers: {} },
          { provider: 'anthropic' },
        );
        yield {
          type: 'error',
          reason: 'error',
          error: message('anthropic', 'error', exactDiagnostic),
        };
      }()),
    );
    const registered = await loadExtension({
      providers: [base],
      purposes: { anthropic: PURPOSES.anthropic },
      requestAuth: defaultRequestAuth({
        reportAuth: async (input) => {
          reportInputs.push(input);
          return { status: 'current_changed' };
        },
        reportQuota: async (input) => {
          reportInputs.push(input);
          return { status: 'current_changed' };
        },
      }),
    });

    const output = await collect(registered[0].stream(
      testModel('anthropic'),
      { messages: [] },
    ));

    expect(reportInputs).toEqual([]);
    expect(output[0]?.error).toMatchObject({
      errorMessage: 'Provider request failed without a safe automatic continuation.',
      happierRequestAuthProviderDiagnostic: exactDiagnostic,
    });
  });

  it('leaf-replays exact version-pinned Anthropic account exhaustion with fresh auth', async () => {
    let lookupCount = 0;
    let attemptCount = 0;
    const reportInputs: Readonly<Record<string, unknown>>[] = [];
    const base = provider('anthropic', (_model, _context, options) => {
      attemptCount += 1;
      const attempt = attemptCount;
      return (async function* quotaEvents() {
        await options?.onPayload?.({ stable: true }, { provider: 'anthropic' });
        if (attempt === 1) {
          yield {
            type: 'error',
            reason: 'error',
            error: message(
              'anthropic',
              'error',
              '429 {"type":"error","error":{"type":"insufficient_quota","message":"quota exceeded"}}',
            ),
          };
          return;
        }
        yield { type: 'done', reason: 'stop', message: message('anthropic', 'stop') };
      }());
    });
    const registered = await loadExtension({
      providers: [base],
      purposes: { anthropic: PURPOSES.anthropic },
      requestAuth: defaultRequestAuth({
        lookup: async () => {
          lookupCount += 1;
          return {
            accessToken: `lease-${lookupCount}`,
            credentialContext: {
              account: {
                service: { pluginId: 'happier.connected-accounts', localId: 'anthropic' },
                profileId: `profile-${lookupCount}`,
              },
              credentialRevision: `revision-${lookupCount}`,
            },
          };
        },
        reportQuota: async (input) => {
          reportInputs.push(input);
          return { status: 'current_changed' };
        },
      }),
    });

    const output = await collect(registered[0].stream(
      testModel('anthropic'),
      { messages: [] },
    ));

    expect(output.map((event) => event.type)).toEqual(['done']);
    expect(attemptCount).toBe(2);
    expect(lookupCount).toBe(2);
    expect(reportInputs).toEqual([expect.objectContaining({
      normalizedFailure: {
        class: 'quota',
        evidence: expect.objectContaining({
          limitCategory: 'usage_limit',
          quotaScope: 'account',
          evidenceSource: expect.objectContaining({
            kind: 'pinnedProviderTerminal',
            signatureId: 'anthropic-sdk-429-account-exhaustion-v1',
          }),
        }),
      },
    })]);
  });

  it('does not infer Anthropic recovery from incidental terminal error text', async () => {
    let reportCount = 0;
    let lookupCount = 0;
    const base = provider('anthropic', events('anthropic', [{
      type: 'error',
      reason: 'error',
      error: message('anthropic', 'error', '401 invalid bearer'),
    }]));
    const registered = await loadExtension({
      providers: [base],
      purposes: { anthropic: PURPOSES.anthropic },
      requestAuth: defaultRequestAuth({
        lookup: async (input) => {
          lookupCount += 1;
          return defaultRequestAuth().lookup(input);
        },
        reportAuth: async () => {
          reportCount += 1;
          return { status: 'current_changed' };
        },
      }),
    });

    const output = await collect(registered[0].stream(
      testModel('anthropic'),
      { messages: [] },
    ));

    expect(output.map((event) => event.type)).toEqual(['error']);
    expect(lookupCount).toBe(1);
    expect(reportCount).toBe(0);
    expect(output[0]?.error).toMatchObject({
      errorMessage: 'Provider request failed without a safe automatic continuation.',
      happierRequestAuthProviderDiagnostic: '401 invalid bearer',
    });
  });

  it('suppresses Pi replay for ambiguous retry-looking terminal text and unsupported versions', async () => {
    const reportInputs: Readonly<Record<string, unknown>>[] = [];
    const base = provider('anthropic', events('anthropic', [{
      type: 'error',
      reason: 'error',
      error: message(
        'anthropic',
        'error',
        '400 {"type":"error","error":{"type":"invalid_request_error","message":"rate limit maybe; contact support"}}',
      ),
    }]));
    const registered = await loadExtension({
      providers: [base],
      purposes: { anthropic: PURPOSES.anthropic },
      producerVersion: '0.83.0',
      requestAuth: defaultRequestAuth({
        reportAuth: async (input) => {
          reportInputs.push(input);
          return { status: 'current_changed' };
        },
        reportQuota: async (input) => {
          reportInputs.push(input);
          return { status: 'current_changed' };
        },
      }),
    });

    const output = await collect(registered[0].stream(
      testModel('anthropic'),
      { messages: [] },
    ));

    expect(reportInputs).toEqual([]);
    expect(output[0]?.error).toMatchObject({
      errorMessage: 'Provider request failed without a safe automatic continuation.',
      happierRequestAuthProviderDiagnostic:
        '400 {"type":"error","error":{"type":"invalid_request_error","message":"rate limit maybe; contact support"}}',
    });
  });

  it.each(['0.83.0', '0.82.1+fork.7'])(
    'retains structured Level-A evidence but keeps replay closed for unpinned producer %s',
    async (producerVersion) => {
      let attemptCount = 0;
      const reportInputs: Readonly<Record<string, unknown>>[] = [];
      const exactDiagnostic =
        '429 {"type":"error","error":{"type":"insufficient_quota","message":"future provider wording"}}';
      const base = provider(
        'anthropic',
        (_model, _context, options) => (async function* structuredEvents() {
          attemptCount += 1;
          await options?.onPayload?.({ stable: true }, { provider: 'anthropic' });
          await options?.onResponse?.(
            { status: 429, headers: {} },
            { provider: 'anthropic' },
          );
          yield {
            type: 'error',
            reason: 'error',
            error: message('anthropic', 'error', exactDiagnostic),
          };
        }()),
      );
      const registered = await loadExtension({
        providers: [base],
        purposes: { anthropic: PURPOSES.anthropic },
        producerVersion,
        requestAuth: defaultRequestAuth({
          reportQuota: async (input) => {
            reportInputs.push(input);
            return { status: 'current_changed' };
          },
        }),
      });

      const output = await collect(registered[0].stream(
        testModel('anthropic'),
        { messages: [] },
      ));

      expect(attemptCount).toBe(1);
      expect(reportInputs).toEqual([expect.objectContaining({
        normalizedFailure: {
          class: 'quota',
          evidence: {
            httpStatus: 429,
            providerCode: 'insufficient_quota',
            limitCategory: 'usage_limit',
            quotaScope: 'unknown',
            evidenceSource: { kind: 'structured' },
          },
        },
      })]);
      expect(output[0]?.error).toMatchObject({
        errorMessage: 'Provider request failed without a safe automatic continuation.',
        happierRequestAuthProviderDiagnostic: exactDiagnostic,
      });
    },
  );

  it.each(['0.82.2', '0.82.1+fork.7'])(
    'fails reporting and Pi replay ownership closed for unpinned Anthropic producer %s',
    async (producerVersion) => {
      let attemptCount = 0;
      const reportInputs: Readonly<Record<string, unknown>>[] = [];
      const exactDiagnostic =
        '429 {"type":"error","error":{"type":"rate_limit_error","message":"rate limit exceeded"}}';
      const base = provider('anthropic', (_model, _context, options) => {
        attemptCount += 1;
        return (async function* rateLimitEvents() {
          await options?.onPayload?.({ stable: true }, { provider: 'anthropic' });
          yield {
            type: 'error',
            reason: 'error',
            error: message('anthropic', 'error', exactDiagnostic),
          };
        }());
      });
      const registered = await loadExtension({
        providers: [base],
        purposes: { anthropic: PURPOSES.anthropic },
        producerVersion,
        requestAuth: defaultRequestAuth({
          reportQuota: async (input) => {
            reportInputs.push(input);
            return { status: 'current_unchanged' };
          },
        }),
      });

      const output = await collect(registered[0].stream(
        testModel('anthropic'),
        { messages: [] },
      ));

      expect(attemptCount).toBe(1);
      expect(reportInputs).toHaveLength(0);
      expect(output[0]?.error).toMatchObject({
        errorMessage: 'Provider request failed without a safe automatic continuation.',
        happierRequestAuthProviderDiagnostic: exactDiagnostic,
      });
    },
  );

  it('suppresses Pi replay when output escaped before an otherwise retryable terminal failure', async () => {
    const reportInputs: Readonly<Record<string, unknown>>[] = [];
    const base = provider('anthropic', events('anthropic', [
      { type: 'start', partial: message('anthropic', 'stop') },
      {
        type: 'text_delta',
        contentIndex: 0,
        delta: 'partial output',
        partial: message('anthropic', 'stop'),
      },
      {
        type: 'error',
        reason: 'error',
        error: message(
          'anthropic',
          'error',
          '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
        ),
      },
    ]));
    const registered = await loadExtension({
      providers: [base],
      purposes: { anthropic: PURPOSES.anthropic },
      requestAuth: defaultRequestAuth({
        reportQuota: async (input) => {
          reportInputs.push(input);
          return { status: 'current_changed' };
        },
      }),
    });

    const output = await collect(registered[0].stream(
      testModel('anthropic'),
      { messages: [] },
    ));

    expect(output.map((event) => event.type)).toEqual(['start', 'text_delta', 'error']);
    expect(reportInputs).toEqual([]);
    expect(output[2]?.error).toMatchObject({
      errorMessage: 'Provider request failed without a safe automatic continuation.',
      happierRequestAuthProviderDiagnostic:
        '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    });
  });

  it('does not hand an admitted Pi retry back to AgentSession after cancellation during reporting', async () => {
    const controller = new AbortController();
    let upstreamCalls = 0;
    let reportStarted!: () => void;
    const reporting = new Promise<void>((resolve) => {
      reportStarted = resolve;
    });
    let releaseReport!: () => void;
    const reportRelease = new Promise<void>((resolve) => {
      releaseReport = resolve;
    });
    const base = provider('anthropic', (_model, _context, options) => {
      upstreamCalls += 1;
      return (async function* rateLimitEvents() {
        await options?.onPayload?.({ stable: true }, { provider: 'anthropic' });
        await options?.onResponse?.({ status: 429, headers: {} }, { provider: 'anthropic' });
        yield {
          type: 'error',
          reason: 'error',
          error: message(
            'anthropic',
            'error',
            '429 {"type":"error","error":{"type":"rate_limit_error","message":"rate limit exceeded"}}',
          ),
        };
      }());
    });
    const registered = await loadExtension({
      providers: [base],
      purposes: { anthropic: PURPOSES.anthropic },
      requestAuth: defaultRequestAuth({
        reportQuota: async () => {
          reportStarted();
          await reportRelease;
          return { status: 'current_unchanged' };
        },
      }),
    });

    const outputPromise = collect(registered[0].stream(
      testModel('anthropic'),
      { messages: [] },
      { signal: controller.signal },
    ));
    await reporting;
    controller.abort();
    releaseReport();
    const output = await outputPromise;

    expect(upstreamCalls).toBe(1);
    expect(output).toEqual([expect.objectContaining({
      type: 'error',
      reason: 'error',
      error: expect.objectContaining({
        stopReason: 'error',
        errorMessage: 'Provider request failed without a safe automatic continuation.',
        happierRequestAuthProviderDiagnostic:
          '429 {"type":"error","error":{"type":"rate_limit_error","message":"rate limit exceeded"}}',
      }),
    })]);
  });

  it('preserves cancellation across lookup and prevents the upstream attempt', async () => {
    const controller = new AbortController();
    controller.abort();
    let upstreamCalls = 0;
    const base = provider('anthropic', () => {
      upstreamCalls += 1;
      return (async function* empty() {})();
    });
    const registered = await loadExtension({
      providers: [base],
      purposes: { anthropic: PURPOSES.anthropic },
      requestAuth: defaultRequestAuth({
        lookup: async ({ signal }) => {
          expect(signal).toBe(controller.signal);
          throw signal?.reason ?? new DOMException('aborted', 'AbortError');
        },
      }),
    });

    const output = await collect(registered[0].stream(
      testModel('anthropic'),
      { messages: [] },
      { signal: controller.signal },
    ));

    expect(output).toEqual([expect.objectContaining({
      type: 'error',
      reason: 'aborted',
      error: expect.objectContaining({ stopReason: 'aborted' }),
    })]);
    expect(upstreamCalls).toBe(0);
  });
});
