import type { CapturedEvent } from './socketClient';

export type PendingChangedUpdateBody = {
  t: 'pending-changed';
  sid?: unknown;
  sessionId?: unknown;
  pendingVersion?: unknown;
  pendingCount?: unknown;
  changedByAccountId?: unknown;
  meaningfulActivityAt?: unknown;
  [key: string]: unknown;
};

export function hasNewMessageUpdateWithLocalId(events: CapturedEvent[], localId: string): boolean {
  return countNewMessageUpdatesWithLocalId(events, localId) > 0;
}

export function countNewMessageUpdatesWithLocalId(events: CapturedEvent[], localId: string): number {
  return events.filter((event) => {
    if (event.kind !== 'update') return false;
    const body = event.payload?.body;
    if (!body || typeof body !== 'object') return false;
    const typedBody = body as { t?: unknown; message?: unknown };
    if (typedBody.t !== 'new-message') return false;
    const message = typedBody.message;
    if (!message || typeof message !== 'object') return false;
    return (message as { localId?: unknown }).localId === localId;
  }).length;
}

export function findPendingChangedUpdateAfter(params: {
  events: CapturedEvent[];
  sessionId: string;
  afterIndex?: number;
}): PendingChangedUpdateBody | null {
  const afterIndex = Math.max(0, params.afterIndex ?? 0);
  const slice = params.events.slice(afterIndex);
  for (const event of slice) {
    if (event.kind !== 'update') continue;
    const body = event.payload?.body;
    if (!body || typeof body !== 'object') continue;
    const typedBody = body as PendingChangedUpdateBody;
    if (typedBody.t !== 'pending-changed') continue;
    if (typedBody.sid !== params.sessionId && typedBody.sessionId !== params.sessionId) continue;
    return typedBody;
  }
  return null;
}
