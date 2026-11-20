import { projectActionFailureCauseV1, withActionFailureDiagnostic } from '@happier-dev/plugin-sdk/errors';
import { isPluginError, PluginError, type DeploymentTargetRoleFailureV1 } from '@happier-dev/plugin-sdk';
import type { HttpMethod, HttpRequest, HttpService } from '@happier-dev/plugin-sdk/http';
import { isObject } from '../connectedAccounts/probe.js';

export type DeploymentContext = Readonly<{ http: Pick<HttpService, 'request'>; signal: AbortSignal; now(): number }>;
type Phase = DeploymentTargetRoleFailureV1['phase'];
type Reply = Readonly<{ value: unknown; resultInfo?: unknown }> | DeploymentTargetRoleFailureV1;
const origin = 'https://api.cloudflare.com';

export function failure(code: DeploymentTargetRoleFailureV1['code'], phase: Phase,
  failureCause?: ReturnType<typeof projectActionFailureCauseV1>): DeploymentTargetRoleFailureV1 {
  const result: DeploymentTargetRoleFailureV1 = { v: 1, code, phase, retryable: false };
  // In-process Action adapters project this cause. The role result's JSON shape stays closed.
  if (failureCause !== undefined) Object.defineProperty(result, 'failureCause', { value: failureCause });
  return code === 'deployment_unavailable' ? withActionFailureDiagnostic(result, { phase: `deployment.cloudflare.${phase}`, causeKind: 'not_found' }) : result;
}
function accountRoot(accountId: string) { return `${origin}/client/v4/accounts/${encodeURIComponent(accountId)}`; }

/** The existing HTTP owner owns custody/redirects. No raw credentials or retries. */
export async function request(context: DeploymentContext, accountId: string, path: string, phase: Phase,
  method: HttpMethod = 'GET', payload?: unknown, contentType = 'application/json'): Promise<Reply> {
  return send(context, { url: `${accountRoot(accountId)}${path}`, method, redirect: 'error',
    credentialBinding: { kind: 'connectedAccountPurpose', purpose: 'deploy.manage', origin, method, headerNames: ['authorization'] },
    ...(payload === undefined ? {} : { headers: { 'content-type': contentType },
      body: payload instanceof Uint8Array ? payload : new TextEncoder().encode(JSON.stringify(payload)) }),
  }, phase, method === 'DELETE');
}

/** Account choices use the same credential binding and response owner as account-scoped reads. */
export async function requestAccounts(context: DeploymentContext, query: string): Promise<Reply> {
  return send(context, { url: `${origin}/client/v4/accounts${query}`, method: 'GET', redirect: 'error',
    credentialBinding: { kind: 'connectedAccountPurpose', purpose: 'deploy.manage', origin, method: 'GET', headerNames: ['authorization'] },
  }, 'link');
}

/** Zone-scoped DNS uses the same Account purpose and provider response owner. */
export async function requestZone(context: DeploymentContext, zoneId: string, path: string,
  method: HttpMethod = 'GET', payload?: unknown): Promise<Reply> {
  return send(context, { url: `${origin}/client/v4/zones/${encodeURIComponent(zoneId)}${path}`, method, redirect: 'error',
    credentialBinding: { kind: 'connectedAccountPurpose', purpose: 'deploy.manage', origin, method, headerNames: ['authorization'] },
    ...(payload === undefined ? {} : { headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify(payload)) }),
  }, method === 'GET' ? 'observe' : 'send');
}

/** Project-issued upload JWTs use their own header, never the Account token binding. */
export async function requestPagesAssets(context: DeploymentContext, path: 'check-missing' | 'upload' | 'upsert-hashes', jwt: string, payload: unknown): Promise<Reply> {
  return send(context, { url: `${origin}/client/v4/pages/assets/${path}`, method: 'POST', redirect: 'error',
    headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify(payload)) }, 'send', path !== 'check-missing');
}

/** Worker asset sessions issue a separate upload JWT; never substitute the Account credential. */
export async function requestWorkerAssets(context: DeploymentContext, accountId: string, jwt: string,
  body: Uint8Array, contentType: string): Promise<Reply> {
  return send(context, { url: `${accountRoot(accountId)}/workers/assets/upload?base64=true`, method: 'POST', redirect: 'error',
    headers: { authorization: `Bearer ${jwt}`, 'content-type': contentType }, body }, 'send');
}

