import { AGY_OAUTH_CLIENT_ID, AGY_OAUTH_USERINFO_URL } from './oauth.js';

export class AgyOauthAccountError extends Error {
  constructor(readonly kind: 'project_required' | 'ineligible', message: string) { super(message); this.name = 'AgyOauthAccountError'; }
}

export const AGY_CLOUDCODE_API_BASE_URLS = Object.freeze(['https://daily-cloudcode-pa.googleapis.com', 'https://cloudcode-pa.googleapis.com'] as const);

/** Uses the native ACP request identity for Google account and Cloud Code requests. */
export function createAgyApiHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'User-Agent': 'antigravity/acp/agy_acp_server_1.1.1 (aidev_client; host_path=happier; proxy_client=antigravity/sdk)' };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }

/**
 * Verifies the Google identity and resolves the provider-issued project and tier.
 * Imports are read-only; browser connections may onboard an eligible free account.
 * Every request and onboarding wait shares the caller’s cancellation signal.
 */
export async function resolveAgyOauthAccount(input: Readonly<{
  accessToken: string;
  projectId?: string;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  allowOnboarding?: boolean;
}>): Promise<Readonly<{
  account: { id: string; email: string };
  antigravity: { clientId: string; authMethod: 'oauth-personal'; projectId: string; tierId?: string };
}>> {
  const fetcher = input.fetcher ?? fetch;
  const headers = createAgyApiHeaders(input.accessToken);
  const request = async (url: string, body?: unknown) => {
    input.signal?.throwIfAborted();
    const response = await fetcher(url, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: input.signal });
    if (!response.ok) throw new Error(`Antigravity account verification failed (HTTP ${response.status})`);
    return record(await response.json());
  };
  const user = await request(AGY_OAUTH_USERINFO_URL);
  const id = text(user.id) ?? text(user.sub);
  const email = text(user.email);
  if (!id || !email || user.verified_email === false || user.email_verified === false) throw new Error('Antigravity requires a verified Google account');
  let base: string = AGY_CLOUDCODE_API_BASE_URLS[1];
  const loadBody = { metadata: { ideType: 'ANTIGRAVITY' }, ...(input.projectId ? { cloudaicompanionProject: input.projectId } : {}) };
  let loaded = await request(`${base}/v1internal:loadCodeAssist`, loadBody);
  if (record(loaded.paidTier).usesGcpTos !== true) base = AGY_CLOUDCODE_API_BASE_URLS[0];
  let projectId = text(loaded.cloudaicompanionProject) ?? text(record(loaded.cloudaicompanionProject).id);
  if ((!projectId || !loaded.currentTier) && input.allowOnboarding !== false) {
    const allowed = Array.isArray(loaded.allowedTiers) && loaded.allowedTiers.some((tier) => record(tier).id === 'free-tier');
    if (!allowed) throw new AgyOauthAccountError('ineligible', 'Antigravity account is not eligible; verify account eligibility or supply a Google project');
    let operation = await request(`${base}/v1internal:onboardUser`, { tierId: 'free-tier', metadata: { ideType: 'ANTIGRAVITY' } });
    const name = text(operation.name);
    // Official ACP onboarding polls at one second for at most thirty attempts.
    for (let attempt = 0; name && !operation.done && attempt < 30; attempt += 1) {
      if (!/^operations\/[A-Za-z0-9._/-]+$/.test(name)) throw new Error('Antigravity returned an invalid onboarding operation');
      await new Promise<void>((resolve, reject) => {
        const signal = input.signal;
        const onAbort = () => { clearTimeout(timer); reject(signal?.reason); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, 1000);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
      input.signal?.throwIfAborted();
      operation = await request(`${base}/v1internal/${name}`);
    }
    if (!operation.done || operation.error) throw new Error('Antigravity onboarding did not complete; retry connection');
    loaded = await request(`${base}/v1internal:loadCodeAssist`, loadBody);
    projectId = text(loaded.cloudaicompanionProject) ?? text(record(loaded.cloudaicompanionProject).id);
  }
  if (!projectId) throw new AgyOauthAccountError('project_required', 'Antigravity project is unavailable; provide --project or authorize your account in the browser');
  const tierId = text(record(loaded.paidTier).id) ?? text(record(loaded.currentTier).id);
  return { account: { id, email }, antigravity: { clientId: AGY_OAUTH_CLIENT_ID, authMethod: 'oauth-personal', projectId, ...(tierId ? { tierId } : {}) } };
}
