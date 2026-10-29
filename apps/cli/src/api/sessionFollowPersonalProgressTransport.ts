import axios from '@/api/client/credentialAxios';
import { SESSION_FOLLOW_PERSONAL_PROGRESS_ROUTE_V1, SessionFollowPersonalProgressRequestV1Schema,
  SessionFollowPersonalProgressResponseV1Schema, type SessionFollowPersonalProgressRequestV1,
  type SessionFollowPersonalProgressResponseV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';

/** The source daemon settles existing private Follow progress through its captured Account transport. */
export async function submitAccountFollowPersonalProgress(input: Readonly<{
  token: string; serverHttpBaseUrl: string; signal: AbortSignal; occurrence: SessionFollowPersonalProgressRequestV1;
}>): Promise<SessionFollowPersonalProgressResponseV1 | null> {
  const request = SessionFollowPersonalProgressRequestV1Schema.safeParse(input.occurrence);
  if (!request.success || input.signal.aborted) return null;
  try {
    const response = await axios.post<unknown>(`${input.serverHttpBaseUrl}${SESSION_FOLLOW_PERSONAL_PROGRESS_ROUTE_V1}`, request.data, {
      headers: { Authorization: `Bearer ${input.token}` }, signal: input.signal, validateStatus: () => true,
    });
    if (input.signal.aborted || response.status !== 200) return null;
    const parsed = SessionFollowPersonalProgressResponseV1Schema.safeParse(response.data);
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}
