import type { LiveActivityRemoteUpdateRequestV1 } from '@happier-dev/protocol';

import type { LiveActivityRemoteUpdateSender } from './sendLiveActivityRemoteUpdate';

export type LiveActivityRemoteSenderCandidate = Readonly<{
  serverId?: string | null;
  sendLiveActivityRemoteUpdateAsync?: (request: LiveActivityRemoteUpdateRequestV1) => Promise<unknown>;
}>;

export function resolveLiveActivityRemoteSender(
  candidate: LiveActivityRemoteSenderCandidate | null | undefined,
): LiveActivityRemoteUpdateSender | null {
  const serverId = typeof candidate?.serverId === 'string' ? candidate.serverId.trim() : '';
  const send = candidate?.sendLiveActivityRemoteUpdateAsync;
  if (!serverId || typeof send !== 'function') return null;
  return {
    serverId,
    sendLiveActivityRemoteUpdateAsync: (request) => send.call(candidate, request),
  };
}
