import type { TeamCredentialUsageLimitDenialV1 } from '@happier-dev/protocol/teams';
import type { ProviderBrokerRequestHandler } from './providerBrokerRequestHandler';
import type { SessionRuntimeTeamCredentialDenialDetailsV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';

/** Host-private recorder captured before a fresh request can outlive its turn. */
export type SessionBrokerApplicationOutcomeRecorder = (denial: SessionRuntimeTeamCredentialDenialDetailsV1 | null) => void;

export type ProviderBrokerApplicationFailure = Extract<Awaited<ReturnType<ProviderBrokerRequestHandler>>, { ok: false }>;

/** Carries a host refusal through managed-service access to the one HTTP writer. */
export class ProviderBrokerApplicationFailureError extends Error {
    constructor(readonly failure: ProviderBrokerApplicationFailure) {
        super('Provider broker application refused');
        this.name = 'ProviderBrokerApplicationFailureError';
    }
}

/** Provider-compatible refusal shared by target HTTP admission and local carrier admission. */
export type ProviderBrokerApplicationFailureBodyV1 = Readonly<{
    type: 'error';
    error: Readonly<{
        type: 'permission_error';
        code: ProviderBrokerApplicationFailure['reasonCode'];
        /** Only the resource already selected by this consumer. */
        resourceId?: string;
        message: string;
        failureCause?: ProviderBrokerApplicationFailure['failureCause'];
        usageLimit?: TeamCredentialUsageLimitDenialV1;
    }>;
}>;

export function providerBrokerApplicationFailureBody(
    response: ProviderBrokerApplicationFailure,
    resourceId: string | undefined,
): ProviderBrokerApplicationFailureBodyV1 {
    const usageLimit = response.reasonCode === 'team_credential_usage_limit' ? response.usageLimit : undefined;
    const sourceReason = response.sourceOpenFailureReason;
    const cause = response.failureCause;
    const causeSummary = cause ? ` [${cause.phase}: ${cause.errorClass}${cause.errorCode ? ` (${cause.errorCode})` : ''}]` : '';
    const message = usageLimit
        ? `Happier refused this request: the shared credential's ${usageLimit.metric} limit is reached `
            + `(${usageLimit.remaining} remaining, resets ${usageLimit.resetsAtUtc}).`
        : `Happier refused this request: ${response.reasonCode}${sourceReason ? ` (${sourceReason})` : ''}${causeSummary}.`;
    return {
        type: 'error',
        error: {
            type: 'permission_error',
            code: response.reasonCode,
            ...(resourceId ? { resourceId } : {}),
            message,
            ...(cause ? { failureCause: cause } : {}),
            ...(usageLimit ? { usageLimit } : {}),
        },
    };
}
