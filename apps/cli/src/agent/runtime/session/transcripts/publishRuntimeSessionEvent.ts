import { randomUUID } from 'node:crypto';

import {
  TranscriptRawAgentEventV1Schema,
  type TranscriptRawAgentEventV1,
} from '@happier-dev/protocol';
import type { AgentTranscriptSessionEventPublicationResult } from '@happier-dev/plugin-sdk/agents/runtime';

import {
  commitRequiredRuntimeTranscriptMessage,
  type RuntimeTranscriptProjectionSession,
} from './projectRuntimeTranscriptEvent';

export async function publishRuntimeSessionEvent(params: Readonly<{
  session: RuntimeTranscriptProjectionSession;
  agentId: string;
  event: TranscriptRawAgentEventV1;
}>): Promise<AgentTranscriptSessionEventPublicationResult> {
  const event = TranscriptRawAgentEventV1Schema.parse(params.event);
  const localId = randomUUID();
  await commitRequiredRuntimeTranscriptMessage({
    session: params.session,
    provider: params.agentId,
    localId,
    body: {
      id: localId,
      type: 'event',
      data: event,
    },
    provenance: { kind: 'non_dependent', source: 'external' },
    eventKind: event.type,
  });
  return Object.freeze({ status: 'custodied' });
}
