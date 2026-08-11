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
  it('merges discovered models into the curated catalog', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
    fetchAnthropicModelsMock.mockResolvedValue([
      { id: 'claude-opus-9', displayName: 'Opus 9', capabilities: fullEffort() },
    ]);

    const models = await resolveClaudeModelCatalog({ timeoutMs: 1_000 });

    expect(models.some((m) => m.id === 'claude-opus-9')).toBe(true);
    expect(models.some((m) => m.id === 'claude-fable-5')).toBe(true);
  });

  it('keeps the first discovered row when an alias and dated snapshot normalize to the same id', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
    fetchAnthropicModelsMock.mockResolvedValue([
      { id: 'claude-opus-9', displayName: 'Opus 9 Alias' },
      { id: 'claude-opus-9-20260812', displayName: 'Opus 9 Snapshot' },
    ]);

    const models = await resolveClaudeModelCatalog({ timeoutMs: 1_000 });
    const matching = models.filter((model) => model.id === 'claude-opus-9' || model.id === 'claude-opus-9-20260812');

    expect(matching).toEqual([
      expect.objectContaining({ id: 'claude-opus-9', name: 'Opus 9 Alias' }),
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
