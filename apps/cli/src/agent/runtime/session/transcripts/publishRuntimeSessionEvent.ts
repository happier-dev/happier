import { randomUUID } from 'node:crypto';

import { TranscriptRawAgentEventV1Schema } from '@happier-dev/protocol/sessions/messages/transcriptRawRecordV1';
import type { TranscriptRawAgentEventV1 } from '@happier-dev/protocol';
import type { AgentTranscriptSessionEventPublicationResult } from '@happier-dev/plugin-sdk/agents/runtime';
import type { CommittedTranscriptAdmission } from '@/api/session/transcriptPort';

import {
  commitRequiredRuntimeTranscriptMessage,
  type RuntimeTranscriptProjectionSession,
} from './projectRuntimeTranscriptEvent';

export async function publishRuntimeSessionEvent(params: Readonly<{
  session: RuntimeTranscriptProjectionSession;
  agentId: string;
  event: TranscriptRawAgentEventV1;
}>): Promise<AgentTranscriptSessionEventPublicationResult> {
  await commitRuntimeSessionEvent({
    ...params,
    localId: randomUUID(),
  });
  return Object.freeze({ status: 'custodied' });
}

export async function commitRuntimeSessionEvent(params: Readonly<{
  session: RuntimeTranscriptProjectionSession;
  agentId: string;
  localId: string;
  event: TranscriptRawAgentEventV1;
  createdAt?: number;
  updatedAt?: number;
  meta?: Record<string, unknown>;
  admission?: CommittedTranscriptAdmission;
}>): Promise<Readonly<{ localId: string }>> {
  const event = TranscriptRawAgentEventV1Schema.parse(params.event);
  const localId = params.localId;
  if (localId.trim().length === 0) throw new Error('Runtime Session event local id must not be empty');
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
    ...(params.createdAt === undefined ? {} : { createdAt: params.createdAt }),
    ...(params.updatedAt === undefined ? {} : { updatedAt: params.updatedAt }),
    ...(params.meta === undefined ? {} : { meta: params.meta }),
    ...(params.admission === undefined ? {} : { admission: params.admission }),
  });
  return Object.freeze({ localId });
}