async function send(context: DeploymentContext, input: HttpRequest, phase: Phase, acknowledgementOnly = false): Promise<Reply> {
  context.signal.throwIfAborted();
  const mutation = input.method !== 'GET';
  let response;
  try {
    response = await context.http.request(input, { signal: context.signal });
  } catch (error) {
    // The body limit is raised after a response arrives, so it cannot prove a write failed.
    if (mutation && isPluginError(error) && error.code === 'plugin_fetch_response_too_large') {
      throw new PluginError({ code: 'outcome_unknown', retryable: false, details: { phase },
        failureCause: projectActionFailureCauseV1(error, `deployment.provider.${phase}`) });
    }
    if (isPluginError(error)) throw error;
    if (phase === 'teardown') throw new PluginError({ code: 'outcome_unknown', retryable: false, details: { phase },
      failureCause: projectActionFailureCauseV1(error, 'deployment.provider.teardown') });
    // A locally stopped request cannot prove that a sent build/cancel did not run.
    if (!mutation) context.signal.throwIfAborted();
    return failure(mutation ? 'outcome_unknown' : 'provider_request_failed', phase,
      projectActionFailureCauseV1(error, `deployment.provider.${phase}`));
  }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(response.body)); } catch { body = undefined; }
  const nativeError = isObject(body) && Array.isArray(body.errors) ? body.errors[0] : undefined;
  const nativeCode = isObject(nativeError) && (typeof nativeError.code === 'number' || typeof nativeError.code === 'string')
    ? String(nativeError.code) : null;
  // A failed deletion or absence read cannot establish removal. Preserve the
  // provider cause while the receipt retains its exact resource for recovery.
  if (phase === 'teardown' && response.status >= 500) throw new PluginError({ code: 'outcome_unknown', retryable: false, details: { phase },
    failureCause: { phase: 'deployment.provider.teardown', errorClass: 'Error', errorCode: null,
      ...(nativeCode === null ? {} : { nativeErrorCode: nativeCode }), httpStatus: response.status } });
  if (mutation && response.status >= 500) return failure('outcome_unknown', phase, {
    phase: `deployment.provider.${phase}`, errorClass: 'Error', errorCode: null,
    ...(nativeCode === null ? {} : { nativeErrorCode: nativeCode }), httpStatus: response.status,
  });
  if (response.status >= 400 && response.status < 500
    || isObject(body) && body.success === false
    || (response.status < 200 || response.status >= 300) && isObject(nativeError)) {
    throw withActionFailureDiagnostic(new PluginError({ code: response.status === 401 || response.status === 403 ? 'deployment_access_denied'
      : response.status === 404 ? 'deployment_unavailable' : 'provider_request_failed', retryable: false, details: { phase },
      ...(mutation ? { effectAttempted: true } : {}),
      failureCause: { phase: `deployment.provider.${phase}`, errorClass: 'Error', errorCode: null, ...(nativeCode === null ? {} : { nativeErrorCode: nativeCode }), httpStatus: response.status } }), { phase: `deployment.cloudflare.provider.${phase ?? 'request'}`, causeKind: response.status === 404 ? 'not_found' : response.status === 401 || response.status === 403 ? 'access_denied' : 'native_failure' });
  }
  // Preserve acknowledged results even when local cancellation races with the response.
  if (response.status < 200 || response.status >= 300) {
    return failure('provider_request_failed', phase, {
      phase: `deployment.provider.${phase}`, errorClass: 'Error', errorCode: null, httpStatus: response.status,
    });
  }
  if (body === undefined) return failure(mutation ? 'outcome_unknown' : 'provider_response_invalid', phase);
  // Cloudflare's deletion, asset upload and hash-registration ACKs contain success/errors/messages,
  // without result. Data-bearing endpoints still require their result envelope.
  if (!isObject(body) || body.success !== true || (!acknowledgementOnly && !('result' in body))) return failure(mutation ? 'outcome_unknown' : 'provider_response_invalid', phase);
  return { value: body.result, ...(body.result_info === undefined ? {} : { resultInfo: body.result_info }) };
}
