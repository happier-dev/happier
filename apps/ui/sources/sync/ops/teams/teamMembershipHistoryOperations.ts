import { TeamMembershipHistoryReadinessV1Schema, TeamMembershipHistoryPreparationResultV1Schema,
    type TeamMembershipHistoryActionIdV1, type TeamMembershipHistoryPreparationResultV1,
} from '@happier-dev/protocol/teams/membershipHistoryPreparationV1';
import type { SessionDataKeyPreparationProgress } from '@happier-dev/protocol/sessions/encryption/sessionDataKeyPreparationPass';
import { executeMembershipHistoryActionForScope, type MembershipSessionDataKeyEnvelopeRequestOptions } from '@/sync/api/teams/membershipSessionDataKeyEnvelopesApi';
import { SessionAccessApiError } from '@/sync/api/session/sessionAccessApi';
import { runTeamAction } from './teamActionClient';
import type { HomeDomainFailure } from './teamActionClient';
import { homeDomainFailureCode, homeDomainFailureFromActionFailure } from '@/sync/api/home/homeDomainActions';

function failure(outcome: HomeDomainFailure): SessionAccessApiError {
    const code = homeDomainFailureCode(outcome);
    return new SessionAccessApiError(code,
        outcome.httpStatus ?? (outcome.kind === 'forbidden' ? 403 : code === 'membership_not_found' ? 404 : undefined));
}

async function run<T>(options: MembershipSessionDataKeyEnvelopeRequestOptions, actionId: TeamMembershipHistoryActionIdV1,
    parse: (value: unknown) => T, callbacks?: Readonly<{
        onProgress?: (progress: SessionDataKeyPreparationProgress) => void;
        onApprovalSucceeded?: (value: T) => void;
        onApprovalFailed?: (error: SessionAccessApiError) => void;
    }>): Promise<T> {
    const { onApprovalFailed, ...rest } = callbacks ?? {};
    const outcome = await runTeamAction({ scope: options.scope, actionId,
        input: { teamId: options.address.teamId, target: options.target, recipientAccountId: options.recipientAccountId },
        parse, ...(options.signal ? { signal: options.signal } : {}),
        ...rest,
        ...(onApprovalFailed ? {
            onApprovalFailed: (code, cause) => onApprovalFailed(cause
                ? failure(homeDomainFailureFromActionFailure(cause, actionId))
                : new SessionAccessApiError(code)),
        } : {}),
        executorOptions: { teamMembershipHistoryAction: async args => await executeMembershipHistoryActionForScope({
            ...options, actionId: args.actionId, input: args.input,
            ...(callbacks?.onProgress ? { onProgress: callbacks.onProgress } : {}),
        }) },
    });
    if (outcome.kind === 'failed') throw failure(outcome.failure);
    return outcome.value;
}

export function getTeamMembershipHistoryReadiness(options: MembershipSessionDataKeyEnvelopeRequestOptions) {
    return run(options, 'teams.members.history.preparation.get', value => TeamMembershipHistoryReadinessV1Schema.parse(value));
}

export function prepareTeamMembershipHistory(options: MembershipSessionDataKeyEnvelopeRequestOptions & Readonly<{
    onProgress?: (progress: SessionDataKeyPreparationProgress) => void;
    onApprovalSucceeded?: (value: TeamMembershipHistoryPreparationResultV1) => void;
    onApprovalFailed?: (error: SessionAccessApiError) => void;
}>) {
    return run(options, 'teams.members.history.prepare', value => TeamMembershipHistoryPreparationResultV1Schema.parse(value), options);
}
