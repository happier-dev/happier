import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { normalizeCodeIntelligenceSettings, type CodeIntelligenceCommitV1, type CodeIntelligenceSettingsV1 } from '@happier-dev/protocol';

import { observeCheckout } from '../commits/observeCheckout';
import { openCodeIntelligenceStore, type CodeIntelligenceStore } from '../store/codeIntelligenceStore';
import { analyzeCommit } from './analyzeCommit';

const execFile = promisify(execFileCallback);
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const SECRET = 'gsk_abcdefghijklmnopqrstuvwxyz0123456789';
const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFile('git', ['-c', 'user.email=dev@example.com', '-c', 'user.name=Dev', ...args], { cwd });
}

async function observedCommit(): Promise<Readonly<{ store: CodeIntelligenceStore; commit: CodeIntelligenceCommitV1 }>> {
  const root = await mkdtemp(join(tmpdir(), 'ci-analyze-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'shop');
  await execFile('git', ['init', '-b', 'main', repo]);
  await writeFile(join(repo, 'cart.ts'), 'export function total(items: number[]): number {\n  return items.length;\n}\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'initial']);
  const store = openCodeIntelligenceStore({ dbPath: join(root, 'ci.sqlite') });
  cleanups.push(() => store.close());
  const observe = () => observeCheckout({ store, cwd: repo, registrationSource: 'manual', excludedPathPrefixes: [], resolvePlausibleSessionIds: () => [], nowMs: () => NOW });
  await observe();
  await writeFile(join(repo, 'cart.ts'), `const groqKey = "${SECRET}";\nexport function total(items: number[]): number {\n  return items.length - 1;\n}\n`);
  await writeFile(join(repo, '.env'), 'DATABASE_PASSWORD=hunter2hunter2\n');
  await writeFile(join(repo, 'deploy.ts'), 'export const deployRef = "glpat-AbCdEfGhIjKlMnOpQrSt";\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'fix: totals']);
  const [commit] = (await observe())!.newCommits;
  return { store, commit: commit! };
}

function settingsWith(repositoryId: string, overrides: Record<string, unknown> = {}): CodeIntelligenceSettingsV1 {
  return normalizeCodeIntelligenceSettings({
    enabled: true,
    remoteAnalysis: {
      enabled: true,
      allowedRepositoryIds: [repositoryId],
      providers: [
        { id: 'groq', kind: 'groq', modelId: 'fast-model', billing: 'free' },
        { id: 'premium', kind: 'openai_compatible', baseUrl: 'https://paid.example/v1', modelId: 'big-model', billing: 'paid', inputPricePerMillionUsd: 3, outputPricePerMillionUsd: 15 },
        { id: 'openrouter-free', kind: 'openrouter', modelId: 'vendor/model:free', billing: 'free' },
      ],
    },
    ...overrides,
  });
}

type Call = Readonly<{ url: string; body: string }>;

function scriptedFetch(responses: Record<string, () => Response>, calls: Call[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, body: String(init?.body ?? '') });
    const host = new URL(href).host;
    const respond = responses[host];
    if (!respond) throw new Error(`unexpected request to ${host}`);
    return respond();
  }) as typeof fetch;
}

const VALID_REVIEW = JSON.stringify({
  summary: 'total now under-counts items',
  riskLevel: 'high',
  findings: [{
    filePath: 'cart.ts',
    line: 3,
    symbol: 'total',
    category: 'logic',
    severity: 'high',
    confidence: 0.8,
    explanation: 'Subtracting one makes totals wrong for every cart.',
    evidence: 'return items.length - 1;',
    suggestedCorrection: 'return items.length;',
  }],
});

function completion(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 120, completion_tokens: 40 } }), { status: 200 });
}

