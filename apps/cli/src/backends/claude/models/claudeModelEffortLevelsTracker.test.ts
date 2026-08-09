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

vi.mock('@/backends/claude/connectedServices/nativeAuth/claudeCodeCredentialFile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/backends/claude/connectedServices/nativeAuth/claudeCodeCredentialFile')>();
  return { ...actual, readClaudeCodeNativeCredential: readClaudeCodeNativeCredentialMock };
});

import { createClaudeModelEffortLevelsTracker } from './claudeModelEffortLevelsTracker';
import { resetClaudeModelCatalogCacheForTests } from './resolveClaudeModelCatalog';

const envKeys = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
] as const;
let envScope = createEnvKeyScope(envKeys);

const effortCapabilities = (tiers: readonly string[]): AnthropicModelEntry['capabilities'] => ({
  effort: {
    supported: true,
    ...Object.fromEntries(tiers.map((tier) => [tier, { supported: true }])),
  },
});

const createTracker = (): ReturnType<typeof createClaudeModelEffortLevelsTracker> =>
  createClaudeModelEffortLevelsTracker({ resolveTimeoutMs: () => 1_000 });

beforeEach(() => {
  fetchAnthropicModelsMock.mockReset();
  readClaudeCodeNativeCredentialMock.mockReset();
  readClaudeCodeNativeCredentialMock.mockResolvedValue(null);
  resetClaudeModelCatalogCacheForTests();
  envScope.restore();
  envScope = createEnvKeyScope(envKeys);
  process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
});

afterEach(() => {
  // Leave no cached catalog behind: the cache is module state, so a later suite sharing this
  // module context would otherwise read entries this one populated.
  resetClaudeModelCatalogCacheForTests();
  envScope.restore();
  envScope = createEnvKeyScope(envKeys);
});

describe('createClaudeModelEffortLevelsTracker', () => {
  it('reports the tiers a discovered model declares', async () => {
    fetchAnthropicModelsMock.mockResolvedValue([
      { id: 'claude-opus-9', displayName: 'Opus 9', capabilities: effortCapabilities(['low', 'high', 'xhigh']) },
    ]);
    const tracker = createTracker();

    await tracker.refresh('claude-opus-9');

    expect(tracker.getModelId()).toBe('claude-opus-9');
    expect(tracker.getLevels()).toEqual(['low', 'high', 'xhigh']);
  });

  it('forgets the previous model on reset to the CLI default', async () => {
    fetchAnthropicModelsMock.mockResolvedValue([
      { id: 'claude-opus-9', displayName: 'Opus 9', capabilities: effortCapabilities(['low', 'xhigh']) },
    ]);
    const tracker = createTracker();
    await tracker.refresh('claude-opus-9');
    expect(tracker.getLevels()).not.toEqual([]);

    await tracker.refresh(undefined);

    // Leaving the tiers live would clamp whatever is selected next against this model.
    expect(tracker.getModelId()).toBeNull();
    expect(tracker.getLevels()).toEqual([]);
  });

  it('does not consult the catalog for a curated model', async () => {
    const tracker = createTracker();

    await tracker.refresh('claude-haiku-4-5');

    // Curated models resolve effort from the static table, so a network round trip is wasted work.
    expect(fetchAnthropicModelsMock).not.toHaveBeenCalled();
    expect(tracker.getLevels()).toEqual([]);
    expect(tracker.getModelId()).toBe('claude-haiku-4-5');
  });

  it('reports no tiers when the catalog lookup fails', async () => {
    fetchAnthropicModelsMock.mockRejectedValue(new Error('network'));
    const tracker = createTracker();

    await tracker.refresh('claude-opus-9');

    // Fails closed: no evidence means no `--effort`, never a guessed level.
    expect(tracker.getLevels()).toEqual([]);
  });

  it('does not let a late lookup publish a superseded model tiers', async () => {
    // Concurrent resolutions for one account share a single fetch, so both refreshes await the same
    // promise. The guard has to be the model id, not which lookup happened to start first.
    let releaseCatalog: ((entries: AnthropicModelEntry[]) => void) | null = null;
    fetchAnthropicModelsMock.mockImplementation(() => new Promise<AnthropicModelEntry[]>((resolve) => {
      releaseCatalog = resolve;
    }));

    const tracker = createTracker();
    const first = tracker.refresh('claude-opus-9');
    const second = tracker.refresh('claude-sonnet-9');
    expect(tracker.getModelId()).toBe('claude-sonnet-9');

    // Credential resolution is async, so the fetch starts a tick after refresh is called.
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    const release = releaseCatalog as ((entries: AnthropicModelEntry[]) => void) | null;
    if (!release) {
      throw new Error('expected the catalog lookup to be in flight');
    }
    release([
      { id: 'claude-opus-9', displayName: 'Opus 9', capabilities: effortCapabilities(['low', 'xhigh']) },
      { id: 'claude-sonnet-9', displayName: 'Sonnet 9', capabilities: effortCapabilities(['low']) },
    ]);
    await Promise.all([first, second]);

    // The superseded lookup must not publish Opus 9 tiers under Sonnet 9.
    expect(tracker.getModelId()).toBe('claude-sonnet-9');
    expect(tracker.getLevels()).toEqual(['low']);
  });

  it('does not block the caller past its budget on a cold catalog', async () => {
    // SessionClient awaits the user-message callback as part of the pending-queue handoff, so an
    // unbounded wait here would hold the queue behind this fetch.
    fetchAnthropicModelsMock.mockImplementation(() => new Promise<AnthropicModelEntry[]>(() => {}));
    const tracker = createTracker();

    const startedAt = Date.now();
    await tracker.refreshWithin('claude-opus-9', 30);

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    // Past the budget the turn proceeds with no evidence, exactly as it would have before.
    expect(tracker.getLevels()).toEqual([]);
  });

  it('returns immediately once the catalog is cached', async () => {
    fetchAnthropicModelsMock.mockResolvedValue([
      { id: 'claude-opus-9', displayName: 'Opus 9', capabilities: effortCapabilities(['low', 'xhigh']) },
    ]);
    const tracker = createTracker();
    await tracker.refresh('claude-opus-9');

    // A different model on a warm catalog must still resolve within the budget, not fall back to [].
    const second = createTracker();
    await second.refreshWithin('claude-opus-9', 30);
    expect(second.getLevels()).toEqual(['low', 'xhigh']);
  });

  it('shares one catalog fetch across concurrent refreshes for the same account', async () => {
    fetchAnthropicModelsMock.mockResolvedValue([
      { id: 'claude-opus-9', displayName: 'Opus 9', capabilities: effortCapabilities(['low']) },
    ]);
    const trackerA = createTracker();
    const trackerB = createTracker();

    await Promise.all([trackerA.refresh('claude-opus-9'), trackerB.refresh('claude-opus-9')]);

    // The preflight probe and the session publisher both resolve at session start; one fetch is enough.
    expect(fetchAnthropicModelsMock).toHaveBeenCalledTimes(1);
  });
});
