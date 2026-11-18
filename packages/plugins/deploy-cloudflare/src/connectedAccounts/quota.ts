import type { ConnectedAccountReadContext, ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import type { HttpResponse } from '@happier-dev/plugin-sdk/http';
import { CLOUDFLARE_API_ORIGIN, isCloudflareId, isObject } from './probe.js';

type Quota = Awaited<ReturnType<NonNullable<ConnectedAccountRuntime['quota']>>>;

function planLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim().toLowerCase();
  if (!id.includes('worker')) return null;
  if (id.includes('paid') || id.includes('pro')) return 'Paid';
  if (id.includes('free')) return 'Free';
  return null;
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
    const label = planLabel(ratePlan?.id) ?? planLabel(ratePlan?.public_name) ?? planLabel(subscription.name);
    if (label) return { observedAtMs, planLabel: label, limits: [] };
  }
  return { observedAtMs, planLabel: null, limits: [] };
}
