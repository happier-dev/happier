import type {
  ACPMessageData,
  ACPProvider,
} from '../../sessionMessageTypes';
import { prepareAcpTranscriptDispatch } from '../../outbound/transcriptDispatch';
import { buildUserTextMessageContent } from '../../outbound/shared';
import { resolveAcpSessionMessageRole } from '../../messageRole';
import { getToolCallNameKey } from '../../toolCallInputHints';
import { resolveTranscriptVisualReference } from '@/session/board/resolveTranscriptVisualReference';
import type { StrictSessionStoredMessageContentEnvelope, ToolNormalizationSourceV3 } from '@happier-dev/protocol';
import type { SessionTranscriptSurfaceItemReferencesV1 } from '@happier-dev/protocol/sessions/messages/transcriptObservationV1';
import { readTranscriptSessionBoardItemApprovalV1 } from '@happier-dev/protocol/sessions/board/transcriptReference';
import { projectUsageSessionMessageTimingV1, type UsageTimingBoundsV1 } from '@happier-dev/protocol/usage/usageWorkEvidence';

import type { SessionClientTranscriptSendPort } from './sendMessages';

type PlainOrEncryptedPayload = ReturnType<SessionClientTranscriptSendPort['buildOutboundSessionMessagePayload']>;
type SessionMessageRole = 'user' | 'agent' | 'event' | 'unknown';

export async function prepareCommittedAgentMessageViaPort(
  port: SessionClientTranscriptSendPort,
  provider: ACPProvider,
  body: ACPMessageData,
  opts: Readonly<{ localId: string; meta?: Record<string, unknown>; toolNormalizationSource?: ToolNormalizationSourceV3 }>,
): Promise<Readonly<{
  normalizedBody: ACPMessageData;
  source?: ToolNormalizationSourceV3;
  localId: string;
  sidechainId: string | null;
  payload: PlainOrEncryptedPayload;
  toolOutputPart?: StrictSessionStoredMessageContentEnvelope;
  messageRole: SessionMessageRole;
  openedContent: unknown;
  surfaceItemReference?: SessionTranscriptSurfaceItemReferencesV1;
  approvalRequestArtifactId?: string;
}>> {
  // The canonical normalizer consumes the call input at terminal result reconciliation.
  const key = body.type === 'tool-result' ? getToolCallNameKey(provider, body.callId) : null;
  const acknowledgedInput = key ? port.toolCallInputByProviderAndId.get(key) : undefined;
  const mapping = key ? port.toolCallCanonicalNameByProviderAndId.get(key) : undefined;
  const { normalizedBody, content, localId, sidechainId, source } = prepareAcpTranscriptDispatch({
    provider,
    source: opts.toolNormalizationSource,
    body,
    meta: opts.meta,
    localId: opts.localId,
    toolCallCanonicalNameByProviderAndId: port.toolCallCanonicalNameByProviderAndId,
    permissionToolCallRawInputByProviderAndId: port.permissionToolCallRawInputByProviderAndId,
    toolCallInputByProviderAndId: port.toolCallInputByProviderAndId,
    maxToolCallCacheEntries: port.maxToolCallCacheEntries,
  });

  const reference = normalizedBody.type === 'tool-result' && key && mapping && normalizedBody.isError !== true
    ? await resolveTranscriptVisualReference({
      toolName: mapping.rawToolName, state: 'completed', input: acknowledgedInput,
      result: normalizedBody.output,
      address: port.serverId ? { serverId: port.serverId, sessionId: port.sessionId } : null,
    }) : null;
  const surfaceItemReference: SessionTranscriptSurfaceItemReferencesV1 | undefined = reference?.itemRevision
    && (reference.itemDestination === 'transcript' || reference.itemDestination === 'both')
    ? { v: 1, references: [{ v: 1, itemId: reference.itemId, itemRevision: reference.itemRevision,
      sourceAddress: reference.address, sourceItemId: reference.itemId, sourceItemRevision: reference.itemRevision }] }
    : undefined;
  const approval = normalizedBody.type === 'tool-result' && mapping && normalizedBody.isError !== true
    ? readTranscriptSessionBoardItemApprovalV1({ toolName: mapping.rawToolName, input: acknowledgedInput,
      result: normalizedBody.output }) : null;

  return {
    normalizedBody,
    ...(source ? { source } : {}),
    localId,
    sidechainId,
    ...(port.buildDurableOutboundSessionMessagePayload?.({
      content, sessionId: port.sessionId, localId,
      ...(mapping ? { canonicalToolName: mapping.canonicalToolName } : {}),
    }) ?? { payload: port.buildOutboundSessionMessagePayload(content) }),
    openedContent: content,
    messageRole: resolveAcpSessionMessageRole(normalizedBody),
    ...(surfaceItemReference ? { surfaceItemReference } : {}),
    ...(approval ? { approvalRequestArtifactId: approval.artifactId } : {}),
  };
}

export function prepareCommittedUserTextMessageViaPort(
  port: SessionClientTranscriptSendPort,
  text: string,
  opts: Readonly<{ localId: string; meta?: Record<string, unknown> }>,
): Readonly<{
  localId: string;
  payload: PlainOrEncryptedPayload;
  usageTimingV1: UsageTimingBoundsV1 | null;
}> {
  const content = buildUserTextMessageContent(text, opts.meta);

  return {
    localId: opts.localId,
    payload: port.buildOutboundSessionMessagePayload(content),
    usageTimingV1: projectUsageSessionMessageTimingV1({ sessionId: port.sessionId,
      message: { id: opts.localId, localId: opts.localId, content } }),
  };
}
