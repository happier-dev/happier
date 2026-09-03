import { fetchSessionsPage as fetchSessionsPageDefault } from '@/session/transport/http/sessionsHttp';

export type PendingSessionActivationInput = Readonly<{
  sessionId: string;
  requestId: string;
  pendingVersion: number;
  source: 'live' | 'changes' | 'scan';
}>;

export async function recoverPendingSessionActivations(params: Readonly<{
  token: string;
  activate: (input: PendingSessionActivationInput) => Promise<void>;
  fetchSessionsPage?: typeof fetchSessionsPageDefault;
}>): Promise<void> {
  const fetchSessionsPage = params.fetchSessionsPage ?? fetchSessionsPageDefault;
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  while (true) {
    const page = await fetchSessionsPage({
      token: params.token,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    for (const session of page.sessions) {
      if (session.share !== null && session.share !== undefined) continue;
      const authorization = session.pendingActivationAuthorization;
      if (!authorization || authorization.status !== 'waiting') continue;
      await params.activate({
        sessionId: session.id,
        requestId: authorization.requestId,
        pendingVersion: typeof session.pendingVersion === 'number' ? session.pendingVersion : 0,
        source: 'scan',
      });
    }
    if (!page.hasNext || !page.nextCursor || seenCursors.has(page.nextCursor)) return;
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}
