import type {
  ACPMessageData,
  ACPProvider,
} from '../../sessionMessageTypes';
import { prepareAcpTranscriptDispatch } from '../../outbound/providers/sessionTranscriptDispatch';
import { buildUserTextMessageContent } from '../../outbound/shared';

import type { SessionClientTranscriptSendPort } from './sendMessages';

type PlainOrEncryptedPayload = ReturnType<SessionClientTranscriptSendPort['buildOutboundSessionMessagePayload']>;

export function prepareCommittedAgentMessageViaPort(
  port: SessionClientTranscriptSendPort,
  provider: ACPProvider,
  body: ACPMessageData,
  opts: Readonly<{ localId: string; meta?: Record<string, unknown> }>,
): Readonly<{
  normalizedBody: ACPMessageData;
  localId: string;
  sidechainId: string | null;
  payload: PlainOrEncryptedPayload;
}> {
  const { normalizedBody, content, localId, sidechainId } = prepareAcpTranscriptDispatch({
    provider,
    body,
    meta: opts.meta,
    localId: opts.localId,
    toolCallCanonicalNameByProviderAndId: port.toolCallCanonicalNameByProviderAndId,
    permissionToolCallRawInputByProviderAndId: port.permissionToolCallRawInputByProviderAndId,
    toolCallInputByProviderAndId: port.toolCallInputByProviderAndId,
  });

  return {
    normalizedBody,
    localId,
    sidechainId,
    payload: port.buildOutboundSessionMessagePayload(content),
  };
}

export function prepareCommittedUserTextMessageViaPort(
  port: SessionClientTranscriptSendPort,
  text: string,
  opts: Readonly<{ localId: string; meta?: Record<string, unknown> }>,
): Readonly<{
  localId: string;
  payload: PlainOrEncryptedPayload;
}> {
  const content = buildUserTextMessageContent(text, opts.meta);

  return {
    localId: opts.localId,
    payload: port.buildOutboundSessionMessagePayload(content),
  };
}
