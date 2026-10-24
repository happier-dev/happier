import type {
  CodeIntelligenceAnalysisProviderV1,
  CodeIntelligenceCommitAnalysisV1,
  CodeIntelligenceCommitV1,
  CodeIntelligenceSettingsV1,
} from '@happier-dev/protocol';

import type { CodeIntelligenceStore } from '../store/codeIntelligenceStore';
import { buildCommitAnalysisPrompt, COMMIT_ANALYSIS_SYSTEM_PROMPT } from './buildCommitAnalysisPrompt';
import { requestChatCompletion, resolveChatCompletionBaseUrl } from './chatCompletionClient';
import { parseCommitAnalysisOutput } from './parseCommitAnalysisOutput';
import { selectAnalysisRoute } from './selectAnalysisRoute';

const MAX_OUTPUT_TOKENS = 2_000;
const REQUEST_TIMEOUT_MS = 60_000;
/** Exponential backoff when a provider is unavailable without a Retry-After instruction. */
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

export type AnalyzeCommitDeps = Readonly<{
  fetchImpl: typeof fetch;
  nowMs: () => number;
  resolveApiKey: (provider: CodeIntelligenceAnalysisProviderV1) => Promise<string | null> | string | null;
}>;

function backoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1));
}

function monthKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 7);
}

/**
 * Runs one remote review of a stored commit and persists the outcome. Every outcome is recorded:
 * a commit is never dropped because analysis was disabled, rate limited or failed, and a rate
 * limited job stays `queued` with the provider's retry instruction so the worker can resume it.
 */
type AnalysisEventKind = 'analysis_started' | 'analysis_completed' | 'analysis_failed' | 'analysis_skipped';

/** Records a commit's analysis state together with the activity event that announces it. */
export function persistCommitAnalysis(input: Readonly<{
  store: CodeIntelligenceStore;
  commit: CodeIntelligenceCommitV1;
  analysis: CodeIntelligenceCommitAnalysisV1;
  kind: AnalysisEventKind;
}>): CodeIntelligenceCommitAnalysisV1 {
  const { store, commit, analysis } = input;
  store.updateCommitAnalysis({ repositoryId: commit.repositoryId, sha: commit.sha, analysis });
  store.appendEvent({
    kind: input.kind,
    atMs: analysis.updatedAtMs,
    repositoryId: commit.repositoryId,
    worktreePath: commit.observedInWorktreePath,
    sessionId: null,
    commitSha: commit.sha,
    data: {
      status: analysis.status,
      reason: analysis.reason,
      providerId: analysis.providerId,
      modelId: analysis.modelId,
      riskLevel: analysis.riskLevel,
      findings: analysis.findings.length,
    },
  });
  return analysis;
}

