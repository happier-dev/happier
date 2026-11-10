import { isPluginError, PluginError, type DeploymentTargetRoleFailureV1 } from '@happier-dev/plugin-sdk';
import type { HttpMethod, HttpRequest, HttpService } from '@happier-dev/plugin-sdk/http';
import { isObject } from '../connectedAccounts/probe.js';

export type DeploymentContext = Readonly<{ http: Pick<HttpService, 'request'>; signal: AbortSignal; now(): number }>;
type Phase = DeploymentTargetRoleFailureV1['phase'];
type Reply = Readonly<{ value: unknown; resultInfo?: unknown }> | DeploymentTargetRoleFailureV1;
const origin = 'https://api.cloudflare.com';

export function failure(code: DeploymentTargetRoleFailureV1['code'], phase: Phase): DeploymentTargetRoleFailureV1 {
  return { v: 1, code, phase, retryable: false };
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
    if (isPluginError(error)) throw error;
    // A locally stopped request cannot prove that a sent build/cancel did not run.
    if (mutation) return failure('outcome_unknown', phase);
    context.signal.throwIfAborted();
    return failure('provider_request_failed', phase);
  }
  if (response.status === 401 || response.status === 403) throw new PluginError({ code: 'deployment_access_denied',
    details: { phase }, failureCause: { phase: `deployment.provider.${phase}`, errorClass: 'Error',
      errorCode: null, httpStatus: response.status } });
  if (mutation && context.signal.aborted) return failure('outcome_unknown', phase);
  context.signal.throwIfAborted();
  if (response.status === 404) return failure('deployment_unavailable', phase);
  if (response.status < 200 || response.status >= 300) return failure(mutation && response.status >= 500 ? 'outcome_unknown' : 'provider_request_failed', phase);
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(response.body)); }
  catch { return failure(mutation ? 'outcome_unknown' : 'provider_response_invalid', phase); }
  if (isObject(body) && body.success === false) return failure('provider_request_failed', phase);
  // Cloudflare's deletion, asset upload and hash-registration ACKs contain success/errors/messages,
  // without result. Data-bearing endpoints still require their result envelope.
  if (!isObject(body) || body.success !== true || (!acknowledgementOnly && !('result' in body))) return failure(mutation ? 'outcome_unknown' : 'provider_response_invalid', phase);
  return { value: body.result, ...(body.result_info === undefined ? {} : { resultInfo: body.result_info }) };
}
