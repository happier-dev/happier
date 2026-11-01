import type { AgentSessionRuntimeEvent } from '@happier-dev/protocol/runtime';
import { buildAgentEventLocalId } from '@happier-dev/protocol/sessions/messages/transcriptRawRecordV1';
import { redactBugReportSensitiveText } from '@happier-dev/protocol/bugs/reports/redaction';
import type { CommittedTranscriptAdmission } from '@/api/session/transcriptPort';
import type { RuntimeTranscriptProjectionResult, RuntimeTranscriptProjectionSession } from './projectRuntimeTranscriptEvent';
import { commitRuntimeSessionEvent } from './publishRuntimeSessionEvent';

export async function projectRuntimeCompactionEvent(params: Readonly<{
  session: RuntimeTranscriptProjectionSession;
  provider?: string;
  admission?: CommittedTranscriptAdmission;
  event: Extract<AgentSessionRuntimeEvent, { kind: 'context-compaction' }>;
}>): Promise<RuntimeTranscriptProjectionResult> {
  const { event } = params;
  if (!params.provider || event.phase === 'outcomeUnknown') return { projected: false, reason: 'unsupported_event' };
  const trigger = event.trigger === 'automatic' ? 'auto' : event.trigger;
  const localId = buildAgentEventLocalId('context-compaction', [trigger, `compaction-${event.compactionId}`, event.phase, event.sequence]);
  const diagnostic = 'diagnostic' in event ? event.diagnostic : undefined;
  await commitRuntimeSessionEvent({
    session: params.session,
    agentId: params.provider,
    localId,
    event: {
      type: 'context-compaction', phase: event.phase, trigger, lifecycleId: event.compactionId,
      agentId: params.provider, agentSessionId: event.sessionId, source: 'runtime',
      ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
      ...(event.retryAttempt === undefined ? {} : { retryAttempt: event.retryAttempt }),
      ...(event.phase === 'started' || event.phase === 'completed' ? {
        ...(event.tokenCountBefore === undefined ? {} : { tokenCountBefore: event.tokenCountBefore }),
        ...(event.tokenCountSource === undefined ? {} : { tokenCountSource: event.tokenCountSource }),
      } : {}),
      ...(event.phase === 'completed' ? {
        ...(event.tokenCountAfter === undefined ? {} : { tokenCountAfter: event.tokenCountAfter }),
        ...(event.continuation === undefined ? {} : { continuation: event.continuation }),
        ...(event.pauseReason === undefined ? {} : { pauseReason: 'agent-idle-after-compaction' as const }),
      } : {}),
      ...(diagnostic === undefined ? {} : { errorCode: diagnostic.code,
        ...(diagnostic.message === undefined ? {} : { sanitizedErrorPreview: redactBugReportSensitiveText(diagnostic.message) }) }),
    },
    createdAt: event.emittedAtMs,
    updatedAt: event.emittedAtMs,
    meta: { source: 'runtime', runtimeEventKind: event.kind,
      ...(event.turnId === undefined ? {} : { runtimeTurnId: event.turnId }) },
    ...(params.admission === undefined ? {} : { admission: params.admission }),
  });
  return { projected: true, kind: event.kind };
}