export async function analyzeCommit(input: Readonly<{
  store: CodeIntelligenceStore;
  settings: CodeIntelligenceSettingsV1;
  commit: CodeIntelligenceCommitV1;
  /** Provider id -> epoch ms before which it must not be called (rate limit / outage memory). */
  unavailableUntilMsByProviderId: Map<string, number>;
  deps: AnalyzeCommitDeps;
}>): Promise<CodeIntelligenceCommitAnalysisV1> {
  const { store, commit, deps } = input;
  const attempts = commit.analysis.attempts + 1;
  const base: CodeIntelligenceCommitAnalysisV1 = {
    ...commit.analysis,
    attempts,
    reason: null,
    retryAfterMs: null,
    updatedAtMs: deps.nowMs(),
  };
  const persist = (analysis: CodeIntelligenceCommitAnalysisV1, kind: AnalysisEventKind) =>
    persistCommitAnalysis({ store, commit, analysis, kind });

  // Cheap admission first: nothing is read for a remote prompt unless a provider could take it.
  const preflight = selectAnalysisRoute({
    settings: input.settings.remoteAnalysis,
    repositoryId: commit.repositoryId,
    estimatedInputTokens: 0,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    monthlySpendUsd: store.getMonthlySpendUsd({ monthKey: monthKey(deps.nowMs()) }),
    unavailableUntilMsByProviderId: input.unavailableUntilMsByProviderId,
    nowMs: deps.nowMs(),
  });
  if (!preflight.ok && preflight.reason !== 'rate_limited') {
    return persist({ ...base, status: 'skipped', reason: preflight.reason }, 'analysis_skipped');
  }

  const prompt = await buildCommitAnalysisPrompt({
    commit,
    worktreePath: commit.observedInWorktreePath,
    baseSha: commit.parentCount > 0 ? `${commit.sha}^1` : null,
    excludedPathPrefixes: input.settings.excludedPathPrefixes,
  });
  // UTF-8 bytes bound the token count from above for every tokenizer in use, so paid admission never
  // under-estimates a request against the remaining budget.
  const estimatedInputTokens = Buffer.byteLength(COMMIT_ANALYSIS_SYSTEM_PROMPT, 'utf8') + Buffer.byteLength(prompt.user, 'utf8');
  const route = selectAnalysisRoute({
    settings: input.settings.remoteAnalysis,
    repositoryId: commit.repositoryId,
    estimatedInputTokens,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    monthlySpendUsd: store.getMonthlySpendUsd({ monthKey: monthKey(deps.nowMs()) }),
    unavailableUntilMsByProviderId: input.unavailableUntilMsByProviderId,
    nowMs: deps.nowMs(),
  });
  if (!route.ok) {
    return route.reason === 'rate_limited'
      ? persist({ ...base, status: 'queued', reason: 'rate_limited', retryAfterMs: route.retryAfterMs }, 'analysis_failed')
      : persist({ ...base, status: 'skipped', reason: route.reason }, 'analysis_skipped');
  }

  persist({ ...base, status: 'analyzing' }, 'analysis_started');
  let lastFailure = 'provider_unavailable';
  let earliestRetryMs: number | null = null;
  // Every completed exchange may have been billed, usable or not; without reported usage the full
  // output allowance is charged so the monthly budget errs towards stopping early.
  const charge = (
    provider: CodeIntelligenceAnalysisProviderV1,
    usage: Readonly<{ inputTokens: number | null; outputTokens: number | null }>,
  ): number => {
    const inputTokens = usage.inputTokens ?? estimatedInputTokens;
    const outputTokens = usage.outputTokens ?? (provider.billing === 'paid' ? MAX_OUTPUT_TOKENS : 0);
    const costUsd = provider.billing === 'paid'
      ? (inputTokens * (provider.inputPricePerMillionUsd ?? 0) + outputTokens * (provider.outputPricePerMillionUsd ?? 0)) / 1_000_000
      : 0;
    store.recordUsage({ monthKey: monthKey(deps.nowMs()), providerId: provider.id, inputTokens, outputTokens, costUsd });
    return costUsd;
  };

  for (const { provider } of route.candidates) {
    const baseUrl = resolveChatCompletionBaseUrl(provider.kind, provider.baseUrl);
    if (!baseUrl) {
      lastFailure = 'provider_misconfigured';
      continue;
    }
    let apiKey: string | null;
    try {
      apiKey = await deps.resolveApiKey(provider);
    } catch {
      lastFailure = 'provider_key_unavailable';
      continue;
    }
    const result = await requestChatCompletion({
      baseUrl,
      apiKey,
      modelId: provider.modelId,
      system: COMMIT_ANALYSIS_SYSTEM_PROMPT,
      user: prompt.user,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      timeoutMs: REQUEST_TIMEOUT_MS,
      fetchImpl: deps.fetchImpl,
      nowMs: deps.nowMs,
    });
    if (!result.ok) {
      if (result.kind === 'rate_limited' || result.kind === 'unavailable') {
        const waitMs = (result.kind === 'rate_limited' ? result.retryAfterMs : null) ?? backoffMs(attempts);
        input.unavailableUntilMsByProviderId.set(provider.id, deps.nowMs() + waitMs);
        earliestRetryMs = earliestRetryMs === null ? waitMs : Math.min(earliestRetryMs, waitMs);
        lastFailure = result.kind === 'rate_limited' ? 'rate_limited' : 'provider_unavailable';
      } else {
        if (result.billed) charge(provider, result.billed);
        lastFailure = result.kind === 'rejected' ? 'provider_rejected_request' : 'invalid_model_output';
      }
      continue;
    }
    const costUsd = charge(provider, result);
    const parsed = parseCommitAnalysisOutput({ content: result.content, commitSha: commit.sha });
    if (!parsed) {
      lastFailure = 'invalid_model_output';
      continue;
    }
    return persist({
      ...base,
      status: 'completed',
      reason: prompt.partial ? 'partial_diff' : null,
      summary: parsed.summary,
      riskLevel: parsed.riskLevel,
      findings: parsed.findings,
      providerId: provider.id,
      modelId: provider.modelId,
      billing: provider.billing,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      estimatedCostUsd: costUsd,
      updatedAtMs: deps.nowMs(),
    }, 'analysis_completed');
  }

  // Transient failures keep the job queued for the worker to resume; anything else is final until
  // the user asks for reanalysis.
  return earliestRetryMs !== null
    ? persist({ ...base, status: 'queued', reason: lastFailure, retryAfterMs: earliestRetryMs, updatedAtMs: deps.nowMs() }, 'analysis_failed')
    : persist({ ...base, status: 'failed', reason: lastFailure, updatedAtMs: deps.nowMs() }, 'analysis_failed');
}
