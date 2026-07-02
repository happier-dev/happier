import type { ConnectedServiceLimitCategoryV1 } from '@happier-dev/protocol';

export type ProviderLimitCategory = ConnectedServiceLimitCategoryV1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeStatusCode(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^[1-5]\d{2}$/u.test(trimmed)) return null;
  const status = Number(trimmed);
  return status >= 100 && status <= 599 ? status : null;
}

function isStatusCodeKey(key: string): boolean {
  return ['code', 'errorcode', 'httpstatus', 'status', 'statuscode'].includes(
    key.replace(/[_-]/gu, '').toLowerCase(),
  );
}

function readStatusCode(value: unknown): number | null {
  let fallback: number | null = null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const status = readStatusCode(item);
      if (status === 429) return status;
      fallback ??= status;
    }
    return fallback;
  }
  if (!isRecord(value)) return null;
  for (const [key, nested] of Object.entries(value)) {
    if (!isStatusCodeKey(key)) continue;
    const status = normalizeStatusCode(nested);
    if (status === 429) return status;
    fallback ??= status;
  }
  for (const nested of Object.values(value)) {
    const status = readStatusCode(nested);
    if (status === 429) return status;
    fallback ??= status;
  }
  return fallback;
}

function collectText(value: unknown, output: string[]): void {
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, output);
    return;
  }
  if (!isRecord(value)) return;
  for (const key of ['name', 'code', 'type', 'reason', 'status', 'message', 'detail', 'details', 'error']) {
    collectText(value[key], output);
  }
}

export function classifyProviderLimitEvidence(value: unknown): ProviderLimitCategory {
  const record = isRecord(value) ? value : null;
  const status = readStatusCode(value);
  const textParts: string[] = [];
  collectText(value, textParts);
  const text = textParts.join(' ').toLowerCase();
  const code = normalizeString(record?.code ?? record?.type ?? record?.reason ?? record?.name)?.toLowerCase() ?? '';
  const evidenceText = `${code} ${text}`;

  if (/\b(account|user)\s+(disabled|banned|suspended|deactivated)\b/u.test(text)) return 'disabled';
  if (/\b(usage_limit_reached|usage_limit_exceeded|usagelimitreached|usagelimitexceeded|freeusagelimiterror)\b/u.test(code)) return 'usage_limit';
  if (/\b(go_usage_limit|gousagelimiterror|account_rate_limit|rate_limit|rate_limit_error|ratelimit|ratelimiterror|rate limit|too many requests)\b/u.test(evidenceText)) return 'rate_limit';
  if (/\b(resource_exhausted|usage limit|limit reached|out of credits|credits exhausted)\b|\bquota(?:[_\s-]*(?:exceeded|exhausted|reached)|[_\s-]*limit[_\s-]*(?:exceeded|exhausted|reached))\b/u.test(evidenceText)) return 'usage_limit';
  if (status === 401 || /\b(unauthorized|unauthenticated|authentication|invalid api key|invalid token|login required|not logged in)\b/u.test(text)) return 'auth_invalid';
  if (status === 403 && /\b(scope|permission|auth|token|credential)\b/u.test(text)) return 'auth_invalid';
  if (status === 402 || /\b(upgrade|plan|billing|payment required|subscription|permission denied|not entitled|entitlement)\b/u.test(text)) return 'plan_invalid';
  if (/\b(capacity|overloaded|server[_\s-]*(?:is[_\s-]*)?overloaded|model[_\s-]*(?:is[_\s-]*)?overloaded|capacity[_\s-]*(?:exceeded|unavailable)|unavailable)\b/u.test(evidenceText)) return 'capacity';
  if (status === 400 || /\b(validation|invalid request|bad request|malformed)\b/u.test(text)) return 'validation_failed';
  if (status === 429) return 'rate_limit';
  return 'unknown';
}
