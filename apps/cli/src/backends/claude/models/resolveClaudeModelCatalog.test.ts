import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';

import type { AnthropicModelEntry } from './fetchAnthropicModels';

const { fetchAnthropicModelsMock, readClaudeCodeNativeCredentialMock } = vi.hoisted(() => ({
  fetchAnthropicModelsMock: vi.fn<(...args: unknown[]) => Promise<AnthropicModelEntry[] | null>>(),
  readClaudeCodeNativeCredentialMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock('./fetchAnthropicModels', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./fetchAnthropicModels')>();
  return { ...actual, fetchAnthropicModels: fetchAnthropicModelsMock };
});

vi.mock('@/backends/claude/connectedServices/nativeAuth/claudeCodeCredentialFile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/backends/claude/connectedServices/nativeAuth/claudeCodeCredentialFile')>();
  return { ...actual, readClaudeCodeNativeCredential: readClaudeCodeNativeCredentialMock };
});

import { buildClaudeEffortCliArgs } from '@/backends/claude/utils/claudeEffort';
import {
  resolveClaudeEffortLevelsFromModelDescriptor,
  resolveClaudeModelCatalog,
  resolveClaudeModelCatalogResolution,
  resetClaudeModelCatalogCacheForTests,
} from './resolveClaudeModelCatalog';

const envKeys = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
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

beforeEach(() => {
  fetchAnthropicModelsMock.mockReset();
  readClaudeCodeNativeCredentialMock.mockReset();
  readClaudeCodeNativeCredentialMock.mockResolvedValue(null);
  resetClaudeModelCatalogCacheForTests();
  envScope.restore();
  envScope = createEnvKeyScope(envKeys);
});

afterEach(() => {
  // Leave no cached catalog behind: the cache is module state, so a later suite sharing this
  // module context would otherwise read entries this one populated.
  resetClaudeModelCatalogCacheForTests();
  envScope.restore();
  envScope = createEnvKeyScope(envKeys);
});

