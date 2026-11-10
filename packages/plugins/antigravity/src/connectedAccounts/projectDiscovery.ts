import { sleepWithSignal } from '@happier-dev/plugin-sdk/async';
import type { ConnectedAccountAuthenticationContext } from '@happier-dev/plugin-sdk/connected-accounts';
import { ANTIGRAVITY_CONTROL_PLANE_USER_AGENT, readAntigravityProjectId } from './client.js';

const endpoint = 'https://daily-cloudcode-pa.googleapis.com/v1internal';
const metadata = { ideType: 'ANTIGRAVITY' };
type Context = Pick<ConnectedAccountAuthenticationContext, 'services' | 'signal'>;
function record(value: unknown): Record<string, unknown> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function failure(code: string, status: 'rejected' | 'outcomeUnknown' = 'outcomeUnknown', httpStatus?: number) {
  return { status, diagnostic: { code, severity: 'error' as const, message: 'Antigravity project setup could not complete. Try connecting again.',
    ...(httpStatus === undefined ? {} : { details: { httpStatus } }),
  } };
}

/** Cloud Code Assist login contract: load entitlement, onboard if needed, then load the assigned project. */
export async function discoverAntigravityProject(accessToken: string, context: Context, signal = context.signal) {
  async function request(url: string, body?: Record<string, unknown>) {
    signal.throwIfAborted();
    let response;
    try {
      response = await context.services.http.request({ url, method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'User-Agent': ANTIGRAVITY_CONTROL_PLANE_USER_AGENT },
        ...(body ? { body: new TextEncoder().encode(JSON.stringify(body)) } : {}),
      }, { signal });
    } catch {
      signal.throwIfAborted();
      return failure('antigravity_project_transport_failed');
    }
    signal.throwIfAborted();
    if (response.status < 200 || response.status >= 300) return failure('antigravity_project_http_failed', response.status >= 400 && response.status < 500 && response.status !== 429 ? 'rejected' : 'outcomeUnknown', response.status);
    let bodyValue: unknown;
    try { bodyValue = JSON.parse(new TextDecoder().decode(response.body)); } catch { return failure('antigravity_project_response_invalid'); }
    const value = record(bodyValue);
    return value ? { status: 'success' as const, value } : failure('antigravity_project_response_invalid');
  }
  async function load() {
    const initial = await request(`${endpoint}:loadCodeAssist`, { metadata });
    if (initial.status !== 'success') return initial;
    const projectId = readAntigravityProjectId(initial.value.cloudaicompanionProject);
    return !record(initial.value.paidTier) && projectId
      ? request(`${endpoint}:loadCodeAssist`, { cloudaicompanionProject: projectId, metadata }) : initial;
  }
  const initial = await load();
  if (initial.status !== 'success') return initial;
  const allowed = Array.isArray(initial.value.allowedTiers) && initial.value.allowedTiers.some(tier => record(tier)?.id === 'free-tier');
  const ineligible = Array.isArray(initial.value.ineligibleTiers) && initial.value.ineligibleTiers.some(tier => record(tier)?.tierId === 'free-tier');
  if (!allowed && ineligible) return failure('antigravity_project_ineligible', 'rejected');
  if (!record(initial.value.currentTier)) {
    let operation = await request(`${endpoint}:onboardUser`, { tierId: 'free-tier', metadata });
    while (operation.status === 'success') {
      if (operation.value.done === true) {
        if (record(operation.value.error)) return failure('antigravity_project_onboarding_failed', 'rejected');
        if (!record(operation.value.response)) return failure('antigravity_project_response_invalid');
        break;
      }
      const name = text(operation.value.name);
      if (!name) return failure('antigravity_project_response_invalid');
      // Upstream Antigravity onboarding exposes an operation resource, not events.
      // Match its one-second poll cadence; the admitted attempt owns cancellation/deadline.
      await sleepWithSignal(1000, signal);
      operation = await request(`${endpoint}/${name}`);
    }
    if (operation.status !== 'success') return operation;
  }
  const refreshed = await load();
  if (refreshed.status !== 'success') return refreshed;
  const projectId = readAntigravityProjectId(refreshed.value.cloudaicompanionProject);
  return projectId ? { status: 'success' as const, projectId } : failure('antigravity_project_missing');
}
