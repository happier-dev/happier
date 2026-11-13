import { getSessionCommittedTranscriptLocalIds } from '@/api/session/client/transcript/committedTranscriptLocalIdBaseline';
import { commitRequiredRuntimeTranscriptMessage, type RuntimeTranscriptProjectionSession } from './projectRuntimeTranscriptEvent';
import type { ACPProvider } from '@/api/session/sessionMessageTypes';

/** Retain the native identity, never the host-authored prompt it echoed. */
export async function consumeRuntimeTranscriptSourceFact(params: Readonly<{
  session: RuntimeTranscriptProjectionSession;
  provider: ACPProvider;
  localId: string;
  reason: 'host_prompt_echo';
}>): Promise<void> {
  await commitRequiredRuntimeTranscriptMessage({
    session: params.session,
    provider: params.provider,
    localId: params.localId,
    body: { type: 'output', data: { type: 'progress', marker: 'source_fact_consumed', reason: params.reason } },
    meta: { happier: { kind: 'source_fact_consumed.v1' } },
    provenance: { kind: 'non_dependent', source: 'external' },
    eventKind: 'source-fact-consumed',
  });
  getSessionCommittedTranscriptLocalIds(params.session).add(params.localId);
}