describe('resolveClaudeModelCatalog', () => {
  it('uses a successful response as membership authority and enriches matching rows without overriding API facts', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
    fetchAnthropicModelsMock.mockResolvedValue([
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
    ]);

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
    fetchAnthropicModelsMock.mockResolvedValue([
      { id: 'claude-sonnet-4-6', displayName: 'Sonnet Alias' },
      { id: 'claude-sonnet-4-6-20260812', displayName: 'Sonnet Snapshot' },
    ]);

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
    fetchAnthropicModelsMock.mockResolvedValue([
      { id: 'claude-opus-9', displayName: 'Opus 9 First' },
      { id: 'claude-opus-9', displayName: 'Opus 9 Duplicate' },
      { id: 'claude-opus-9-20260812', displayName: 'Opus 9 Snapshot' },
    ]);

    const models = await resolveClaudeModelCatalog({ timeoutMs: 1_000 });

    expect(models.map((model) => ({ id: model.id, name: model.name }))).toEqual([
      { id: 'claude-opus-9', name: 'Opus 9 First' },
      { id: 'claude-opus-9-20260812', name: 'Opus 9 Snapshot' },
    ]);
  });

  it('does not apply a curated-generation floor to account-returned ids', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
    fetchAnthropicModelsMock.mockResolvedValue([
      { id: 'claude-2.1-account-model', displayName: 'Account Legacy Model' },
    ]);

    const models = await resolveClaudeModelCatalog({ timeoutMs: 1_000 });

    expect(models).toEqual([
      expect.objectContaining({ id: 'claude-2.1-account-model', name: 'Account Legacy Model' }),
    ]);
  });

  it('records a successful endpoint response as dynamic even when every id is already curated', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
    fetchAnthropicModelsMock.mockResolvedValue([
      { id: 'claude-fable-5', displayName: 'Claude Fable 5' },
    ]);

    const resolution = await resolveClaudeModelCatalogResolution({ timeoutMs: 1_000 });

    expect(resolution.source).toBe('dynamic');
    expect(resolution.models.some((model) => model.id === 'claude-fable-5')).toBe(true);
  });

  it('treats a successful empty response as authoritative empty membership', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
    fetchAnthropicModelsMock.mockResolvedValue([]);

    const resolution = await resolveClaudeModelCatalogResolution({ timeoutMs: 1_000 });

    expect(resolution).toEqual({ models: [], source: 'dynamic' });
  });

  it('serves a cached catalog and never substitutes ambient auth for a selected account', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
    fetchAnthropicModelsMock.mockResolvedValue([{ id: 'claude-opus-9', displayName: 'Opus 9' }]);

    await resolveClaudeModelCatalog({ timeoutMs: 1_000 });
    await resolveClaudeModelCatalog({ timeoutMs: 1_000 });
    expect(fetchAnthropicModelsMock).toHaveBeenCalledTimes(1);

    // A bound session ignores the ambient key (the spawn strips it) and reads the account's own
    // on-disk credential — and must not read the unbound account's cached catalog.
    readClaudeCodeNativeCredentialMock.mockResolvedValue({
      payload: { claudeAiOauth: { accessToken: 'sk-ant-oat01-profile-a', scopes: [] } },
      updatedAtMs: 0,
      source: 'file',
    });
    const boundResult = await resolveClaudeModelCatalog({
      timeoutMs: 1_000,
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': { source: 'connected', selection: 'profile', profileId: 'profile-a' },
        },
      },
    });
    expect(fetchAnthropicModelsMock).toHaveBeenCalledTimes(1);
    expect(boundResult.some((model) => model.id === 'claude-opus-9')).toBe(false);
  });

  it('refetches when the ambient credential changes', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-key-one';
    fetchAnthropicModelsMock.mockResolvedValue([{ id: 'claude-opus-9', displayName: 'Opus 9' }]);
    await resolveClaudeModelCatalog({ timeoutMs: 1_000 });
    expect(fetchAnthropicModelsMock).toHaveBeenCalledTimes(1);

    // Swapping the key without changing the config dir must not serve the previous key's list.
    process.env.ANTHROPIC_API_KEY = 'sk-ant-key-two';
    await resolveClaudeModelCatalog({ timeoutMs: 1_000 });
    expect(fetchAnthropicModelsMock).toHaveBeenCalledTimes(2);
  });

  it('bounds retained snapshots across rotated credential identities', async () => {
    fetchAnthropicModelsMock.mockResolvedValue([{ id: 'claude-opus-9', displayName: 'Opus 9' }]);

    for (let index = 0; index < 33; index += 1) {
      process.env.ANTHROPIC_API_KEY = `sk-ant-rotated-${index}`;
      await resolveClaudeModelCatalog({ timeoutMs: 1_000 });
    }
    expect(fetchAnthropicModelsMock).toHaveBeenCalledTimes(33);

    process.env.ANTHROPIC_API_KEY = 'sk-ant-rotated-0';
    await resolveClaudeModelCatalog({ timeoutMs: 1_000 });

    expect(fetchAnthropicModelsMock).toHaveBeenCalledTimes(34);
  });

  it('refetches when the on-disk credential is replaced in the same config dir', async () => {
    readClaudeCodeNativeCredentialMock.mockResolvedValue({
      payload: { claudeAiOauth: { accessToken: 'sk-ant-oat01-account-one', scopes: [] } },
      updatedAtMs: 0,
      source: 'file',
    });
    fetchAnthropicModelsMock.mockResolvedValue([{ id: 'claude-opus-9', displayName: 'Opus 9' }]);
    await resolveClaudeModelCatalog({ timeoutMs: 1_000 });
    expect(fetchAnthropicModelsMock).toHaveBeenCalledTimes(1);

    // Re-authing the same slot to a different account must not inherit the previous list for the
    // rest of the TTL — the config dir is unchanged, so the credential itself has to key the cache.
    readClaudeCodeNativeCredentialMock.mockResolvedValue({
      payload: { claudeAiOauth: { accessToken: 'sk-ant-oat01-account-two', scopes: [] } },
      updatedAtMs: 1,
      source: 'file',
    });
    await resolveClaudeModelCatalog({ timeoutMs: 1_000 });
    expect(fetchAnthropicModelsMock).toHaveBeenCalledTimes(2);
  });

  it('does not let an unreadable credential evict a valid cached catalog', async () => {
    readClaudeCodeNativeCredentialMock.mockResolvedValue({
      payload: { claudeAiOauth: { accessToken: 'sk-ant-oat01-account', scopes: [] } },
      updatedAtMs: 0,
      source: 'file',
    });
    fetchAnthropicModelsMock.mockResolvedValue([{ id: 'claude-opus-9', displayName: 'Opus 9' }]);
    const warm = await resolveClaudeModelCatalog({ timeoutMs: 1_000 });
    expect(warm.some((m) => m.id === 'claude-opus-9')).toBe(true);

    // A transient credential read failure degrades this call to the curated catalog...
    readClaudeCodeNativeCredentialMock.mockRejectedValue(new Error('EIO'));
    const degraded = await resolveClaudeModelCatalog({ timeoutMs: 1_000 });
    expect(degraded.some((m) => m.id === 'claude-opus-9')).toBe(false);

    // ...but must not have evicted or shadowed the still-valid entry: recovery is immediate and
    // does not require a refetch.
    readClaudeCodeNativeCredentialMock.mockResolvedValue({
      payload: { claudeAiOauth: { accessToken: 'sk-ant-oat01-account', scopes: [] } },
      updatedAtMs: 0,
      source: 'file',
    });
    const recovered = await resolveClaudeModelCatalog({ timeoutMs: 1_000 });
    expect(recovered.some((m) => m.id === 'claude-opus-9')).toBe(true);
    expect(fetchAnthropicModelsMock).toHaveBeenCalledTimes(1);
  });

  it('carries the extended-context model id through to the picker rows', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
    fetchAnthropicModelsMock.mockResolvedValue(null);

    const models = await resolveClaudeModelCatalog({ timeoutMs: 1_000 });
    const sonnet = models.find((m) => m.id === 'claude-sonnet-4-6') ?? null;

    expect(typeof sonnet?.extendedContextModelId).toBe('string');
  });

  it('falls back to the curated catalog when the fetch fails', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
    fetchAnthropicModelsMock.mockResolvedValue(null);

    const models = await resolveClaudeModelCatalog({ timeoutMs: 1_000 });

    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.id === 'claude-fable-5')).toBe(true);
    expect(models.some((m) => m.id === 'claude-opus-9')).toBe(false);
  });

  it('retains the last successful dynamic snapshot when a later refresh fails', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
    let currentTimeMs = 10;
    fetchAnthropicModelsMock
      .mockResolvedValueOnce([{ id: 'claude-opus-9', displayName: 'Opus 9' }])
      .mockResolvedValueOnce(null);

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
    expect(stale).toEqual(first);
    expect(staleDuringFailureCooldown).toEqual(first);
    expect(stale.models.map((model) => model.id)).toEqual(['claude-opus-9']);
    expect(fetchAnthropicModelsMock).toHaveBeenCalledTimes(2);
  });

  it('does not let another account refresh discard an expired dynamic snapshot before its own refresh', async () => {
    let currentTimeMs = 10;
    fetchAnthropicModelsMock
      .mockResolvedValueOnce([{ id: 'claude-account-a', displayName: 'Account A' }])
      .mockResolvedValueOnce([{ id: 'claude-account-b', displayName: 'Account B' }])
      .mockResolvedValueOnce(null);

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

    expect(staleAccountA).toEqual(accountA);
    expect(staleAccountA.models.map((model) => model.id)).toEqual(['claude-account-a']);
    expect(fetchAnthropicModelsMock).toHaveBeenCalledTimes(3);
  });
});

describe('resolveClaudeEffortLevelsFromModelDescriptor', () => {
  it('reads the reported tiers off a discovered model descriptor', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
    fetchAnthropicModelsMock.mockResolvedValue([
      { id: 'claude-opus-9', displayName: 'Opus 9', capabilities: fullEffort() },
    ]);

    const models = await resolveClaudeModelCatalog({ timeoutMs: 1_000 });
    const discovered = models.find((m) => m.id === 'claude-opus-9') ?? null;

    expect(resolveClaudeEffortLevelsFromModelDescriptor(discovered)).toEqual(['low', 'high', 'xhigh']);
  });

  it('returns no tiers for a model without an effort control', () => {
    expect(resolveClaudeEffortLevelsFromModelDescriptor(null)).toEqual([]);
    expect(resolveClaudeEffortLevelsFromModelDescriptor({ id: 'x', name: 'X' })).toEqual([]);
  });
});

describe('effort tiers carried on the mode', () => {
  it('clamps a carried effort to the tiers the resolved catalog reports', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
    fetchAnthropicModelsMock.mockResolvedValue([
      { id: 'claude-opus-9', displayName: 'Opus 9', capabilities: fullEffort() },
    ]);

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
