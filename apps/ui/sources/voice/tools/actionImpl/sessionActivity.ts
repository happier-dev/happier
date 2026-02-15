import { storage } from '@/sync/domains/state/storage';

export async function getSessionActivityForVoiceTool(params: Readonly<{ sessionId: string; windowSeconds?: number }>): Promise<
  | Readonly<{ ok: true; sessionId: string; presence: string | null; active: boolean; thinking: boolean; updatedAt: number | null; permissionRequestIds: readonly string[]; messageCounts: Readonly<{ total: number; assistant: number; user: number }> }>
  | Readonly<{ ok: false; errorCode: string; errorMessage: string; sessionId: string }>
> {
  const sessionId = String(params.sessionId ?? '').trim();
  const state: any = storage.getState();
  const session: any = state?.sessions?.[sessionId] ?? null;
  if (!session) {
    return { ok: false, errorCode: 'session_not_found', errorMessage: 'session_not_found', sessionId };
  }

  const requests = (session?.agentState?.requests ?? {}) as Record<string, unknown>;
  const permissionRequestIds = Object.keys(requests);

  const messages = (state?.sessionMessages?.[sessionId]?.messages ?? []) as any[];
  const messageCounts = messages.reduce(
    (acc, m) => {
      const kind = m?.kind;
      acc.total += 1;
      if (kind === 'agent-text' || kind === 'tool-call') acc.assistant += 1;
      if (kind === 'user-text') acc.user += 1;
      return acc;
    },
    { total: 0, assistant: 0, user: 0 },
  );

  return {
    ok: true,
    sessionId,
    presence: typeof session?.presence === 'string' ? session.presence : null,
    active: Boolean(session?.active),
    thinking: Boolean(session?.thinking),
    updatedAt: typeof session?.updatedAt === 'number' ? session.updatedAt : null,
    permissionRequestIds,
    messageCounts,
  };
}

