import type {
  ConversationAuthenticatedObservationShellV1,
  ConversationNormalizedIngressV1,
} from '@happier-dev/channels-protocol/v1';
import { ConversationNormalizedIngressV1Schema } from '@happier-dev/channels-protocol/v1';

import type { DiscordMessageParseResult } from './discordMessage.js';

type DiscordIngressMessage = Extract<DiscordMessageParseResult, {
  kind: 'message' | 'routableNonAdmission';
}>['message'];

function toConversationIngressMessage(
  message: DiscordIngressMessage,
): ConversationAuthenticatedObservationShellV1['message'] | null {
  if (message.addressingEvidence === 'replyToIntegration') {
    if (message.replyToMessageId === undefined) return null;
    return {
      id: message.id,
      ...(message.revision === undefined ? {} : { revision: message.revision }),
      replyToMessageId: message.replyToMessageId,
      addressingEvidence: 'replyToIntegration',
      contentProvenance: message.contentProvenance,
      providerTimestamp: message.providerTimestamp,
    };
  }
  return {
    id: message.id,
    ...(message.revision === undefined ? {} : { revision: message.revision }),
    ...(message.replyToMessageId === undefined ? {} : { replyToMessageId: message.replyToMessageId }),
    addressingEvidence: message.addressingEvidence,
    contentProvenance: message.contentProvenance,
    providerTimestamp: message.providerTimestamp,
  };
}

/**
 * Projects authenticated Discord Gateway evidence into the strict core ingress
 * union. The provider-owned Gateway Dispatch sequence intentionally stays out
 * of this value: socket receive progress is not a Channels checkpoint.
 */
export function mapDiscordMessageToSocketIngress(input: Readonly<{
  parsed: DiscordMessageParseResult;
}>): ConversationNormalizedIngressV1 | null {
  if (input.parsed.kind === 'notIngress') return null;

  const evidence = input.parsed;
  const message = toConversationIngressMessage(evidence.message);
  if (message === null) return null;
  const shell: ConversationAuthenticatedObservationShellV1 = {
    v: 1,
    occurrenceId: evidence.occurrenceId,
    occurredAt: evidence.message.providerTimestamp,
    transport: { kind: 'socket' },
    endpoint: { ...evidence.endpoint },
    actor: { ...evidence.actor },
    message,
  };
  if (evidence.kind === 'routableNonAdmission') {
    if (evidence.reason === 'unsupportedEdit') {
      if (evidence.message.revision === undefined) return null;
      return ConversationNormalizedIngressV1Schema.parse({
        kind: 'routableNonAdmission',
        shell: {
          ...shell,
          message: { ...shell.message, revision: evidence.message.revision },
        },
        reason: 'unsupportedEdit',
      });
    }
    return ConversationNormalizedIngressV1Schema.parse({
      kind: 'routableNonAdmission',
      shell,
      reason: evidence.reason,
    });
  }
  return ConversationNormalizedIngressV1Schema.parse({
    kind: 'fullText',
    observation: {
      ...shell,
      message: { ...shell.message, text: evidence.message.text },
    },
  });
}
