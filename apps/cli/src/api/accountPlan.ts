import axios from 'axios';
import {
  AccountPlanResponseV1Schema,
  isHappierCloudServerUrl,
  type AccountPlanResponseV1,
  type PlanActionRefusal,
} from '@happier-dev/protocol';

import {
  createAuthenticationHttpStatusError,
  createHttpStatusError,
  isAuthenticationStatus,
} from '@/api/client/httpStatusError';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';

/**
 * HTTP adapters behind the Plans & Supporter Actions. Each documented refusal becomes a typed
 * result; any other non-2xx status throws, so a failed read never reads as "Free".
 */

type Auth = Readonly<{ token: string; signal?: AbortSignal }>;

function requestOptions(opts: Auth) {
  return {
    headers: { Authorization: `Bearer ${opts.token}`, 'Content-Type': 'application/json' },
    timeout: 15_000,
    ...(opts.signal ? { signal: opts.signal } : {}),
    validateStatus: () => true,
  };
}

function readErrorCode(data: unknown): string | null {
  return data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string'
    ? (data as { error: string }).error
    : null;
}

function throwForStatus(path: string, status: number, data: unknown): never {
  if (isAuthenticationStatus(status)) {
    throw createAuthenticationHttpStatusError(status, `Authentication failed for ${path} (${status})`);
  }
  throw createHttpStatusError(status, `${path} answered ${status}`, readErrorCode(data) ?? undefined);
}

export async function fetchAccountPlan(opts: Auth): Promise<AccountPlanResponseV1 | PlanActionRefusal> {
  const path = '/v1/account/plan';
  const response = await axios.get(`${resolveServerHttpBaseUrl()}${path}`, requestOptions(opts));
  // 404: neither `plans` nor `supporter` is on for this server.
  if (response.status === 404) return { ok: false, errorCode: 'plans_unavailable' };
  if (response.status < 200 || response.status >= 300) throwForStatus(path, response.status, response.data);
  return AccountPlanResponseV1Schema.parse(response.data);
}

/** Cloud only: elsewhere the app settles purchases through its own lookup path. */
export async function postBillingRefresh(opts: Auth): Promise<Readonly<{ ok: true }> | PlanActionRefusal> {
  const serverUrl = resolveServerHttpBaseUrl();
  if (!isHappierCloudServerUrl(serverUrl)) return { ok: false, errorCode: 'billing_refresh_cloud_only' };
  const path = '/v1/billing/refresh';
  const response = await axios.post(`${serverUrl}${path}`, {}, requestOptions(opts));
  if (response.status < 200 || response.status >= 300) throwForStatus(path, response.status, response.data);
  return { ok: true };
}

export async function putSupporterRing(opts: Auth & Readonly<{ visible: boolean }>): Promise<Readonly<{ visible: boolean }> | PlanActionRefusal> {
  const path = '/v1/account/supporter/ring';
  const response = await axios.put(`${resolveServerHttpBaseUrl()}${path}`, { visible: opts.visible }, requestOptions(opts));
  if (response.status === 409 && readErrorCode(response.data) === 'not_a_supporter') {
    return { ok: false, errorCode: 'not_a_supporter' };
  }
  if (response.status < 200 || response.status >= 300) throwForStatus(path, response.status, response.data);
  return { visible: (response.data as { visible?: unknown } | null)?.visible === true };
}
