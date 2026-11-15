import type { AgentSessionRuntimeEvent, SessionRuntimeIssueV1 } from '@happier-dev/protocol';
import { readSessionRuntimeIssueNativeAuthAgentId } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import type { ACPProvider } from '@/api/session/sessionMessageTypes';
import { classifyPrimarySessionRuntimeIssue } from '../errors/classifyPrimarySessionRuntimeIssue';
import { isForegroundTurnRuntimeTranscriptEvent } from '../events/runtimeTranscriptScope';
import { commitRequiredRuntimeTranscriptMessage, commitRuntimeTurnFailureMarker,
  type RuntimeTranscriptProjectionSession, type RuntimeTranscriptProjectionResult } from './projectRuntimeTranscriptEvent';

type FailureMarkerReceipt = NonNullable<Extract<RuntimeTranscriptProjectionResult, { projected: true }>['terminalSourceMessage']>;

type RuntimeFailureEvent = Extract<AgentSessionRuntimeEvent, { kind: 'turn-failed' | 'input-rejected' }>;
type RuntimeFailureProjectionSubject = Extract<AgentSessionRuntimeEvent, {
  kind: 'transcript-message-committed' | 'turn-failed' | 'input-rejected';
}>;
type RuntimeFailureProjectionEvent = RuntimeFailureProjectionSubject | Readonly<{
  sessionId: string;
  kind: Exclude<AgentSessionRuntimeEvent['kind'], RuntimeFailureProjectionSubject['kind']>;
}>;

function runtimeIssueFromFailureEvent(event: RuntimeFailureEvent, provider: ACPProvider): SessionRuntimeIssueV1 {
  return classifyPrimarySessionRuntimeIssue({
    cause: 'session_error', error: event.diagnostic, occurredAt: event.emittedAtMs, provider,
    ...('agentTurnId' in event && event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}),
  });
}

function formatRuntimeIssueTranscriptMessage(issue: SessionRuntimeIssueV1, providerName: string, kind: RuntimeFailureEvent['kind']): string {
  // The Agent's display name ("Muse"), never its id ("muse"); the id only stands in when no name exists.
  const providerLabel = providerName.trim() || issue.agentId?.trim() || 'Agent';
  const detail = issue.sanitizedPreview?.trim() || issue.code.trim() || issue.source;
  if (issue.source === 'permission_blocked' || issue.source === 'team_credential'
    || readSessionRuntimeIssueNativeAuthAgentId(issue)) return detail;
  return `${providerLabel} ${kind === 'input-rejected' ? 'input rejected' : 'turn failed'}: ${detail}`;
}

/** The host's single failure-history writer, including rejections that never start a turn. */
export function createRuntimeFailureTranscriptProjector(params: Readonly<{
  session: RuntimeTranscriptProjectionSession;
  provider: ACPProvider;
  providerName: string;
}>): (event: RuntimeFailureProjectionEvent, projection?: Readonly<{
  terminalSourceMessage?: FailureMarkerReceipt;
  issue: SessionRuntimeIssueV1;
}>) => Promise<FailureMarkerReceipt | null> | null {
  const projectedDiagnostics = new Set<string>();
  const projectedLifecycleMarkers = new Map<string, FailureMarkerReceipt>();
  let lastAssistantMessage: Readonly<{ turnId: string; text: string }> | null = null;

  return (event, projection) => {
    if (event.sessionId !== params.session.sessionId) return null;
    if (event.kind === 'transcript-message-committed' && event.role === 'assistant' && isForegroundTurnRuntimeTranscriptEvent(event)) {
      lastAssistantMessage = { turnId: event.turnId, text: event.text.trim() };
      return null;
    }
    if (event.kind === 'turn-start' || event.kind === 'turn-complete' || event.kind === 'turn-cancelled') {
      lastAssistantMessage = null;
      return null;
    }
    if (event.kind !== 'turn-failed' && event.kind !== 'input-rejected') return null;
    const causeAlreadyVisible = !projection?.issue.teamCredential
      && event.kind === 'turn-failed' && lastAssistantMessage?.turnId === event.turnId
      && Boolean(event.diagnostic.message?.trim()) && lastAssistantMessage.text === event.diagnostic.message?.trim();
    if (event.kind === 'turn-failed') lastAssistantMessage = null;
    const issue = projection?.issue ?? runtimeIssueFromFailureEvent(event, params.provider);
    const details = event.diagnostic.details;
    const requestErrorCode = details && typeof details === 'object' && !Array.isArray(details)
      && 'requestErrorCode' in details && typeof details.requestErrorCode === 'number' && Number.isSafeInteger(details.requestErrorCode)
      ? details.requestErrorCode : null;
    const meta = {
      source: 'runtime', runtimeIssueCode: issue.teamCredential?.reasonCode ?? issue.code, runtimeIssueSource: issue.source,
      runtimeIssueV1: issue,
      ...(requestErrorCode === null ? {} : { runtimeIssueRequestErrorCode: requestErrorCode }),
      ...(issue.agentId ? { runtimeIssueProvider: issue.agentId } : {}),
      ...(issue.agentTurnId ? { runtimeIssueProviderTurnId: issue.agentTurnId } : {}),
    };
    const ids = event.kind === 'turn-failed' ? [event.turnId] : event.inputIds;
    return (async () => {
      for (const id of ids) {
        // A failed turn still needs its cause after a partial assistant reply.
        const diagnosticId = `${id}:runtime_issue`;
        if (!causeAlreadyVisible && !projectedDiagnostics.has(diagnosticId)) {
          await commitRequiredRuntimeTranscriptMessage({
            session: params.session, provider: params.provider,
            body: { type: 'message', message: formatRuntimeIssueTranscriptMessage(issue, params.providerName, event.kind) },
            localId: diagnosticId, meta,
            provenance: { kind: 'non_dependent', source: 'background' }, eventKind: event.kind,
          });
          projectedDiagnostics.add(diagnosticId);
        }
      }
      // A pre-acceptance rejection has no turn. Never invent a failed-turn marker.
      if (event.kind === 'turn-failed') {
        const previous = projectedLifecycleMarkers.get(event.turnId);
        if (previous) return previous;
        const receipt = projection?.terminalSourceMessage ?? await commitRuntimeTurnFailureMarker({
          session: params.session, provider: params.provider, event, meta,
          provenance: { kind: 'non_dependent', source: 'background' },
        });
        projectedLifecycleMarkers.set(event.turnId, receipt);
        return receipt;
      }
      return null;
    })();
  };
}
