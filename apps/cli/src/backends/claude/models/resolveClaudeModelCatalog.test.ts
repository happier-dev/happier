import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { CLAUDE_AUTH_ENV_KEYS } from '@/backends/claude/auth/claudeAuthEnvKeys';

import type { AnthropicModelEntry } from './fetchAnthropicModels';

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { once } from 'node:events';

import { buildClaudeEffortCliArgs } from '@/backends/claude/utils/claudeEffort';
import {
  resolveClaudeEffortLevelsFromModelDescriptor,
  resolveClaudeModelCatalog,
  resolveClaudeModelCatalogResolution,
  resetClaudeModelCatalogCacheForTests,
} from './resolveClaudeModelCatalog';

// Only the HTTP transport is replaced; settings, helper execution, credential resolution,
// response parsing, and catalog enrichment all run through their real owners.
const realFetch = globalThis.fetch;
const fetchMock = vi.fn<typeof fetch>();
let configDir: string;
/** Encode endpoint-shaped responses while keeping credential, parser and catalog logic real. */
function modelsResponse(entries: AnthropicModelEntry[] | null): Response {
  return new Response(JSON.stringify({ data: entries?.map(entry => ({
    id: entry.id, display_name: entry.displayName, max_input_tokens: entry.maxInputTokens,
    capabilities: entry.capabilities,
  })) }), { status: entries === null ? 503 : 200 });
}
async function writeNativeToken(token: string): Promise<void> {
  await writeFile(join(configDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: token, scopes: [] } }));
}

const envKeys = [
  'CLAUDE_CONFIG_DIR',
  ...CLAUDE_AUTH_ENV_KEYS,
  'ANTHROPIC_BASE_URL',
  'HAPPIER_CLAUDE_DYNAMIC_MODEL_PROBE_ENABLED',
] as const;
let envScope = createEnvKeyScope(envKeys);

function fullEffort(): AnthropicModelEntry['capabilities'] {
  return {
    effort: {
      supported: true,
      low: { supported: true },
      high: { supported: true },
      xhigh: { supported: true },
    },
  };
}

beforeEach(async () => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  resetClaudeModelCatalogCacheForTests();
  envScope.restore();
  envScope = createEnvKeyScope(envKeys);
  for (const key of envKeys) delete process.env[key];
  configDir = await mkdtemp(join(tmpdir(), 'happier-claude-model-catalog-'));
  process.env.CLAUDE_CONFIG_DIR = configDir;
});

afterEach(async () => {
  resetClaudeModelCatalogCacheForTests();
  vi.unstubAllGlobals();
  envScope.restore();
  await rm(configDir, { recursive: true, force: true });
});

