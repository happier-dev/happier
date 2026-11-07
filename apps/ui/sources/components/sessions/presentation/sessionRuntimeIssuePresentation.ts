import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol/spawnSession';
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
import { t, type TranslationKey } from '@/text';
import { teamCredentialReconnectPresentation } from '@/components/settings/teams/credentials/sourceHealthPresentation';
import { resourceStateLabel } from '@/components/settings/teams/credentials/readinessPresentation';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import { ProviderErrorCodeV1Schema } from '@happier-dev/protocol/providers/errors';
import type { PendingActivationFailureDetailsV1 } from '@happier-dev/protocol/sessions/pending/pendingActivationAuthorizationV1';
import { presentProviderError } from '@/providers/connection/errorPresentation';

function resolveSessionConnectedServiceAuthSwitchErrorMessageKey(
    errorCode: string | undefined,
): TranslationKey {
    switch (errorCode) {
        case 'provider_state_sharing_required':
            return 'connectedServices.authSwitch.errors.providerStateSharingRequired';
        case 'group_generation_conflict':
            return 'connectedServices.authSwitch.errors.groupGenerationConflict';
        case 'not_group_selection':
            return 'connectedServices.authSwitch.errors.notGroupSelection';
        case 'connected_service_required':
            return 'connectedServices.authSwitch.errors.connectedServiceRequired';
        case 'profile_action_required':
            return 'connectedServices.authSwitch.errors.profileActionRequired';
        case 'provider_state_sharing_unavailable':
            return 'connectedServices.authSwitch.errors.providerStateSharingUnavailable';
        case 'profile_disconnected':
            return 'connectedServices.authSwitch.errors.profileDisconnected';
        case 'profile_missing':
            return 'connectedServices.authSwitch.errors.profileMissing';
        case 'group_missing':
            return 'connectedServices.authSwitch.errors.groupMissing';
        case 'metadata_update_failed':
            return 'connectedServices.authSwitch.errors.metadataUpdateFailed';
        case 'restart_failed':
            return 'connectedServices.authSwitch.errors.restartFailed';
        case 'hot_apply_failed':
            return 'connectedServices.authSwitch.errors.hotApplyFailed';
        case 'provider_account_adoption_mismatch':
        case 'post_switch_verification_failed':
            return 'connectedServices.authSwitch.switchFailed';
        case 'agent_mismatch':
            return 'connectedServices.authSwitch.errors.agentMismatch';
        case 'session_not_found':
            return 'connectedServices.authSwitch.errors.sessionNotFound';
        case 'unsupported_service':
            return 'connectedServices.authSwitch.errors.unsupportedService';
        default:
            return 'connectedServices.authSwitch.switchFailed';
    }
}

export function presentSessionAuthSwitchFailure(errorCode: string | undefined): string {
    return t(resolveSessionConnectedServiceAuthSwitchErrorMessageKey(errorCode));
}

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
    if (code === SPAWN_SESSION_ERROR_CODES.SESSION_DIRECTORY_MISSING) return t('errors.workspaceFolderMissing');
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

/** The one next step for queued input whose Session's Agent account refused it; both reuse existing recovery owners. */
export type SessionActivationFailureRecovery = 'sign_in_again' | 'choose_account';

export type SessionActivationFailurePresentation = Readonly<{
    message: string;
    detail?: string;
    recovery: SessionActivationFailureRecovery;
}>;

/**
 * The single message and next action for input blocked because its Session could not start on its
 * Agent account. The composer's status line renders it; the blocked row and the quota meter add nothing.
 * A typed refusal names its cause; an untyped one still leads to choosing an account.
 */
export function presentSessionActivationFailure(
    details: PendingActivationFailureDetailsV1 | null | undefined,
): SessionActivationFailurePresentation {
    const reason = details?.runtimeReason;
    if (reason === 'no_eligible_member') return {
        message: t('connectedServices.diagnostics.title.no_eligible_group_member'),
        detail: t('connectedServices.diagnostics.body.no_eligible_group_member'),
        recovery: 'choose_account',
    };
    if (reason === 'connected_service_credential_reconnect_required' || reason === 'connected_service_credential_refresh_unavailable') return {
        message: t(`connectedServices.diagnostics.title.${reason}`),
        detail: t(`connectedServices.diagnostics.body.${reason}`),
        recovery: reason === 'connected_service_credential_reconnect_required' ? 'sign_in_again' : 'choose_account',
    };
    return {
        message: presentSessionStartupFailureCause(reason) ?? t('session.pendingMessages.deliveryBlockedReasons.runtimeConfigBlocked'),
        recovery: 'choose_account',
    };
}

/**
 * The first readable sentence of carried failure text: a raw payload (a JSON or schema dump) is detail,
 * never the line a person reads.
 */
function readRuntimeIssueTextLine(text: string | null | undefined): string | null {
    const first = text?.split('\n').map(line => line.trim()).find(line => line.length > 0);
    const line = first?.split(/:\s*[[{]/)[0]?.replace(/:\s*$/, '').trim();
    return line && /\p{L}/u.test(line) ? line : null;
}

/** Present the typed cause, reported reset and recovery supported by the carried Connected Account context. */
export function presentSessionRuntimeIssue(issue: SessionRuntimeIssueV1 | null | undefined, context?: Readonly<{
    /** The surface's own failure text that wraps this issue (a worker's result), when it has one. */
    failureText?: string | null;
}>): Readonly<{
    message: string | null;
    /** One concise line: the localized cause, otherwise the carried text's first readable sentence. */
    summary: string | null;
    cause: string | null;
    details: string | null;
    reset: string | null;
    recovery: string | null;
}> {
    const resetAtMs = issue?.usageLimit?.resetAtMs;
    const resetDate = resetAtMs == null ? null : new Date(resetAtMs);
    const localized = presentSessionStartupFailureCause(issue?.code, issue ?? undefined);
    const message = localized ?? issue?.sanitizedPreview ?? null;
    const requestId = issue?.failureCause?.requestId;
    // A usage limit is said as the limit itself; the provider's advice stays in Details.
    const usageLimited = issue?.source === 'usage_limit' || issue?.code === 'usage_limit';
    const summary = issue ? localized ?? (usageLimited ? t('session.usageLimitRecovery.banner.title') : null)
        ?? readRuntimeIssueTextLine(issue.sanitizedPreview) ?? readRuntimeIssueTextLine(context?.failureText) : null;
    const raw = context?.failureText ?? issue?.sanitizedPreview ?? null;
    return {
        summary,
        cause: message,
        details: issue ? [raw !== summary ? raw : null, issue.code, issue.failureCause?.code, issue.failureCause?.providerErrorCode,
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
