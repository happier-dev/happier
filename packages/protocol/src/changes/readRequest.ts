import type { ChangeKind } from './index.js';

/** Negotiated GET cursor carrier. The response echoes it so an ignored cursor cannot advance a client. */
export const CHANGES_AFTER_CURSOR_HTTP_HEADER = 'x-happier-changes-after';

/** All change-feed clients share this wire builder; native/released peers retain query cursors. */
export function buildChangesReadRequest(params: Readonly<{
  after: number;
  limit?: number;
  sessionId?: string;
  sessionAccessSessionId?: string;
  kinds?: readonly ChangeKind[];
  cursorHeader?: boolean;
}>): Readonly<{ path: string; headers: Readonly<Record<string, string>> }> {
  const query = new URLSearchParams();
  if (!params.cursorHeader) query.set('after', String(params.after));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.sessionId !== undefined) query.set('sessionId', params.sessionId);
  if (params.sessionAccessSessionId !== undefined) query.set('sessionAccessSessionId', params.sessionAccessSessionId);
  if (params.kinds !== undefined) query.set('kinds', params.kinds.join(','));
  return {
    path: `/v2/changes?${query}`,
    headers: params.cursorHeader ? { [CHANGES_AFTER_CURSOR_HTTP_HEADER]: String(params.after) } : {},
  };
}
