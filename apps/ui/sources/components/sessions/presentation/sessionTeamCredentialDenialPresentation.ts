import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';

import {
    credentialApprovalFailureMessage,
    formatLimitResetUtc,
    limitMetricLabel,
} from '@/components/settings/teams/credentials/teamCredentialPresentation';
import { t } from '@/text';
import { teamCredentialReconnectPresentation } from '@/components/settings/teams/credentials/sourceHealthPresentation';

export type SessionTeamCredentialDenialPresentation = Readonly<{
    kind: 'team-credential-denied';
    action: 'choose-model';
    /** The shared credential the requester selected, when the refusal named one. */
    resourceId: string | null;
    title: string;
    body?: string;
    actionLabel: string;
}>;

/**
 * What a member is told when the Home broker refuses a request made with a
 * shared Team credential.
 *
 * The classifier already turned the broker's typed 403 into
 * `source: 'team_credential'` plus the recipient-safe facts; without this arm the
 * member only ever saw the runtime's sanitized preview and could not tell *which*
 * shared credential refused, why, or when an exhausted allowance returns.
 *
 * No copy is invented here. The admission code reads in the same words the
 * credential surfaces already use (`credentialApprovalFailureMessage`), and an
 * exhausted ceiling names its measure and reset through the same two helpers the
 * model picker renders — so one refusal never acquires two vocabularies. A
 * refusal relayed by a custodian too old to name its resource still reaches the
 * member as a Team-credential refusal; only the attribution detail is missing.
 */
export function presentSessionTeamCredentialDenial(input: Readonly<{
    issue: SessionRuntimeIssueV1 | null | undefined;
    /** Display name of that credential, when this viewer's catalog carries it. */
    resolveResourceDisplayName: (resourceId: string) => string | null;
}>): SessionTeamCredentialDenialPresentation | null {
    const issue = input.issue;
    if (!issue || issue.source !== 'team_credential') return null;
    const denial = issue.teamCredential ?? null;
    const resourceId = denial?.resourceId ?? null;
    const usageLimit = denial?.usageLimit ?? null;
    const details = [
        resourceId === null ? null : input.resolveResourceDisplayName(resourceId),
        denial === null ? null : credentialApprovalFailureMessage(denial.reasonCode),
        usageLimit === null ? null : limitMetricLabel(usageLimit.metric),
        usageLimit === null ? null : formatLimitResetUtc(usageLimit.resetsAtUtc),
    ].filter((part): part is string => Boolean(part));
    return {
        kind: 'team-credential-denied',
        action: 'choose-model',
        resourceId,
        title: teamCredentialReconnectPresentation(denial?.reasonCode)?.title ?? t('teams.credentials.sessionDeniedTitle'),
        ...(details.length > 0 ? { body: details.join(' · ') } : {}),
        actionLabel: t('teams.credentials.recovery.chooseAnother'),
    };
}
