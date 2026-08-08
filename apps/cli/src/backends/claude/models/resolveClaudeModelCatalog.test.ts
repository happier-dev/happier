import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';

import type { AnthropicModelEntry } from '@/backends/claude/preflight/anthropicModelsFetch';

const { fetchAnthropicModelsMock, readClaudeCodeNativeCredentialMock } = vi.hoisted(() => ({
  fetchAnthropicModelsMock: vi.fn<(...args: unknown[]) => Promise<AnthropicModelEntry[] | null>>(),
  readClaudeCodeNativeCredentialMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock('@/backends/claude/preflight/anthropicModelsFetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/backends/claude/preflight/anthropicModelsFetch')>();
  return { ...actual, fetchAnthropicModels: fetchAnthropicModelsMock };
});

vi.mock('@/backends/claude/connectedServices/nativeAuth/claudeCodeCredentialFile', () => ({
  readClaudeCodeNativeCredential: readClaudeCodeNativeCredentialMock,
}));

import { buildClaudeEffortCliArgs } from '@/backends/claude/utils/claudeEffort';
import {
  resolveClaudeEffortLevelsFromModelDescriptor,
  resolveClaudeModelCatalog,
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

  it('serves a cached catalog instead of refetching, and partitions by connected account', async () => {
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
    await resolveClaudeModelCatalog({
      timeoutMs: 1_000,
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': { source: 'connected', selection: 'profile', profileId: 'profile-a' },
        },
      },
    });
    expect(fetchAnthropicModelsMock).toHaveBeenCalledTimes(2);
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
