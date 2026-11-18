import type { ConnectedAccountReadContext, ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import type { HttpResponse } from '@happier-dev/plugin-sdk/http';
import { CLOUDFLARE_API_ORIGIN, isCloudflareId, isObject } from './probe.js';

type Quota = Awaited<ReturnType<NonNullable<ConnectedAccountRuntime['quota']>>>;

/**
 * Subscription rate-plan ids Happier recognizes, by exact id, named with their product so the account-wide label
 * never matches another product's plan (Workers Paid is not the Pages plan). Unconfirmed by a live capture until the
 * release check "Vercel and Cloudflare account plan lines" (PLAN U4); any other id says nothing.
 */
const WORKERS_PLAN_LABELS: Readonly<Record<string, string>> = { workers_paid: 'Workers Paid' };

function planLabel(value: unknown): string | null {
  return typeof value === 'string' && Object.hasOwn(WORKERS_PLAN_LABELS, value) ? WORKERS_PLAN_LABELS[value]! : null;
}

function parseBody(response: HttpResponse): unknown {
  try { return JSON.parse(new TextDecoder().decode(response.body)); } catch { return null; }
}

export async function readCloudflareQuota(context: ConnectedAccountReadContext): Promise<Quota> {
  const observedAtMs = context.invokedAtMs;
  const accountId = context.configuration.values.accountId;
  if (!isCloudflareId(accountId)) return { observedAtMs, planLabel: null, limits: [] };
  const token = await context.credentials.get('token', { signal: context.signal });
  if (typeof token !== 'string' || token.length === 0) return { observedAtMs, planLabel: null, limits: [] };
  const url = `${CLOUDFLARE_API_ORIGIN}/client/v4/accounts/${encodeURIComponent(accountId)}/subscriptions`;
  let response: HttpResponse;
  try {
    response = await context.services.http.request({ url, method: 'GET', redirect: 'error',
      headers: { authorization: `Bearer ${token}` } }, { signal: context.signal });
  } catch {
    context.signal.throwIfAborted();
    return { observedAtMs, planLabel: null, limits: [] };
  }
  context.signal.throwIfAborted();
  if (response.status < 200 || response.status >= 300) return { observedAtMs, planLabel: null, limits: [] };
  const value = parseBody(response);
  const subscriptions = isObject(value) && value.success === true && Array.isArray(value.result) ? value.result : [];
  for (const subscription of subscriptions) {
    if (!isObject(subscription)) continue;
    const ratePlan = isObject(subscription.rate_plan) ? subscription.rate_plan : null;
    const label = planLabel(ratePlan?.id);
    if (label) return { observedAtMs, planLabel: label, limits: [] };
  }
  return { observedAtMs, planLabel: null, limits: [] };
}
