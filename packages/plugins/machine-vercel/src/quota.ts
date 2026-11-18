import type { ConnectedAccountReadContext, ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import type { HttpResponse } from '@happier-dev/plugin-sdk/http';

type Quota = Awaited<ReturnType<NonNullable<ConnectedAccountRuntime['quota']>>>;

const ORIGIN = 'https://api.vercel.com';
const PLAN_LABELS = { hobby: 'Hobby', pro: 'Pro', enterprise: 'Enterprise' } as const;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function body(response: HttpResponse): unknown {
  try { return JSON.parse(new TextDecoder().decode(response.body)); } catch { return null; }
}

async function request(context: ConnectedAccountReadContext, token: string, url: string): Promise<HttpResponse | null> {
  try {
    const response = await context.services.http.request({ url, method: 'GET', redirect: 'error',
      headers: { authorization: `Bearer ${token}` } }, { signal: context.signal });
    context.signal.throwIfAborted();
    return response;
  } catch {
    context.signal.throwIfAborted();
    return null;
  }
}

export async function readVercelQuota(context: ConnectedAccountReadContext): Promise<Quota> {
  const observedAtMs = context.invokedAtMs;
  const configuredTeamId = context.configuration.values.teamId;
  const token = await context.credentials.get('token', { signal: context.signal });
  if (typeof token !== 'string' || token.length === 0) return { observedAtMs, planLabel: null, limits: [] };
  let teamId = typeof configuredTeamId === 'string' && configuredTeamId.trim().length > 0 ? configuredTeamId : null;
  // A sign-in acts only for the team it was granted; never Vercel's default team.
  if (teamId === null && context.configuration.target.modeId !== 'oauth') {
    const userResponse = await request(context, token, `${ORIGIN}/v2/user`);
    if (!userResponse || userResponse.status < 200 || userResponse.status >= 300) return { observedAtMs, planLabel: null, limits: [] };
    // `GET /v2/user` answers `{ user: { defaultTeamId } }` (API reference; unconfirmed by a capture until the release check).
    const envelope = body(userResponse);
    const user = object(envelope) && object(envelope.user) ? envelope.user : null;
    teamId = user && typeof user.defaultTeamId === 'string' && user.defaultTeamId.trim().length > 0
      ? user.defaultTeamId : null;
  }
  if (teamId === null) return { observedAtMs, planLabel: null, limits: [] };
  const response = await request(context, token, `${ORIGIN}/v2/teams/${encodeURIComponent(teamId)}`);
  if (!response) return { observedAtMs, planLabel: null, limits: [] };
  if (response.status < 200 || response.status >= 300) return { observedAtMs, planLabel: null, limits: [] };
  const value = body(response);
  if (!object(value) || value.id !== teamId) return { observedAtMs, planLabel: null, limits: [] };
  const plan = object(value) && object(value.billing) && typeof value.billing.plan === 'string'
    ? PLAN_LABELS[value.billing.plan.trim().toLowerCase() as keyof typeof PLAN_LABELS] : undefined;
  return { observedAtMs, planLabel: plan ?? null, limits: [] };
}
