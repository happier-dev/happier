import type { CapturedEvent } from './socketClient';

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
