import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol';

/** Stable identity shared by recovery producers and continuation qualification. */
export function buildUsageLimitIssueFingerprint(issue: SessionRuntimeIssueV1, fallbackProviderId = 'unknown-provider'): string {
  return ['usage-limit', issue.provider ?? fallbackProviderId, issue.providerTurnId ?? 'unknown-turn',
    String(issue.occurredAt), String(issue.usageLimit?.resetAtMs ?? 'no-reset')].join(':');
}
