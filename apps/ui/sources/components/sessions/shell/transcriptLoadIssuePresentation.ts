import type { SessionTranscriptLoadIssue } from '@/sync/store/domains/transcriptLoading';
import { t } from '@/text';

/** Read failures the session's Machine reports; every other read failure crossed the Home. */
const MACHINE_READ_FAILURE_CODES: ReadonlySet<string> = new Set([
  'machine_offline',
  'agent_unavailable',
  'agent_timeout',
  'agent_error',
]);

/** Where the failed transcript read went: the Machine that holds an external transcript, or the Home. */
export function resolveTranscriptLoadIssueSource(
  issue: SessionTranscriptLoadIssue,
): 'machine' | 'home' | null {
  if (issue.kind === 'source_discontinuity') return null;
  if (issue.kind === 'authority_unavailable') return 'machine';
  return MACHINE_READ_FAILURE_CODES.has(issue.errorCode) ? 'machine' : 'home';
}

export function isTranscriptLoadIssueRetryable(
  issue: SessionTranscriptLoadIssue,
): boolean {
  if (issue.kind === 'source_discontinuity') return true;
  if (issue.kind === 'read_failed')
    return issue.errorCode !== 'invalid_request';
  return issue.reason === 'machine_offline';
}

function resolveTranscriptLoadIssueReason(
  issue: SessionTranscriptLoadIssue,
): string | null {
  if (issue.kind === 'authority_unavailable') {
    return issue.reason === 'machine_offline'
      ? t('newSession.machineOfflineInlineBody')
      : t('externalSessions.sharingTranscriptUnavailable');
  }
  if (issue.kind === 'read_failed') {
    if (issue.errorCode === 'machine_offline')
      return t('newSession.machineOfflineInlineBody');
    if (issue.errorCode === 'agent_unavailable')
      return t('externalSessions.browseAgentUnavailable');
    if (issue.errorCode === 'agent_timeout')
      return t('externalSessions.browseAgentTimedOut');
    if (issue.errorCode === 'agent_error')
      return t('externalSessions.browseAgentFailed');
    if (issue.errorCode === 'network_error')
      return t('externalSessions.transcriptUnreachable');
  }
  return null;
}

/**
 * One transcript-load state, in the Files pane's anatomy: the title says where the read failed (the
 * Machine or the Home, by name), the body why. Over retained rows the title says what is on screen.
 */
export function presentTranscriptLoadIssue(
  issue: SessionTranscriptLoadIssue,
  context: Readonly<{
    retainedTranscriptVisible: boolean;
    machineName: string | null;
    homeName: string | null;
  }>,
): Readonly<{ title: string; body: string | undefined; retryable: boolean }> {
  const source = resolveTranscriptLoadIssueSource(issue);
  const place =
    source === 'machine'
      ? context.machineName
      : source === 'home'
        ? context.homeName
        : null;
  const reason = resolveTranscriptLoadIssueReason(issue);
  const title = context.retainedTranscriptVisible
    ? t('externalSessions.transcriptRetainedRefreshFailedTitle')
    : place
      ? t('externalSessions.transcriptLoadFailedFrom', { place })
      : t('externalSessions.sharingTranscriptUnavailableTitle');
  // A titled failure without a specific cause has nothing to add: repeating "could not load" is noise.
  const body =
    reason ??
    (place && !context.retainedTranscriptVisible
      ? undefined
      : t('externalSessions.transcriptLoadFailed'));
  return { title, body, retryable: isTranscriptLoadIssueRetryable(issue) };
}
