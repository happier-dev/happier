import type {
  ACPMessageData,
  ACPProvider,
} from '../../sessionMessageTypes';
import { prepareAcpTranscriptDispatch } from '../../outbound/transcriptDispatch';
import { buildUserTextMessageContent } from '../../outbound/shared';
import { resolveAcpSessionMessageRole } from '../../messageRole';
import { getToolCallNameKey } from '../../toolCallInputHints';
import { resolveTranscriptSessionBoardItemReferenceV1 } from '@happier-dev/protocol/sessions/board';
import type { SessionTranscriptSurfaceItemReferenceV1 } from '@happier-dev/protocol/sessions/messages/transcriptObservationV1';

import type { SessionClientTranscriptSendPort } from './sendMessages';

type PlainOrEncryptedPayload = ReturnType<SessionClientTranscriptSendPort['buildOutboundSessionMessagePayload']>;
type SessionMessageRole = 'user' | 'agent' | 'event' | 'unknown';

export async function prepareCommittedAgentMessageViaPort(
  port: SessionClientTranscriptSendPort,
  provider: ACPProvider,
  body: ACPMessageData,
  opts: Readonly<{ localId: string; meta?: Record<string, unknown> }>,
): Promise<Readonly<{
  normalizedBody: ACPMessageData;
  localId: string;
  sidechainId: string | null;
  payload: PlainOrEncryptedPayload;
  messageRole: SessionMessageRole;
  surfaceItemReference?: SessionTranscriptSurfaceItemReferenceV1;
}>> {
  // The canonical normalizer consumes the call input at terminal result reconciliation.
  const key = body.type === 'tool-result' ? getToolCallNameKey(provider, body.callId) : null;
  const acknowledgedInput = key ? port.toolCallInputByProviderAndId.get(key) : undefined;
  const mapping = key ? port.toolCallCanonicalNameByProviderAndId.get(key) : undefined;
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

  const reference = normalizedBody.type === 'tool-result' && key && mapping && normalizedBody.isError !== true
    ? resolveTranscriptSessionBoardItemReferenceV1({
      toolName: mapping.rawToolName, state: 'completed', input: acknowledgedInput,
      result: normalizedBody.output,
      address: port.serverId ? { serverId: port.serverId, sessionId: port.sessionId } : null,
    }) : null;
  const surfaceItemReference: SessionTranscriptSurfaceItemReferenceV1 | undefined = reference?.itemRevision
    && (reference.itemDestination === 'transcript' || reference.itemDestination === 'both')
    ? { v: 1, itemId: reference.itemId, itemRevision: reference.itemRevision, sourceAddress: reference.address }
    : undefined;

  return {
    normalizedBody,
    localId,
    sidechainId,
    payload: port.buildOutboundSessionMessagePayload(content),
    messageRole: resolveAcpSessionMessageRole(normalizedBody),
    ...(surfaceItemReference ? { surfaceItemReference } : {}),
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
