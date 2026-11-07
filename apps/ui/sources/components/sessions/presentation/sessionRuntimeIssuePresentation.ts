import {
    readAgentStartupFailureCode,
    readSessionPreparationFailureCode,
    type SessionRuntimeIssueV1,
} from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import {
    ProviderBrokerAdmissionFailureCodeV1Schema,
    type ProviderBrokerAdmissionFailureCodeV1,
} from '@happier-dev/protocol/providers/brokerRouteGrantV1';

import { presentSessionAgentAuthRequired } from './sessionAgentAuthRequiredPresentation';
import { t } from '@/text';
import { teamCredentialReconnectPresentation } from '@/components/settings/teams/credentials/sourceHealthPresentation';
import { resourceStateLabel } from '@/components/settings/teams/credentials/readinessPresentation';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import { ProviderErrorCodeV1Schema } from '@happier-dev/protocol/providers/errors';
import { presentProviderError } from '@/providers/connection/errorPresentation';

function isTeamCredentialRefusal(code: string): code is ProviderBrokerAdmissionFailureCodeV1 {
    return ProviderBrokerAdmissionFailureCodeV1Schema.safeParse(code).success;
}

/**
 * The localized cause and recovery step for a closed startup-failure code, or null for any other code.
 * Protocol admits the code; the translation keys are named by it, so a code Protocol adds cannot be
 * presented until every locale has its copy. Broker reachability reuses the
 * credential owner's recovery; other broker refusals share the Team message.
 */
function resolveSessionStartupFailureCause(code: unknown, issue?: SessionRuntimeIssueV1): string | null {
    const nativeAuth = presentSessionAgentAuthRequired(issue);
    if (nativeAuth) return nativeAuth.message;
    if (code === 'codex_refresh_free_auth_unsupported') {
        if (issue?.failureCause?.reason === 'refresh_bridge_unavailable') {
            return t('session.startFailure.cause.codex_refresh_bridge_unavailable');
        }
        if (issue?.failureCause?.reason === 'experimental_api_unavailable') {
            return t('session.startFailure.cause.codex_experimental_api_unavailable');
        }
    }
    const reconnect = teamCredentialReconnectPresentation(code);
    if (reconnect) return reconnect.message;
    if (code === 'update_required') return resourceStateLabel('update_required');
    if (code === 'no_eligible_member') return t('connectedServices.diagnostics.body.no_eligible_group_member');
    if (code === 'machine_target_not_current') return t('session.startFailure.cause.admission_unavailable');
    if (code === 'broker_unavailable') return [
        t('teams.credentials.errors.brokerUnavailable'),
        t('teams.credentials.recovery.ownerHandoff'),
    ].join(' ');
    if (code === 'team_credential_provider_binding_unavailable') return t('session.startFailure.cause.teamCredential');
    const provider = ProviderErrorCodeV1Schema.safeParse(code);
    if (provider.success) return t(presentProviderError(provider.data).descriptionKey);
    const startup = readAgentStartupFailureCode(code);
    if (startup) return t(`session.startFailure.cause.${startup}`);
    const preparation = readSessionPreparationFailureCode(code);
    if (!preparation) return null;
    if (preparation === 'agent_isolation_unavailable' || preparation === 'filesystem_identity_custody_unavailable') {
        return t('errors.agentIsolationUnavailable');
    }
    return isTeamCredentialRefusal(preparation)
        ? t('session.startFailure.cause.teamCredential')
        : t(`session.startFailure.cause.${preparation}`);
}

export function presentSessionStartupFailureCause(code: unknown, issue?: SessionRuntimeIssueV1): string | null {
    const message = resolveSessionStartupFailureCause(code, issue);
    const preparationCause = issue?.source === 'dependency_failure' ? issue.failureCause?.preparationCause : undefined;
    const preparationMessage = message ?? issue?.sanitizedPreview;
    const presented = preparationCause && preparationMessage
        ? t('errors.errorWithCode', { message: preparationMessage, code: preparationCause.code })
        : message;
    return presented && preparationCause?.requestId
        ? `${presented}\n${t('session.startFailure.requestId', { id: preparationCause.requestId })}` : presented;
}

/** Present the typed cause, reported reset and recovery supported by the carried Connected Account context. */
export function presentSessionRuntimeIssue(issue: SessionRuntimeIssueV1 | null | undefined): Readonly<{
    message: string | null;
    cause: string | null;
    details: string | null;
    reset: string | null;
    recovery: string | null;
}> {
    const resetAtMs = issue?.usageLimit?.resetAtMs;
    const resetDate = resetAtMs == null ? null : new Date(resetAtMs);
    const message = presentSessionStartupFailureCause(issue?.code, issue ?? undefined) ?? issue?.sanitizedPreview ?? null;
    const requestId = issue?.failureCause?.requestId;
    return {
        cause: message,
        details: issue ? [issue.code, issue.failureCause?.code, issue.failureCause?.providerErrorCode,
            requestId ? t('session.startFailure.requestId', { id: requestId }) : null].filter(value => value != null).join('\n') : null,
        message: message && requestId ? `${message}\n${t('session.startFailure.requestId', { id: requestId })}` : message,
        recovery: issue?.usageLimit?.connectedService ? t('session.usageLimitRecovery.actions.switchAccountNow') : null,
        reset: resetDate !== null && Number.isFinite(resetDate.getTime())
            ? t('usage.board.plans.capacityResets', { time: formatWithCachedDateTimeFormatter(resetDate, undefined, {
                dateStyle: 'medium', timeStyle: 'short',
            }) })
            : null,
    };
}
