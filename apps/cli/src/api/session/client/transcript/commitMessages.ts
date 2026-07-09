import type {
  ACPMessageData,
  ACPProvider,
} from '../../sessionMessageTypes';
import { prepareAcpTranscriptDispatch } from '../../outbound/transcriptDispatch';
import { buildUserTextMessageContent } from '../../outbound/shared';
import { resolveAcpSessionMessageRole } from '../../messageRole';

import type { SessionClientTranscriptSendPort } from './sendMessages';

type PlainOrEncryptedPayload = ReturnType<SessionClientTranscriptSendPort['buildOutboundSessionMessagePayload']>;
type SessionMessageRole = 'user' | 'agent' | 'event' | 'unknown';

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
  messageRole: SessionMessageRole;
}> {
  const { normalizedBody, content, localId, sidechainId } = prepareAcpTranscriptDispatch({
    provider,
    body,
    meta: opts.meta,
    localId: opts.localId,
    toolCallCanonicalNameByProviderAndId: port.toolCallCanonicalNameByProviderAndId,
    permissionToolCallRawInputByProviderAndId: port.permissionToolCallRawInputByProviderAndId,
    toolCallInputByProviderAndId: port.toolCallInputByProviderAndId,
    maxToolCallCacheEntries: port.maxToolCallCacheEntries,
  });

  return {
    normalizedBody,
    localId,
    sidechainId,
    payload: port.buildOutboundSessionMessagePayload(content),
    messageRole: resolveAcpSessionMessageRole(normalizedBody),
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
