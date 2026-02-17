import type { ConnectedServiceQuotaFetcher } from './types';

import { createAnthropicQuotaFetcher } from './fetchers/anthropicQuotaFetcher';
import { createGeminiQuotaFetcher } from './fetchers/geminiQuotaFetcher';
import { createOpenAiCodexQuotaFetcher } from './fetchers/openAiCodexQuotaFetcher';

function parsePositiveIntEnv(raw: string | undefined, fallback: number, bounds: Readonly<{ min: number; max: number }>): number {
  const value = (raw ?? '').trim();
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, Math.trunc(parsed)));
}

function parseNonEmptyStringEnv(raw: string | undefined): string | undefined {
  const trimmed = (raw ?? '').trim();
  return trimmed ? trimmed : undefined;
}

export function createConnectedServiceQuotaFetchers(env: NodeJS.ProcessEnv): Array<ConnectedServiceQuotaFetcher> {
  const staleAfterMs = parsePositiveIntEnv(env.HAPPIER_CONNECTED_SERVICES_QUOTAS_STALE_AFTER_MS, 5 * 60_000, {
    min: 5_000,
    max: 24 * 60 * 60_000,
  });

  return [
    createOpenAiCodexQuotaFetcher({
      usageUrl: parseNonEmptyStringEnv(env.HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_USAGE_URL),
      staleAfterMs,
      userAgent: parseNonEmptyStringEnv(env.HAPPIER_CONNECTED_SERVICES_QUOTAS_USER_AGENT),
    }),
    createAnthropicQuotaFetcher({
      usageUrl: parseNonEmptyStringEnv(env.HAPPIER_CONNECTED_SERVICES_ANTHROPIC_USAGE_URL),
      staleAfterMs,
      userAgent: parseNonEmptyStringEnv(env.HAPPIER_CONNECTED_SERVICES_QUOTAS_USER_AGENT),
    }),
    createGeminiQuotaFetcher(),
  ];
}

