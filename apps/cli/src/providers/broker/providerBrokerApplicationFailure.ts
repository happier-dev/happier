import type { TeamCredentialUsageLimitDenialV1 } from '@happier-dev/protocol/teams';
import type { ProviderBrokerRequestHandler } from './providerBrokerRequestHandler';
import type { SessionRuntimeTeamCredentialDenialDetailsV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { TeamCredentialBrokerApplicationFailureCodeV1Schema } from '@happier-dev/protocol/teams/credentials/externalProviderApiV1';
import { TeamCredentialUsageLimitDenialV1Schema } from '@happier-dev/protocol/teams/credentials/usageV1';
import {
    PROVIDER_BROKER_APPLICATION_ERROR_CODE_HEADER,
    PROVIDER_BROKER_APPLICATION_LIMIT_METRIC_HEADER,
    PROVIDER_BROKER_APPLICATION_LIMIT_REMAINING_HEADER,
    PROVIDER_BROKER_APPLICATION_LIMIT_RESETS_AT_HEADER,
} from '@happier-dev/protocol/providers/brokerRouteGrantV1';

/** Host-private recorder captured before a fresh request can outlive its turn. */
export type SessionBrokerApplicationOutcomeRecorder = (denial: SessionRuntimeTeamCredentialDenialDetailsV1 | null) => void;

export type ProviderBrokerApplicationFailure = Extract<Awaited<ReturnType<ProviderBrokerRequestHandler>>, { ok: false }>;

/** Headers reserved for the broker's typed application-failure writer. */
export const PROVIDER_BROKER_APPLICATION_CONTROL_HEADERS = [
    PROVIDER_BROKER_APPLICATION_ERROR_CODE_HEADER,
    PROVIDER_BROKER_APPLICATION_LIMIT_METRIC_HEADER,
    PROVIDER_BROKER_APPLICATION_LIMIT_REMAINING_HEADER,
    PROVIDER_BROKER_APPLICATION_LIMIT_RESETS_AT_HEADER,
] as const;
const providerBrokerApplicationControlHeaders = new Set<string>(PROVIDER_BROKER_APPLICATION_CONTROL_HEADERS);

export function isProviderBrokerApplicationControlHeader(name: string): boolean {
    return providerBrokerApplicationControlHeaders.has(name.toLowerCase());
}

/** Shared by target HTTP admission and the local fresh-authority refusal. */
export function providerBrokerApplicationFailureHeaders(response: ProviderBrokerApplicationFailure): Readonly<Record<string, string>> {
    return {
        [PROVIDER_BROKER_APPLICATION_ERROR_CODE_HEADER]: response.reasonCode,
        ...(response.reasonCode === 'team_credential_usage_limit' && response.usageLimit ? {
            [PROVIDER_BROKER_APPLICATION_LIMIT_METRIC_HEADER]: response.usageLimit.metric,
            [PROVIDER_BROKER_APPLICATION_LIMIT_REMAINING_HEADER]: response.usageLimit.remaining,
            [PROVIDER_BROKER_APPLICATION_LIMIT_RESETS_AT_HEADER]: response.usageLimit.resetsAtUtc,
        } : {}),
    };
}

/** Decode only known broker output. Provider-originated headers have no authority. */
export function readTrustedProviderBrokerApplicationFailure(
    status: number,
    headers: Readonly<Record<string, string | undefined>>,
): ProviderBrokerApplicationFailure | null {
    if (status < 400) return null;
    const reason = TeamCredentialBrokerApplicationFailureCodeV1Schema.safeParse(headers[PROVIDER_BROKER_APPLICATION_ERROR_CODE_HEADER]);
    if (!reason.success) return null;
    const usageLimit = reason.data === 'team_credential_usage_limit' ? TeamCredentialUsageLimitDenialV1Schema.safeParse({
        metric: headers[PROVIDER_BROKER_APPLICATION_LIMIT_METRIC_HEADER],
        remaining: headers[PROVIDER_BROKER_APPLICATION_LIMIT_REMAINING_HEADER],
        resetsAtUtc: headers[PROVIDER_BROKER_APPLICATION_LIMIT_RESETS_AT_HEADER],
    }) : null;
    return { ok: false, reasonCode: reason.data, ...(usageLimit?.success ? { usageLimit: usageLimit.data } : {}) };
}

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
        type: 'permission_error' | 'invalid_request_error';
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
            type: response.reasonCode === 'request_too_large' ? 'invalid_request_error' : 'permission_error',
            code: response.reasonCode,
            ...(resourceId ? { resourceId } : {}),
            message,
            ...(cause ? { failureCause: cause } : {}),
            ...(usageLimit ? { usageLimit } : {}),
        },
    };
}
