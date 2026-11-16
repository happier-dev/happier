import type { ConnectedAccountPortableAuthenticationContext, ConnectedAccountAuthenticationModeRuntime,
  ConnectedAccountManualCompletion } from '@happier-dev/plugin-sdk/connected-accounts';

type Completion = Awaited<ReturnType<Extract<ConnectedAccountAuthenticationModeRuntime, { kind: 'manual' }>['complete']>>;
type FirstAdminContext = Pick<ConnectedAccountPortableAuthenticationContext, 'services' | 'signal' | 'attempt' | 'attemptCredentials'>;
function failure(status: 'rejected' | 'unavailable' | 'outcomeUnknown', code: string, message: string): Completion {
  switch (status) {
    case 'rejected': return { status, diagnostic: { code, severity: 'error', message } };
    case 'unavailable': return { status, diagnostic: { code, severity: 'error', message } };
    case 'outcomeUnknown': return { status, diagnostic: { code, severity: 'error', message } };
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Coder v2.39.0 codersdk/users.go: CreateFirstUser and LoginWithPassword.
 * Passwords stay in this invocation; the connected-account owner receives only the session token.
 */
export async function completeCoderFirstAdmin(input: ConnectedAccountManualCompletion,
  context: FirstAdminContext, endpoint: string): Promise<Completion> {
  if (!endpoint.startsWith('https://')) return failure('rejected', 'coder_first_admin_https_required',
    'Use an HTTPS Coder deployment URL before entering administrator credentials.');
  const { email, username, password } = input.fields;
  if (!email || !username || !password) return failure('rejected', 'coder_first_admin_fields_required',
    'Enter the administrator email, username and password.');
  let phase: 'create' | 'login' | 'stage' = 'create';
  let dispatched = false;
  const recovery = 'The first user may already exist. Retry with the same administrator credentials, or connect using a user token from the Coder deployment.';
  const post = async (path: string, body: Readonly<Record<string, string | boolean>>) => {
    context.signal.throwIfAborted();
    dispatched = true;
    const url = endpoint + path;
    return context.services.http.request({ url, method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: new TextEncoder().encode(JSON.stringify(body)) }, { signal: context.signal });
  };
  const responseBody = (body: Uint8Array): unknown => {
    try { return JSON.parse(new TextDecoder().decode(body)); } catch { return null; }
  };
  try {
    const created = await post('/api/v2/users/first', { email, username, password, trial: false });
    if (created.finalUrl !== endpoint + '/api/v2/users/first') return failure('outcomeUnknown',
      'coder_first_admin_create_origin_changed', recovery);
    if (created.status === 201) {
      const body = responseBody(created.body);
      if (!object(body) || typeof body.user_id !== 'string' || !body.user_id
        || typeof body.organization_id !== 'string' || !body.organization_id) {
        return failure('outcomeUnknown', 'coder_first_admin_create_response_invalid', recovery);
      }
    } else if (created.status !== 409) {
      return failure(created.status >= 500 ? 'outcomeUnknown' : created.status === 429 ? 'unavailable' : 'rejected',
        `coder_first_admin_create_http_${created.status}`, 'Coder did not confirm first-user creation. ' + recovery);
    }
    // A native 409 also permits recovery after a prior creation reply was lost.
    // It never authorizes changing an existing user's password or repeating creation.
    phase = 'login';
    const login = await post('/api/v2/users/login', { email, password });
    if (login.finalUrl !== endpoint + '/api/v2/users/login') return failure('outcomeUnknown',
      'coder_first_admin_login_origin_changed', recovery);
    if (login.status !== 201) return failure(login.status >= 500 || login.status === 429 ? 'unavailable' : 'rejected',
      `coder_first_admin_login_http_${login.status}`, 'The first user exists, but Coder did not complete sign-in. ' + recovery);
    const body = responseBody(login.body);
    if (!object(body) || typeof body.session_token !== 'string' || !body.session_token.trim() || /[\r\n]/u.test(body.session_token)) {
      return failure('outcomeUnknown', 'coder_first_admin_login_response_invalid', recovery);
    }
    context.signal.throwIfAborted();
    phase = 'stage';
    await context.attemptCredentials.set('token', body.session_token, { signal: context.signal });
    return { status: 'connected', displayName: endpoint, scopes: [],
      ...(context.attempt.kind === 'reconnect' ? { accountId: context.attempt.account.accountId } : {}) };
  } catch {
    if (context.signal.aborted) return failure(dispatched ? 'outcomeUnknown' : 'rejected',
      'coder_first_admin_cancelled', dispatched ? 'Administrator setup was cancelled. ' + recovery : 'Administrator setup was cancelled before sending credentials.');
    if (phase === 'stage') return failure('unavailable', 'coder_first_admin_credential_store_failed',
      'Coder signed in, but the connected account could not retain the token. ' + recovery);
    return failure('outcomeUnknown', `coder_first_admin_${phase}_transport`,
      `The Coder ${phase === 'create' ? 'first-user creation' : 'sign-in'} reply was not received. ` + recovery);
  }
}
