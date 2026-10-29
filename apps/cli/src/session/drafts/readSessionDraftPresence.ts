import axios from '@/api/client/credentialAxios';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { SessionDraftListResponseV2Schema, SESSION_DRAFT_V2_ROUTE_LIST } from '@happier-dev/protocol/drafts/sessionDraftsV2';

export type SessionDraftPresence = Readonly<
  | { status: 'present'; updatedAt: number }
  | { status: 'absent'; updatedAt?: number }
  | { status: 'unknown' }
>;

/** The caller supplies the exact admitted requester, never a custodian fallback. */
export async function readSessionDraftPresence(input: Readonly<{
  sessionId: string;
  requester: Readonly<{ token: string; serverHttpBaseUrl: string; isCurrent(): Promise<boolean> }> | null;
  signal?: AbortSignal;
}>): Promise<SessionDraftPresence> {
  const requester = input.requester;
  if (!requester || !input.sessionId) return { status: 'unknown' };
  let after: string | undefined;
  let updatedAt: number | undefined;
  let present = false;
  try {
    for (;;) {
      if (input.signal?.aborted || !await requester.isCurrent()) return { status: 'unknown' };
      const response = await axios.post(`${requester.serverHttpBaseUrl.replace(/\/$/u, '')}${SESSION_DRAFT_V2_ROUTE_LIST}`, {
        addressKinds: ['session', 'run', 'discussion', 'newDiscussion'], ...(after !== undefined ? { after } : {}),
      }, { headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${requester.token}` },
        ...(input.signal ? { signal: input.signal } : {}) });
      const page = SessionDraftListResponseV2Schema.safeParse(response.data);
      if (!page.success || input.signal?.aborted || !await requester.isCurrent()) return { status: 'unknown' };
      for (const record of page.data.items) {
        if ('sessionId' in record.address && record.address.sessionId === input.sessionId) {
          updatedAt = Math.max(updatedAt ?? 0, record.updatedAt);
          if (record.content !== null) present = true;
        }
      }
      const next = page.data.nextAfter;
      if (next === undefined) return present && updatedAt !== undefined
        ? { status: 'present', updatedAt } : { status: 'absent', ...(updatedAt !== undefined ? { updatedAt } : {}) };
      // A repeated/backwards cursor is incomplete coverage, not an empty result.
      if (after !== undefined && next <= after) return { status: 'unknown' };
      after = next;
    }
  } catch { return { status: 'unknown' }; }
}
