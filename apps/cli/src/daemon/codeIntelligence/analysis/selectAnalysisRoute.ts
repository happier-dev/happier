import type {
  CodeIntelligenceAnalysisProviderV1,
  CodeIntelligenceBillingClassV1,
  CodeIntelligenceRemoteAnalysisSettingsV1,
} from '@happier-dev/protocol';

export type AnalysisRouteCandidate = Readonly<{
  provider: CodeIntelligenceAnalysisProviderV1;
  /** Worst-case cost of one request at the declared prices; 0 for free and subscription. */
  maxCostUsd: number;
}>;

export type AnalysisRoute =
  | Readonly<{ ok: true; candidates: AnalysisRouteCandidate[] }>
  | Readonly<{
    ok: false;
    reason:
      | 'remote_analysis_disabled'
      | 'repository_not_allowed'
      | 'no_eligible_provider'
      | 'rate_limited';
    retryAfterMs: number | null;
  }>;

const BILLING_RANK: Record<CodeIntelligenceBillingClassV1, number> = { free: 0, subscription: 1, paid: 2 };

function maxRequestCostUsd(provider: CodeIntelligenceAnalysisProviderV1, inputTokens: number, maxOutputTokens: number): number | null {
  if (provider.billing !== 'paid') return 0;
  if (provider.inputPricePerMillionUsd === null || provider.outputPricePerMillionUsd === null) return null;
  return (inputTokens * provider.inputPricePerMillionUsd + maxOutputTokens * provider.outputPricePerMillionUsd) / 1_000_000;
}

/**
 * The single admission decision for remote analysis. A provider is a candidate only when the
 * routing policy admits its declared billing class; a paid provider additionally needs explicit
 * paid consent, declared prices, and remaining monthly budget for the worst case of this request.
 * Callers may fall back between returned candidates, so fallback can never reach a model the
 * policy did not already admit.
 */
export function selectAnalysisRoute(input: Readonly<{
  settings: CodeIntelligenceRemoteAnalysisSettingsV1;
  repositoryId: string;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  monthlySpendUsd: number;
  unavailableUntilMsByProviderId: ReadonlyMap<string, number>;
  nowMs: number;
}>): AnalysisRoute {
  const { settings } = input;
  if (!settings.enabled) return { ok: false, reason: 'remote_analysis_disabled', retryAfterMs: null };
  if (!settings.allowedRepositoryIds.includes(input.repositoryId)) {
    return { ok: false, reason: 'repository_not_allowed', retryAfterMs: null };
  }

  const remainingBudgetUsd = settings.allowPaid ? Math.max(0, settings.monthlyBudgetUsd - input.monthlySpendUsd) : 0;
  const admitted: AnalysisRouteCandidate[] = [];
  for (const provider of settings.providers) {
    if (!provider.enabled) continue;
    const billingAdmitted = settings.routingPolicy === 'free_only'
      ? provider.billing === 'free'
      : settings.routingPolicy === 'free_and_subscription'
        ? provider.billing !== 'paid'
        : true;
    if (!billingAdmitted) continue;
    const maxCostUsd = maxRequestCostUsd(provider, input.estimatedInputTokens, input.maxOutputTokens);
    if (maxCostUsd === null) continue;
    if (provider.billing === 'paid' && (!settings.allowPaid || maxCostUsd > remainingBudgetUsd)) continue;
    admitted.push({ provider, maxCostUsd });
  }

  const ordered = settings.routingPolicy === 'lowest_cost'
    ? [...admitted].sort((a, b) =>
      BILLING_RANK[a.provider.billing] - BILLING_RANK[b.provider.billing] || a.maxCostUsd - b.maxCostUsd)
    : settings.routingPolicy === 'manual'
      ? admitted.slice(0, 1)
      : admitted;

  const available = ordered.filter((candidate) => (input.unavailableUntilMsByProviderId.get(candidate.provider.id) ?? 0) <= input.nowMs);
  if (available.length > 0) return { ok: true, candidates: available };
  if (ordered.length === 0) return { ok: false, reason: 'no_eligible_provider', retryAfterMs: null };
  const nextAvailableAtMs = Math.min(...ordered.map((candidate) => input.unavailableUntilMsByProviderId.get(candidate.provider.id) ?? input.nowMs));
  return { ok: false, reason: 'rate_limited', retryAfterMs: Math.max(0, nextAvailableAtMs - input.nowMs) };
}
