import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol/spawnSession';
import {
    readAgentStartupFailureCode,
    readRequesterSessionRuntimeRefusalCode,
    readSessionPreparationFailureCode,
    isAgentIsolationLaunchMaterialFailureCode,
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
import { formatMoment } from '@/utils/datetime/formatMoment';
import { ProviderErrorCodeV1Schema } from '@happier-dev/protocol/providers/errors';
import type { PendingActivationFailureDetailsV1 } from '@happier-dev/protocol/sessions/pending/pendingActivationAuthorizationV1';
import { presentProviderError } from '@/providers/connection/errorPresentation';
import { describeAgentReadinessCause } from '@/components/sessions/model/sessionReadinessPresentation';
import { readSessionModelTransitionFailureStatus } from '@happier-dev/protocol/sessions/control/modelTransitionV1';
import { ExecutionRunErrorSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { readHappierActionToolPayload } from '@happier-dev/protocol/actions/happierActionToolResult';
import type { SessionProviderBindingMetadataV1 } from '@happier-dev/protocol/providers/sessions/bindingMetadataV1';
import { presentProviderConnectionIdentity } from '@/providers/connection/presentation';
import type { ProviderConnectionReviewRecovery } from '@/providers/connection/recovery';

/** Closed spawn refusals retain the same availability vocabulary as the Machine inventory. */
export function readSessionAgentAvailabilityFailure(code: unknown): 'needsSignIn' | 'notInstalled' | null {
    if (code === SPAWN_SESSION_ERROR_CODES.AGENT_SIGNED_OUT) return 'needsSignIn';
    if (code === SPAWN_SESSION_ERROR_CODES.AGENT_CLI_MISSING) return 'notInstalled';
    return null;
}

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
    const messageKey = resolveSessionConnectedServiceAuthSwitchErrorMessageKey(errorCode);
    const message = messageKey === 'connectedServices.authSwitch.switchFailed'
        ? `${t(messageKey)}\n\n${t('connectedServices.diagnostics.body.default')}`
        : t(messageKey);
    return errorCode ? t('errors.errorWithCode', { message, code: errorCode }) : message;
}

function isTeamCredentialRefusal(code: string): code is ProviderBrokerAdmissionFailureCodeV1 {
    return ProviderBrokerAdmissionFailureCodeV1Schema.safeParse(code).success;
}

/** Manual startup repair shared by Run failures, Session creation, and Session wake/open. */
export function presentSessionStartupFailureRecovery(codes: readonly unknown[]): Readonly<{
    cause: string;
    repairGuidance: string;
    message: string;
    recovery: 'machine_runtime_reload';
}> | null {
    if (!codes.includes('SOURCE_RUNTIME_RELOAD_REQUIRED')) return null;
    const cause = t('session.startFailure.cause.SOURCE_RUNTIME_RELOAD_REQUIRED');
    const repairGuidance = t('workflows.recovery.reloadSourceRuntime');
    return { cause, repairGuidance, message: `${cause}\n\n${repairGuidance}`, recovery: 'machine_runtime_reload' as const };
}

/**
 * The localized cause and recovery step for a closed startup-failure code, or null for any other code.
 * Protocol admits the code; the translation keys are named by it, so a code Protocol adds cannot be
 * presented until every locale has its copy. Broker reachability reuses the
 * credential owner's recovery; other broker refusals share the Team message.
 */
function resolveSessionStartupFailureCause(
    code: unknown,
    issue?: SessionRuntimeIssueV1,
    failureCause = issue?.failureCause,
): string | null {
    if (code === 'plugin_account_census_failed') {
        return `${t('settingsProviders.status.sourceUnavailable')}. ${t('errors.tryAgain')}.`;
    }
    if (code === 'database_transaction_timeout') return t('session.startFailure.cause.database_transaction_timeout');
    if (code === 'agent_startup_model_reconciliation_failed'
        && failureCause?.failureReason === 'model_selection_required') return t('session.startFailure.modelSelectionRequired');
    const nativeAuth = presentSessionAgentAuthRequired(issue);
    if (nativeAuth) return nativeAuth.message;
    const agentAvailability = readSessionAgentAvailabilityFailure(code);
    if (agentAvailability) return describeAgentReadinessCause({
        title: t('newSession.wizardSection.agent'), state: agentAvailability,
    });
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
    if (code === 'machine_target_not_current') return t('session.startFailure.cause.admission_unavailable');
    const startupRecovery = presentSessionStartupFailureRecovery([code]);
    if (startupRecovery) return startupRecovery.cause;
    if (code === SPAWN_SESSION_ERROR_CODES.SESSION_DIRECTORY_MISSING) return t('errors.workspaceFolderMissing');
    if (code === 'broker_unavailable') return [
        t('teams.credentials.errors.brokerUnavailable'),
        t('teams.credentials.recovery.ownerHandoff'),
    ].join(' ');
    if (code === 'team_credential_provider_binding_unavailable') return t('session.startFailure.cause.teamCredential');
    const provider = ProviderErrorCodeV1Schema.safeParse(code);
    if (provider.success) {
        // The cause first (its title), then what to do: a one-line reader shows the cause.
        const presented = presentProviderError(provider.data);
        return `${t(presented.titleKey)}\n${t(presented.descriptionKey)}`;
    }
    const startup = readAgentStartupFailureCode(code);
    if (startup) return t(`session.startFailure.cause.${startup}`);
    const requester = readRequesterSessionRuntimeRefusalCode(code);
    if (requester) return t(`session.startFailure.cause.${requester}`);
    const preparation = readSessionPreparationFailureCode(code);
    // Native vendor codes retain their producer's typed cause without implying Agent sign-in.
    if (!preparation) return failureCause?.failureReason === 'authentication_required'
        ? t('errors.authenticationFailed') : null;
    if (preparation === 'no_eligible_member' || preparation === 'no_eligible_group_member') {
        return t('connectedServices.diagnostics.body.no_eligible_group_member');
    }
    if (preparation === 'agent_isolation_unavailable' || preparation === 'filesystem_identity_custody_unavailable'
        || isAgentIsolationLaunchMaterialFailureCode(preparation)) {
        return t('errors.agentIsolationUnavailable');
    }
    return isTeamCredentialRefusal(preparation)
        ? t('session.startFailure.cause.teamCredential')
        : t(`session.startFailure.cause.${preparation}`);
}

export function presentSessionStartupFailureCause(
    code: unknown,
    issue?: SessionRuntimeIssueV1,
    failureCause = issue?.failureCause,
): string | null {
    const message = resolveSessionStartupFailureCause(code, issue, failureCause);
    const preparationCause = issue?.source === 'dependency_failure' ? issue.failureCause?.preparationCause : undefined;
    const preparationMessage = message ?? issue?.sanitizedPreview;
    const presented = preparationCause && preparationMessage
        ? t('errors.errorWithCode', { message: preparationMessage, code: preparationCause.code })
        : message;
    return presented && preparationCause?.requestId
        ? `${presented}\n${t('session.startFailure.requestId', { id: preparationCause.requestId })}` : presented;
}

/**
 * A failed Run's one sentence: its typed runtime issue when it carries one, else the cause its typed
 * error code names, else a plain "stopped with an error" with that code. A failed Run never shows nothing.
 */
export function presentExecutionRunFailure(error: Readonly<{ code: string; runtimeIssueV1?: SessionRuntimeIssueV1 }> | null | undefined): Readonly<{
    message: string;
    reset: string | null;
    recovery: string | null;
}> | null {
    if (!error) return null;
    if (error.runtimeIssueV1) {
        const issue = presentSessionRuntimeIssue(error.runtimeIssueV1);
        if (issue.message) return { message: issue.message, reset: issue.reset, recovery: issue.recovery };
    }
    return {
        message: presentSessionStartupFailureRecovery([error.code])?.message ?? presentSessionStartupFailureCause(error.code)
            ?? t('errors.errorWithCode', { message: t('runs.runDetails.failedWithoutCause'), code: error.code }),
        reset: null,
        recovery: null,
    };
}

/**
 * A failed Run's one line where it is listed (a run row, a failed task card): its runtime issue's summary when it
 * carries one, else the first line of its typed cause; with the limit's reset when it names one.
 */
type ExecutionRunFailureSummary = Readonly<{ summary: string; reset: string | null }>;
type ExecutionRunFailureInput = Readonly<{ code: string; runtimeIssueV1?: SessionRuntimeIssueV1 }>;
export function presentExecutionRunFailureSummary(error: ExecutionRunFailureInput): ExecutionRunFailureSummary;
export function presentExecutionRunFailureSummary(error: ExecutionRunFailureInput | null | undefined): ExecutionRunFailureSummary | null;
export function presentExecutionRunFailureSummary(error: ExecutionRunFailureInput | null | undefined): ExecutionRunFailureSummary | null {
    if (!error) return null;
    if (error.runtimeIssueV1) {
        const issue = presentSessionRuntimeIssue(error.runtimeIssueV1);
        if (issue.summary) return { summary: issue.summary, reset: issue.reset };
    }
    const presented = presentExecutionRunFailure(error);
    return presented ? { summary: presented.message.split('\n')[0]!, reset: presented.reset } : null;
}

/**
 * The sentence for a failed Run's own result (a SubAgentRun marker that settled `failed` with a typed
 * error): the same words as the Run's failure, never the executor's raw text, which can carry SDK
 * output and local paths. Null when the result is not a typed failure.
 */
export function presentExecutionRunResultFailure(result: unknown): string | null {
    const payload = readHappierActionToolPayload(result);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const record = payload as Record<string, unknown>;
    if (record.status !== 'failed') return null;
    const error = ExecutionRunErrorSchema.safeParse(record.error);
    if (!error.success) return null;
    const presented = presentExecutionRunFailure(error.data);
    return presented ? [presented.message, presented.reset].filter(Boolean).join(' · ') : null;
}

/** The one next step for queued input whose Session's Agent account refused it; both reuse existing recovery owners. */
export type SessionActivationFailureRecovery = 'sign_in_again' | 'choose_account' | 'new_session';

export type SessionActivationFailurePresentation = Readonly<{
    message: string;
    detail?: string;
    recovery: SessionActivationFailureRecovery | null;
}>;

/**
 * The Agent can no longer reopen this Session's native conversation; retrying it cannot recover.
 * The one typed decision read by blocked queued input and by a failed explicit Resume.
 */
export function isSessionNativeConversationUnreachable(code: unknown): boolean {
    return code === 'codex_continuation_unreachable';
}

/** Native continuation has settled before acceptance; retrying the same conversation cannot recover it. */
export function presentSessionContinuationFailure(
    issue: SessionRuntimeIssueV1 | null | undefined,
): SessionActivationFailurePresentation | null {
    return isSessionNativeConversationUnreachable(issue?.code)
        ? { message: t('workflows.problem.conversationUnavailable'), recovery: 'new_session' }
        : null;
}

/**
 * The single message and next action for input blocked because its Session could not start.
 * The composer's status line renders it; the blocked row and the quota meter add nothing.
 * Account recovery requires a credential or pool refusal; other failures retain their cause.
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
        recovery: null,
    };
}

const SENTENCE_END = /[.!?。！？]$/u;

/**
 * The one failure line every transcript failure row draws: what failed, then its cause or next step, joined by
 * " · " on a single line, and ending as a sentence. A cause owner's two-line pair ("Title\nNext step.") reads as
 * "Title · Next step."; every part after " · " starts as a sentence does ("· Resets Wed 01:31 AM"), and a line whose last part is
 * a label or a fact takes the locale's end. `quoted` is the Agent's own words, kept as written for Find and copy.
 */
export function formatSessionFailureLine(parts: readonly (string | null | undefined)[], quoted?: string | null): string | null {
    const segments = parts.flatMap(part => part?.split('\n') ?? []).map(part => part.trim()).filter(Boolean)
        .map((part, index) => index === 0 ? part : `${part.charAt(0).toLocaleUpperCase()}${part.slice(1)}`);
    const words = quoted?.trim();
    if (words) segments.push(words);
    if (segments.length === 0) return null;
    const line = segments.join(' · ');
    return SENTENCE_END.test(line) ? line : `${line}${t('errors.sentenceEnd')}`;
}

/** Whether a runtime issue is a usage limit: the one rule the failure line and a failed task's route choice share. */
export function isUsageLimitedRuntimeIssue(issue: Readonly<{ code?: string | null; source?: string | null }> | null | undefined): boolean {
    return issue?.source === 'usage_limit' || issue?.code === 'usage_limit';
}

/** Present the typed cause, reported reset and recovery supported by the carried Connected Account context. */
export function presentSessionRuntimeIssue(issue: SessionRuntimeIssueV1 | null | undefined, context?: Readonly<{
    /** The surface's own failure text that wraps this issue (a worker's result), when it has one. */
    failureText?: string | null;
    /** The runtime-applied owner binding, never a pending selection or catalog guess. */
    appliedProviderBinding?: Pick<SessionProviderBindingMetadataV1, 'connectionId' | 'displaySnapshot'> | null;
}>): Readonly<{
    message: string | null;
    /**
     * One plain line: the localized cause, otherwise that the Agent stopped with an error. The Agent's own
     * text (SDK output, local paths, payload dumps) is never this line; it stays in `details`.
     */
    summary: string | null;
    /** True when no known cause explains the failure, so `summary` is only the plain fallback line. */
    unexplained: boolean;
    cause: string | null;
    details: string | null;
    reset: string | null;
    recovery: string | null;
    providerFailure?: Readonly<{ sourceLabel: string; recovery: ProviderConnectionReviewRecovery }>;
}> {
    const resetAtMs = issue?.usageLimit?.resetAtMs;
    const resetDate = resetAtMs == null ? null : new Date(resetAtMs);
    // A refused model change happens in a running Session, so it is never a start failure: its title, then the
    // cause with its next step. The Agent's own words stay in Details.
    const modelTransition = readSessionModelTransitionFailureStatus(issue?.code);
    const transitionTitle = modelTransition ? t('session.modelTransitionFailure.title') : null;
    const localized = modelTransition ? t(`session.modelTransitionFailure.cause.${modelTransition}`)
        : presentSessionContinuationFailure(issue)?.message ?? presentSessionStartupFailureCause(issue?.code, issue ?? undefined);
    const message = transitionTitle ? formatSessionFailureLine([transitionTitle, localized])
        : presentSessionStartupFailureRecovery([issue?.code])?.message ?? localized ?? issue?.sanitizedPreview ?? null;
    const requestId = issue?.failureCause?.requestId;
    const carrierFailure = issue?.failureCause?.carrierFailure;
    // A usage limit is said as the limit itself; the provider's advice stays in Details.
    const usageLimited = isUsageLimitedRuntimeIssue(issue);
    const summary = issue ? transitionTitle ?? localized ?? (usageLimited ? t('session.usageLimitRecovery.banner.title') : null)
        ?? t('errors.agentStoppedWithError') : null;
    const raw = context?.failureText ?? issue?.sanitizedPreview ?? null;
    const binding = context?.appliedProviderBinding;
    const providerFailure = binding && issue?.failureCause?.failureReason === 'authentication_required'
        && !presentSessionAgentAuthRequired(issue)
        ? {
            sourceLabel: presentProviderConnectionIdentity({ providerName: binding.displaySnapshot.providerName,
                displayName: binding.displaySnapshot.connectionName, role: binding.displaySnapshot.connectionRole,
                displayNameMode: binding.displaySnapshot.connectionDisplayNameMode }).sourceLabel,
            recovery: { action: 'review_connection', connectionId: binding.connectionId } satisfies ProviderConnectionReviewRecovery,
        } : null;
    return {
        ...(providerFailure ? { providerFailure } : {}),
        summary,
        unexplained: summary === t('errors.agentStoppedWithError'),
        cause: message,
        details: issue ? [raw !== summary ? raw : null, issue.code, issue.failureCause?.code, issue.failureCause?.providerErrorCode,
            carrierFailure ? `${carrierFailure.closingSide}: ${carrierFailure.closingStage}` : null,
            requestId ? t('session.startFailure.requestId', { id: requestId }) : null].filter(value => value != null).join('\n') : null,
        message: message && requestId ? `${message}\n${t('session.startFailure.requestId', { id: requestId })}` : message,
        recovery: issue?.usageLimit?.connectedService ? t('session.usageLimitRecovery.actions.switchAccountNow') : null,
        reset: resetDate !== null && Number.isFinite(resetDate.getTime())
            // Said the way the usage page says a reset: a time today, a weekday this week, else a date.
            ? t('usage.board.plans.capacityResets', { time: formatMoment(resetDate.getTime(), Date.now()) })
            : null,
    };
}
