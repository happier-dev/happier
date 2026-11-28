import { requestGoogleCodeAssist, type GoogleCodeAssistFetchRuntime } from '@/daemon/connectedServices/quotas/googleCodeAssistRequest';

// The Antigravity ACP 1.3.0 useragent.py client surface. Without this product token Google returns
// UNSUPPORTED_CLIENT instead of the entitlement (re-observed 2026-11-27 against prod and daily while
// agy 1.5.18 was current). It describes these control-plane requests, not a runtime.
export const AGY_CODE_ASSIST_USER_AGENT = 'antigravity/acp/1.3.0 (aidev_client; host_path=happier; proxy_client=antigravity/sdk)';

export type AgyCodeAssistRequest = Readonly<{ fetchRuntime: GoogleCodeAssistFetchRuntime; accessToken: string; signal: AbortSignal }>;

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** The account's Code Assist entitlement (`loadCodeAssist`); ACP 1.3.0 onboard.py bootstraps on prod. */
export async function loadAgyCodeAssistEntitlement(request: AgyCodeAssistRequest, project: string | null): Promise<Record<string, unknown> | null> {
  return object(await requestGoogleCodeAssist({ ...request, userAgent: AGY_CODE_ASSIST_USER_AGENT,
    endpoint: 'https://cloudcode-pa.googleapis.com', method: 'loadCodeAssist',
    body: { metadata: { ideType: 'ANTIGRAVITY' }, ...(project ? { cloudaicompanionProject: project } : {}) } }));
}

function validationTiers(load: Record<string, unknown> | null): Record<string, unknown>[] {
  return Array.isArray(load?.ineligibleTiers)
    ? load.ineligibleTiers.map(object).filter((tier): tier is Record<string, unknown> => tier?.reasonCode === 'VALIDATION_REQUIRED')
    : [];
}

/** Code Assist reports an account Google must verify (agy: "Verification required") as an ineligible tier with this reason. */
export function awaitsGoogleValidation(load: Record<string, unknown> | null): boolean {
  return validationTiers(load).length > 0;
}

/**
 * Only an https link on a Google-owned host is ever shown. Observed and CLI-proto evidence:
 * `IneligibleTier.validation_url` (accounts.google.com sign-in continuation) and the ToS appeal
 * link on support.google.com.
 */
export function readGoogleAccountLink(value: unknown): string | null {
  if (typeof value !== 'string' || !URL.canParse(value.trim())) return null;
  const url = new URL(value.trim());
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  return host === 'google.com' || host.endsWith('.google.com') ? url.toString() : null;
}

/** Google's verification link for an account awaiting validation; null when absent or not a Google link. */
export function readGoogleValidationUrl(load: Record<string, unknown> | null): string | null {
  for (const tier of validationTiers(load)) {
    const url = readGoogleAccountLink(tier.validationUrl);
    if (url) return url;
  }
  return null;
}