describe('resolveClaudeModelCatalog', () => {
  it('uses only the static catalog when the Claude account setting disables dynamic discovery', async () => {
    await writeNativeToken('sk-ant-oat01-native-account');
    process.env.ANTHROPIC_API_KEY = 'sk-ant-explicit-key';
    fetchMock.mockImplementation(async () => modelsResponse([{ id: 'claude-account-only', displayName: 'Account only' }]));

    const resolution = await resolveClaudeModelCatalogResolution({
      timeoutMs: 1_000,
      accountSettings: { claudeDynamicModelProbeEnabled: false },
    });

    expect(resolution.source).toBe('static');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses only the static catalog when the CLI environment disables Claude dynamic discovery', async () => {
    await writeNativeToken('sk-ant-oat01-native-account');
    process.env.HAPPIER_CLAUDE_DYNAMIC_MODEL_PROBE_ENABLED = '0';
    fetchMock.mockImplementation(async () => modelsResponse([{ id: 'claude-account-only', displayName: 'Account only' }]));

    const resolution = await resolveClaudeModelCatalogResolution({
      timeoutMs: 1_000,
      accountSettings: { claudeDynamicModelProbeEnabled: true },
    });

    expect(resolution.source).toBe('static');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses a successful response as membership authority and enriches matching rows without overriding API facts', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
    fetchMock.mockImplementation(async () => modelsResponse([
      {
        id: 'claude-sonnet-4-6',
        displayName: 'Claude Sonnet 4.6',
        maxInputTokens: 222_222,
        capabilities: {
          effort: {
            supported: true,
            low: { supported: true },
            medium: { supported: true },
            high: { supported: true },
            max: { supported: true },
          },
        },
      },
    ]));

    const models = await resolveClaudeModelCatalog({ timeoutMs: 1_000 });

    expect(models).toHaveLength(1);
    expect(models[0]).toEqual(expect.objectContaining({
      id: 'claude-sonnet-4-6',
      name: 'Sonnet 4.6',
      description: expect.any(String),
      contextWindowTokens: 222_222,
      extendedContextModelId: 'claude-sonnet-4-6[1m]',
    }));
    expect(resolveClaudeEffortLevelsFromModelDescriptor(models[0])).toEqual(['low', 'medium', 'high', 'max']);
  });

  it('retains every exact returned id when an alias and dated snapshot normalize to the same curated row', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
    fetchMock.mockImplementation(async () => modelsResponse([
      { id: 'claude-sonnet-4-6', displayName: 'Sonnet Alias' },
      { id: 'claude-sonnet-4-6-20260812', displayName: 'Sonnet Snapshot' },
    ]));

    const models = await resolveClaudeModelCatalog({ timeoutMs: 1_000 });

    expect(models).toEqual([
      expect.objectContaining({ id: 'claude-sonnet-4-6', name: 'Sonnet 4.6' }),
      expect.objectContaining({
        id: 'claude-sonnet-4-6-20260812',
        name: 'Sonnet 4.6',
        extendedContextModelId: 'claude-sonnet-4-6-20260812[1m]',
      }),
    ]);
  });

  it('deduplicates only repeated exact returned ids', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
    fetchMock.mockImplementation(async () => modelsResponse([
      { id: 'claude-opus-9', displayName: 'Opus 9 First' },
      { id: 'claude-opus-9', displayName: 'Opus 9 Duplicate' },
      { id: 'claude-opus-9-20260812', displayName: 'Opus 9 Snapshot' },
    ]));

    const models = await resolveClaudeModelCatalog({ timeoutMs: 1_000 });

    expect(models.map((model) => ({ id: model.id, name: model.name }))).toEqual([
      { id: 'claude-opus-9', name: 'Opus 9 First' },
      { id: 'claude-opus-9-20260812', name: 'Opus 9 Snapshot' },
    ]);
  });

  it('does not apply a curated-generation floor to account-returned ids', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
    fetchMock.mockImplementation(async () => modelsResponse([
      { id: 'claude-2.1-account-model', displayName: 'Account Legacy Model' },
    ]));

    const models = await resolveClaudeModelCatalog({ timeoutMs: 1_000 });

    expect(models).toEqual([
      expect.objectContaining({ id: 'claude-2.1-account-model', name: 'Account Legacy Model' }),
    ]);
  });

  it('records a successful endpoint response as dynamic even when every id is already curated', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
    fetchMock.mockImplementation(async () => modelsResponse([
      { id: 'claude-fable-5', displayName: 'Claude Fable 5' },
    ]));

    const resolution = await resolveClaudeModelCatalogResolution({ timeoutMs: 1_000 });

    expect(resolution.source).toBe('dynamic');
    expect(resolution.models.some((model) => model.id === 'claude-fable-5')).toBe(true);
  });

  it('treats a successful empty response as authoritative empty membership', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
    fetchMock.mockImplementation(async () => modelsResponse([]));

    const resolution = await resolveClaudeModelCatalogResolution({ timeoutMs: 1_000 });

    expect(resolution).toEqual({ models: [], source: 'dynamic', observedAt: expect.any(Number) });
  });

  it('serves a cached catalog and never substitutes ambient auth for a selected account', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
    fetchMock.mockImplementation(async () => modelsResponse([{ id: 'claude-opus-9', displayName: 'Opus 9' }]));

    await resolveClaudeModelCatalog({ timeoutMs: 1_000 });
    await resolveClaudeModelCatalog({ timeoutMs: 1_000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // An unavailable selected account cannot use the ambient key, saved login, or their cache.
    await writeNativeToken('sk-ant-oat01-profile-a');
    const boundResult = await resolveClaudeModelCatalog({
      timeoutMs: 1_000,
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': { source: 'connected', selection: 'profile', profileId: 'profile-a' },
        },
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(boundResult.some((model) => model.id === 'claude-opus-9')).toBe(false);
  });

  it('discovers gateway models with the Claude Code apiKeyHelper key', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.example/anthropic';
    await writeFile(join(configDir, 'settings.json'), JSON.stringify({ apiKeyHelper: 'echo helper-key' }));
    fetchMock.mockImplementation(async () => modelsResponse([{ id: 'gateway/model', displayName: 'Gateway model' }]));

    const resolution = await resolveClaudeModelCatalogResolution({ timeoutMs: 1_000 });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://gateway.example/anthropic/v1/models?limit=1000');
    const headers = new Headers(init?.headers);
    expect(headers.get('x-api-key')).toBe('helper-key');
    expect(headers.get('Authorization')).toBe('Bearer helper-key');
    expect(headers.has('anthropic-beta')).toBe(false);
    expect(resolution.source).toBe('dynamic');
    expect(resolution.models.map((model) => model.id)).toContain('gateway/model');
  });

  it('discovers through a real helper and HTTP gateway and isolates rotated credentials', async () => {
    vi.stubGlobal('fetch', realFetch);
    const requests: { url: string | undefined; headers: IncomingHttpHeaders }[] = [];
    const server = createServer((request, response) => {
      requests.push({ url: request.url, headers: request.headers });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: `gateway/${request.headers['x-api-key']}` }] }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP gateway');
    try {
      await writeFile(join(configDir, 'settings.json'), JSON.stringify({
        apiKeyHelper: process.platform === 'win32' ? 'echo %HELPER_TOKEN%' : 'echo "$HELPER_TOKEN"',
      }));
      const processEnv = { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}/gateway/anthropic`,
        CLAUDE_CODE_OAUTH_TOKEN: 'other-account', HELPER_TOKEN: 'first-key' };
      const first = await resolveClaudeModelCatalogResolution({ timeoutMs: 5_000, processEnv });
      expect(first).toMatchObject({ source: 'dynamic', models: [{ id: 'gateway/first-key' }] });
      const second = await resolveClaudeModelCatalogResolution({ timeoutMs: 5_000,
        processEnv: { ...processEnv, HELPER_TOKEN: 'second-key' } });
      expect(second).toMatchObject({ source: 'dynamic', models: [{ id: 'gateway/second-key' }] });
      expect(requests.map(request => request.url)).toEqual([
        '/gateway/anthropic/v1/models?limit=1000', '/gateway/anthropic/v1/models?limit=1000',
      ]);
      expect(requests.map(request => request.headers.authorization)).toEqual(['Bearer first-key', 'Bearer second-key']);
      expect(requests.every(request => !request.headers['anthropic-beta'])).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('does not query a saved subscription account when a configured helper fails', async () => {
    await writeNativeToken('other-subscription-account');
    await writeFile(join(configDir, 'settings.json'), JSON.stringify({ apiKeyHelper: 'exit 3' }));
    fetchMock.mockImplementation(async () => modelsResponse([{ id: 'wrong-account-model' }]));
    const resolution = await resolveClaudeModelCatalogResolution({ timeoutMs: 1_000 });
    expect(resolution).toMatchObject({ source: 'static', refreshError: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refetches when the ambient credential changes', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-key-one';
    fetchMock.mockImplementation(async () => modelsResponse([{ id: 'claude-opus-9', displayName: 'Opus 9' }]));
    await resolveClaudeModelCatalog({ timeoutMs: 1_000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Swapping the key without changing the config dir must not serve the previous key's list.
    process.env.ANTHROPIC_API_KEY = 'sk-ant-key-two';
    await resolveClaudeModelCatalog({ timeoutMs: 1_000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('bounds retained snapshots across rotated credential identities', async () => {
    fetchMock.mockImplementation(async () => modelsResponse([{ id: 'claude-opus-9', displayName: 'Opus 9' }]));

    for (let index = 0; index < 33; index += 1) {
      process.env.ANTHROPIC_API_KEY = `sk-ant-rotated-${index}`;
      await resolveClaudeModelCatalog({ timeoutMs: 1_000 });
    }
    expect(fetchMock).toHaveBeenCalledTimes(33);

    process.env.ANTHROPIC_API_KEY = 'sk-ant-rotated-0';
    await resolveClaudeModelCatalog({ timeoutMs: 1_000 });

    expect(fetchMock).toHaveBeenCalledTimes(34);
  });

  it('refetches when the on-disk credential is replaced in the same config dir', async () => {
    await writeNativeToken('sk-ant-oat01-account-one');
    fetchMock.mockImplementation(async () => modelsResponse([{ id: 'claude-opus-9', displayName: 'Opus 9' }]));
    await resolveClaudeModelCatalog({ timeoutMs: 1_000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Re-authing the same slot to a different account must not inherit the previous list for the
    // rest of the TTL — the config dir is unchanged, so the credential itself has to key the cache.
    await writeNativeToken('sk-ant-oat01-account-two');
    await resolveClaudeModelCatalog({ timeoutMs: 1_000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not let an unreadable credential evict a valid cached catalog', async () => {
    await writeNativeToken('sk-ant-oat01-account');
    fetchMock.mockImplementation(async () => modelsResponse([{ id: 'claude-opus-9', displayName: 'Opus 9' }]));
    const warm = await resolveClaudeModelCatalog({ timeoutMs: 1_000 });
    expect(warm.some((m) => m.id === 'claude-opus-9')).toBe(true);

    // A transient credential read failure degrades this call to the curated catalog...
    await writeFile(join(configDir, '.credentials.json'), '{ invalid JSON');
    const degraded = await resolveClaudeModelCatalog({ timeoutMs: 1_000 });
    expect(degraded.some((m) => m.id === 'claude-opus-9')).toBe(false);

    // ...but must not have evicted or shadowed the still-valid entry: recovery is immediate and
    // does not require a refetch.
    await writeNativeToken('sk-ant-oat01-account');
    const recovered = await resolveClaudeModelCatalog({ timeoutMs: 1_000 });
    expect(recovered.some((m) => m.id === 'claude-opus-9')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('carries the extended-context model id through to the picker rows', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
    fetchMock.mockImplementation(async () => modelsResponse(null));

    const models = await resolveClaudeModelCatalog({ timeoutMs: 1_000 });
    const sonnet = models.find((m) => m.id === 'claude-sonnet-4-6') ?? null;

    expect(typeof sonnet?.extendedContextModelId).toBe('string');
  });

  it('falls back to the curated catalog when the fetch fails', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
    fetchMock.mockImplementation(async () => modelsResponse(null));

    const models = await resolveClaudeModelCatalog({ timeoutMs: 1_000 });

    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.id === 'claude-fable-5')).toBe(true);
    expect(models.some((m) => m.id === 'claude-opus-9')).toBe(false);
  });

  it('retains the last successful dynamic snapshot when a later refresh fails', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
    let currentTimeMs = 10;
    fetchMock
      .mockImplementationOnce(async () => modelsResponse([{ id: 'claude-opus-9', displayName: 'Opus 9' }]))
      .mockImplementationOnce(async () => modelsResponse(null));

    const first = await resolveClaudeModelCatalogResolution({
      timeoutMs: 1_000,
      nowMs: () => currentTimeMs,
    });
    currentTimeMs += 24 * 60 * 60 * 1_000 + 1;
    const stale = await resolveClaudeModelCatalogResolution({
      timeoutMs: 1_000,
      nowMs: () => currentTimeMs,
    });
    currentTimeMs += 1;
    const staleDuringFailureCooldown = await resolveClaudeModelCatalogResolution({
      timeoutMs: 1_000,
      nowMs: () => currentTimeMs,
    });

    expect(first).toEqual(expect.objectContaining({ source: 'dynamic' }));
    expect(stale).toEqual({ ...first, refreshError: true });
    expect(staleDuringFailureCooldown).toEqual(stale);
    expect(stale.models.map((model) => model.id)).toEqual(['claude-opus-9']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not let another account refresh discard an expired dynamic snapshot before its own refresh', async () => {
    let currentTimeMs = 10;
    fetchMock
      .mockImplementationOnce(async () => modelsResponse([{ id: 'claude-account-a', displayName: 'Account A' }]))
      .mockImplementationOnce(async () => modelsResponse([{ id: 'claude-account-b', displayName: 'Account B' }]))
      .mockImplementationOnce(async () => modelsResponse(null));

    process.env.ANTHROPIC_API_KEY = 'sk-ant-account-a';
    const accountA = await resolveClaudeModelCatalogResolution({
      timeoutMs: 1_000,
      nowMs: () => currentTimeMs,
    });

    currentTimeMs += 24 * 60 * 60 * 1_000 + 1;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-account-b';
    await resolveClaudeModelCatalogResolution({
      timeoutMs: 1_000,
      nowMs: () => currentTimeMs,
    });

    process.env.ANTHROPIC_API_KEY = 'sk-ant-account-a';
    const staleAccountA = await resolveClaudeModelCatalogResolution({
      timeoutMs: 1_000,
      nowMs: () => currentTimeMs,
    });

    expect(staleAccountA).toEqual({ ...accountA, refreshError: true });
    expect(staleAccountA.models.map((model) => model.id)).toEqual(['claude-account-a']);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('resolveClaudeEffortLevelsFromModelDescriptor', () => {
  it('reads the reported tiers off a discovered model descriptor', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
    fetchMock.mockImplementation(async () => modelsResponse([
      { id: 'claude-opus-9', displayName: 'Opus 9', capabilities: fullEffort() },
    ]));

    const models = await resolveClaudeModelCatalog({ timeoutMs: 1_000 });
    const discovered = models.find((m) => m.id === 'claude-opus-9') ?? null;

    expect(resolveClaudeEffortLevelsFromModelDescriptor(discovered)).toEqual(['low', 'high', 'xhigh']);
  });

  it('returns no tiers for a model without an effort control', () => {
    expect(resolveClaudeEffortLevelsFromModelDescriptor(null)).toEqual([]);
    expect(resolveClaudeEffortLevelsFromModelDescriptor({})).toEqual([]);
  });
});

describe('effort tiers carried on the mode', () => {
  it('clamps a carried effort to the tiers the resolved catalog reports', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
    fetchMock.mockImplementation(async () => modelsResponse([
      { id: 'claude-opus-9', displayName: 'Opus 9', capabilities: fullEffort() },
    ]));

    const models = await resolveClaudeModelCatalog({ timeoutMs: 1_000 });
    const levels = resolveClaudeEffortLevelsFromModelDescriptor(
      models.find((m) => m.id === 'claude-opus-9') ?? null,
    );

    expect(buildClaudeEffortCliArgs({ modelId: 'claude-opus-9', effort: 'xhigh', supportedLevels: levels }))
      .toEqual(['--effort', 'xhigh']);
    // Carried level above what the model reports clamps down instead of passing through.
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-opus-9', effort: 'max', supportedLevels: levels }))
      .toEqual(['--effort', 'xhigh']);
    // A mode built before the catalog resolved carries no tiers: nothing is sent.
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-opus-9', effort: 'max' })).toEqual([]);
  });
});
