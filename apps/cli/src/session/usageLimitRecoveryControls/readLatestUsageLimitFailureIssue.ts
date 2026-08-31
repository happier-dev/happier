import {
  SessionRuntimeIssueV1Schema,
  type SessionRuntimeIssueV1,
} from '@happier-dev/protocol';

import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';

export function readLatestUsageLimitFailureIssue(
  rawSession: RawSessionRecord,
): SessionRuntimeIssueV1 | null {
  if (rawSession.latestTurnStatus != null && rawSession.latestTurnStatus !== 'failed') {
    return null;
  }

  const issue = SessionRuntimeIssueV1Schema.safeParse(rawSession.lastRuntimeIssue);
  return issue.success && issue.data.source === 'usage_limit' && issue.data.usageLimit
    ? issue.data
    : null;
}
