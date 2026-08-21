import type { Credentials } from '@/persistence';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';

/**
 * Source-context creation is an Account-owned operation. Generic Replay reads
 * retain their released shared-Session behavior, but copying that replay into a
 * new child must require the V2 owner projection (`share: null`). Missing or
 * recipient projections fail closed rather than treating participant access as
 * authority to create a new Account-owned descendant.
 */
export type ReplaySourceContextAuthority =
  | Readonly<{ status: 'owned' }>
  | Readonly<{ status: 'not_owned' }>
  | Readonly<{ status: 'unavailable' }>;

export async function resolveReplaySourceContextAuthority(params: Readonly<{
  credentials: Credentials;
  sourceSessionId: string;
}>): Promise<ReplaySourceContextAuthority> {
  const rawSession = await fetchSessionByIdCompat({
    token: params.credentials.token,
    sessionId: params.sourceSessionId,
  });
  if (!rawSession) return { status: 'unavailable' };
  return rawSession.share === null ? { status: 'owned' } : { status: 'not_owned' };
}
