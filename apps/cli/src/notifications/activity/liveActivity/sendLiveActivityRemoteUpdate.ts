import type { LiveActivityRemoteUpdateRequestV1 } from '@happier-dev/protocol';

export type LiveActivityRemoteUpdateSender = Readonly<{
  serverId: string;
  sendLiveActivityRemoteUpdateAsync: (request: LiveActivityRemoteUpdateRequestV1) => Promise<unknown>;
}>;

export async function sendLiveActivityRemoteUpdate(params: Readonly<{
  request: LiveActivityRemoteUpdateRequestV1;
  sender: LiveActivityRemoteUpdateSender;
}>): Promise<void> {
  await params.sender.sendLiveActivityRemoteUpdateAsync(params.request);
}
