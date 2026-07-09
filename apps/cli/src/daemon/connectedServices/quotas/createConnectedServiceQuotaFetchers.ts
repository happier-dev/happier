import type { ConnectedServiceQuotaFetcher, ConnectedServiceQuotaFetcherDescriptor } from './types';

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

export function createConnectedServiceQuotaFetchers(
  env: NodeJS.ProcessEnv,
  descriptors: readonly ConnectedServiceQuotaFetcherDescriptor[],
): Array<ConnectedServiceQuotaFetcher> {
  const staleAfterMs = parsePositiveIntEnv(env.HAPPIER_CONNECTED_SERVICES_QUOTAS_STALE_AFTER_MS, 30 * 60_000, {
    min: 5_000,
    max: 24 * 60 * 60_000,
  });
  const userAgent = parseNonEmptyStringEnv(env.HAPPIER_CONNECTED_SERVICES_QUOTAS_USER_AGENT);

  return descriptors.map((descriptor) => {
    const fetcher = descriptor.createFetcher({
      env,
      staleAfterMs,
      userAgent,
    });
    return descriptor.terminalAuthFailureProviderCodes
      ? { ...fetcher, terminalAuthFailureProviderCodes: descriptor.terminalAuthFailureProviderCodes }
      : fetcher;
  });
}