describe('analyzeCommit', () => {
  it('records a skipped analysis without contacting any provider when remote analysis is not permitted', async () => {
    const { store, commit } = await observedCommit();
    const calls: Call[] = [];

    const analysis = await analyzeCommit({
      store,
      settings: settingsWith('some-other-repository'),
      commit,
      unavailableUntilMsByProviderId: new Map(),
      deps: { fetchImpl: scriptedFetch({}, calls), nowMs: () => NOW, resolveApiKey: () => 'key' },
    });

    expect(analysis).toMatchObject({ status: 'skipped', reason: 'repository_not_allowed' });
    expect(calls).toEqual([]);
    expect(store.getCommit(commit)?.analysis.status).toBe('skipped');
  });

  it('honors a Groq rate limit, falls back only to another free model, and never selects the paid one', async () => {
    const { store, commit } = await observedCommit();
    const calls: Call[] = [];
    const unavailable = new Map<string, number>();

    const analysis = await analyzeCommit({
      store,
      settings: settingsWith(commit.repositoryId),
      commit,
      unavailableUntilMsByProviderId: unavailable,
      deps: {
        fetchImpl: scriptedFetch({
          'api.groq.com': () => new Response('{}', { status: 429, headers: { 'retry-after': '7' } }),
          'openrouter.ai': () => completion(VALID_REVIEW),
        }, calls),
        nowMs: () => NOW,
        resolveApiKey: () => 'key',
      },
    });

    expect(calls.map((call) => new URL(call.url).host)).toEqual(['api.groq.com', 'openrouter.ai']);
    expect(unavailable.get('groq')).toBe(NOW + 7_000);
    expect(analysis).toMatchObject({ status: 'completed', providerId: 'openrouter-free', billing: 'free', riskLevel: 'high', estimatedCostUsd: 0 });
    expect(analysis.findings[0]).toMatchObject({ symbol: 'total', verification: 'suspected' });
    expect(store.getCommit(commit)?.analysis.findings).toHaveLength(1);

    // The prompt is scoped to the commit, carries graph facts, and never ships secrets or excluded files.
    const sentPrompt = calls[1]!.body;
    expect(sentPrompt).toContain('modified function total');
    expect(sentPrompt).not.toContain(SECRET);
    expect(sentPrompt).not.toContain('hunter2');
    expect(sentPrompt).not.toContain('glpat-AbCdEfGhIjKlMnOpQrSt');
  });

  it('keeps the job queued with the retry instruction when every admitted provider is rate limited', async () => {
    const { store, commit } = await observedCommit();
    const calls: Call[] = [];
    const settings = settingsWith(commit.repositoryId);
    settings.remoteAnalysis.providers = settings.remoteAnalysis.providers.filter((provider) => provider.id !== 'openrouter-free');

    const analysis = await analyzeCommit({
      store,
      settings,
      commit,
      unavailableUntilMsByProviderId: new Map(),
      deps: {
        fetchImpl: scriptedFetch({ 'api.groq.com': () => new Response('{}', { status: 429, headers: { 'retry-after': '7' } }) }, calls),
        nowMs: () => NOW,
        resolveApiKey: () => 'key',
      },
    });

    expect(calls).toHaveLength(1);
    expect(analysis).toMatchObject({ status: 'queued', reason: 'rate_limited', retryAfterMs: 7_000, attempts: 1 });
  });

  it('uses a paid model only with explicit consent and enough remaining monthly budget', async () => {
    const { store, commit } = await observedCommit();
    const calls: Call[] = [];
    const settings = settingsWith(commit.repositoryId, {});
    settings.remoteAnalysis.providers = settings.remoteAnalysis.providers.filter((provider) => provider.id === 'premium');
    settings.remoteAnalysis.routingPolicy = 'lowest_cost';
    const deps = { fetchImpl: scriptedFetch({ 'paid.example': () => completion(VALID_REVIEW) }, calls), nowMs: () => NOW, resolveApiKey: () => 'key' };

    expect(await analyzeCommit({ store, settings, commit, unavailableUntilMsByProviderId: new Map(), deps }))
      .toMatchObject({ status: 'skipped', reason: 'no_eligible_provider' });

    settings.remoteAnalysis.allowPaid = true;
    settings.remoteAnalysis.monthlyBudgetUsd = 1;
    const analysis = await analyzeCommit({ store, settings, commit: store.getCommit(commit)!, unavailableUntilMsByProviderId: new Map(), deps });
    expect(analysis).toMatchObject({ status: 'completed', billing: 'paid' });
    expect(analysis.estimatedCostUsd).toBeCloseTo((120 * 3 + 40 * 15) / 1_000_000);
    expect(calls).toHaveLength(1);
  });

  it('records a failure instead of throwing when the provider answers with a JSON null envelope or the key cannot be read', async () => {
    const { store, commit } = await observedCommit();
    const settings = settingsWith(commit.repositoryId);
    settings.remoteAnalysis.providers = settings.remoteAnalysis.providers.filter((provider) => provider.id === 'groq');

    const nullEnvelope = await analyzeCommit({
      store,
      settings,
      commit,
      unavailableUntilMsByProviderId: new Map(),
      deps: { fetchImpl: scriptedFetch({ 'api.groq.com': () => new Response('null', { status: 200 }) }, []), nowMs: () => NOW, resolveApiKey: () => 'key' },
    });
    expect(nullEnvelope).toMatchObject({ status: 'failed', reason: 'invalid_model_output' });
    expect(store.getCommit(commit)?.analysis).toMatchObject({ status: 'failed', reason: 'invalid_model_output' });

    const keyFailure = await analyzeCommit({
      store,
      settings,
      commit: store.getCommit(commit)!,
      unavailableUntilMsByProviderId: new Map(),
      deps: { fetchImpl: scriptedFetch({}, []), nowMs: () => NOW, resolveApiKey: async () => { throw new Error('keychain locked'); } },
    });
    expect(keyFailure).toMatchObject({ status: 'failed', reason: 'provider_key_unavailable' });
    expect(store.getCommit(commit)?.analysis.status).toBe('failed');
  });

  it('charges every paid completion against the budget, even unusable or usage-less ones', async () => {
    const { store, commit } = await observedCommit();
    const settings = settingsWith(commit.repositoryId);
    settings.remoteAnalysis.providers = settings.remoteAnalysis.providers.filter((provider) => provider.id === 'premium');
    settings.remoteAnalysis.routingPolicy = 'lowest_cost';
    settings.remoteAnalysis.allowPaid = true;
    settings.remoteAnalysis.monthlyBudgetUsd = 1;

    await analyzeCommit({
      store,
      settings,
      commit,
      unavailableUntilMsByProviderId: new Map(),
      deps: { fetchImpl: scriptedFetch({ 'paid.example': () => completion('not json') }, []), nowMs: () => NOW, resolveApiKey: () => 'key' },
    });
    expect(store.getMonthlySpendUsd({ monthKey: '2026-10' })).toBeCloseTo((120 * 3 + 40 * 15) / 1_000_000);

    const noUsage = new Response(JSON.stringify({ choices: [{ message: { content: VALID_REVIEW } }] }), { status: 200 });
    const before = store.getMonthlySpendUsd({ monthKey: '2026-10' });
    await analyzeCommit({
      store,
      settings,
      commit: store.getCommit(commit)!,
      unavailableUntilMsByProviderId: new Map(),
      deps: { fetchImpl: scriptedFetch({ 'paid.example': () => noUsage }, []), nowMs: () => NOW, resolveApiKey: () => 'key' },
    });
    // Without reported usage the full output allowance is charged rather than nothing.
    expect(store.getMonthlySpendUsd({ monthKey: '2026-10' }) - before).toBeGreaterThanOrEqual((2_000 * 15) / 1_000_000);

    // A 200 whose body is not a JSON object was still answered, so it is charged too.
    for (const body of ['null', '<html>gateway</html>']) {
      const spentBefore = store.getMonthlySpendUsd({ monthKey: '2026-10' });
      await analyzeCommit({
        store,
        settings,
        commit: store.getCommit(commit)!,
        unavailableUntilMsByProviderId: new Map(),
        deps: { fetchImpl: scriptedFetch({ 'paid.example': () => new Response(body, { status: 200 }) }, []), nowMs: () => NOW, resolveApiKey: () => 'key' },
      });
      expect(store.getMonthlySpendUsd({ monthKey: '2026-10' }) - spentBefore).toBeGreaterThanOrEqual((2_000 * 15) / 1_000_000);
    }
  });

  it('fails visibly instead of persisting unvalidated model output', async () => {
    const { store, commit } = await observedCommit();
    const settings = settingsWith(commit.repositoryId);
    settings.remoteAnalysis.providers = settings.remoteAnalysis.providers.filter((provider) => provider.id === 'groq');

    const analysis = await analyzeCommit({
      store,
      settings,
      commit,
      unavailableUntilMsByProviderId: new Map(),
      deps: { fetchImpl: scriptedFetch({ 'api.groq.com': () => completion('looks fine to me!') }, []), nowMs: () => NOW, resolveApiKey: () => 'key' },
    });

    expect(analysis).toMatchObject({ status: 'failed', reason: 'invalid_model_output', findings: [] });
  });
});
