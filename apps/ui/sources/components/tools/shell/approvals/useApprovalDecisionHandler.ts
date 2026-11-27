import * as React from 'react';
import { SessionInputAdmissionResultV1Schema, type SessionInputAdmissionResultV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { getCurrentAuth } from '@/auth/context/currentAuth';

import { readActionFailureEnvelope } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import type { ActionExecutorContext} from '@happier-dev/protocol/actions/executor/types';
import type { ActionId} from '@happier-dev/protocol/actions/actionIds';
import { isActionOutcomeUnknownErrorCodeV1, readActionFailureCauseV1, readActionFailurePresentationV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ApprovalRequest} from '@happier-dev/protocol/approvals/approvalRequestV1';
import type { TargetActionApprovalRequestV1} from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import type { ExecutionRunHostActionApprovalRequestV1 } from '@happier-dev/protocol/approvals/executionRunHostActionApprovalRequestV1';
import { ApprovalExecutionV1Schema, isApprovalRequestV2TerminalStatus, LIVE_CLI_APPROVAL_DECIDE_METHOD, resolveApprovalExecutor, type ApprovalExecutionV1 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { ApprovalRequestPublicReadSchema } from '@happier-dev/protocol/approvals/approvalRequestPublicRead';
import { ApprovalStaleFailureDetailsSchema } from '@happier-dev/protocol/approvals/approvalStaleReason';
import { TeamInvitationCreateResultV1Schema, TeamInvitationReissueResultV1Schema } from '@happier-dev/protocol/teams';
import { MachinePairingCreateOutputSchema } from '@happier-dev/protocol/actions/specs/machineConnection';

import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import {
    createDefaultActionExecutor,
    resolveApprovalReplayRoute,
    type ApprovalReplayRoute,
} from '@/sync/ops/actions/defaultActionExecutor';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { captureLazyActionAccountContext, type LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { TeamLinkDelivery } from '@/components/settings/teams/TeamLinkDelivery';
import { Modal } from '@/modal';
import { HappyError } from '@/utils/errors/errors';
import { readTransientAvailabilityFailure } from '@/utils/errors/transientAvailability';
import { alertActionFailure, readSafeFailureDetails } from '@/utils/errors/alertActionFailure';
import { recordResourceProposalDeclines } from '@/components/approvals/resourceProposal/recordResourceProposalDeclines';
import { t } from '@/text';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { ProviderErrorCodeV1Schema } from '@happier-dev/protocol/providers/errors';
import { presentProviderError } from '@/providers/connection/errorPresentation';
import { presentActionExecutionFailure, readRuntimeActionDisabledReason } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { requireActionSuccess } from '@/sync/ops/actions/actionResult';
import { WorkflowActionFailureV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';
import { formatWorkflowProblemMessage } from '@/components/workflows/presentation/workflowProblemPresentation';

export { resolveApprovalReplayRoute };

/** Live errors and durable execution failures retain the same typed outcome. */
export function isApprovalDecisionStale(error: unknown): boolean {
    return error instanceof HappyError ? error.code === 'approval_stale'
        : typeof error === 'object' && error !== null && 'errorCode' in error && error.errorCode === 'approval_stale';
}

function readApprovalDecisionAvailability(code: unknown, cause: unknown) {
    const failure = readActionFailureCauseV1(cause);
    const transient = readTransientAvailabilityFailure(code) ?? readTransientAvailabilityFailure(failure.errorCode);
    const uncertain = isActionOutcomeUnknownErrorCodeV1(code)
        || (transient?.effectMayHaveApplied ?? (code === 'unavailable' && failure.httpStatus === 503));
    return { failure, transient, uncertain };
}

/**
 * The one presentation of an approval failure, for every Action: a readable reason, and the typed
 * code kept apart. Surfaces show the reason as the headline and keep the code in Technical details.
 */
export function presentApprovalFailure(
    error: unknown,
    fallbackMessage = t('approvals.decisionError'),
    /** What a bare machine code reads as when the surface is not an approval decision. */
    neutralReason = t('approvals.decisionError'),
): Readonly<{
    reason: string;
    code: string | null;
}> {
    if (isApprovalDecisionStale(error)) {
        // The stale fact the executor named: the asking Session stopped or changed reads as that, not a moved target.
        const stale = ApprovalStaleFailureDetailsSchema.safeParse(typeof error === 'object' && error !== null && 'details' in error
            ? error.details : undefined);
        return { reason: t(stale.success && stale.data.reason === 'session_changed' ? 'approvals.staleSessionChanged' : 'approvals.staleFailure'),
            code: null };
    }
    const code = typeof error === 'object' && error !== null
        ? 'errorCode' in error ? error.errorCode : 'code' in error ? error.code : null
        : error;
    const refusal = readActionFailurePresentationV1(code,
        typeof error === 'object' && error !== null && 'details' in error ? error.details : undefined);
    if (refusal) return { reason: refusal.message ?? t('common.requestFailed'), code: typeof code === 'string' ? code : null };
    const diagnosticCode = typeof code === 'string' && /^[a-z][a-z0-9_]*$/.test(code) ? code : null;
    const providerCode = ProviderErrorCodeV1Schema.safeParse(code);
    if (providerCode.success && providerCode.data.startsWith('provider_')) {
        return { reason: t(presentProviderError(providerCode.data).descriptionKey), code: null };
    }
    if (error instanceof HappyError && error.code === 'present_user_required') {
        return { reason: t('approvals.decisionAuthorityError'), code: null };
    }
    // The reviewed change met a newer revision, so the executor applied nothing; its English diagnostic is not product copy.
    if (code === 'content_unavailable') return { reason: t('workflows.contentUnavailable'), code };
    if (code === 'conflict') return { reason: t('approvals.conflictFailure'), code: null };
    // The approved plugin change never reached the Machine's plugin service; the code stays in Technical details.
    if (code === 'plugin_change_daemon_unavailable') return { reason: t('approvals.pluginChangeDaemonUnavailable'), code };
    if (typeof error === 'object' && error !== null && 'details' in error) {
        const workflow = WorkflowActionFailureV1Schema.safeParse({ ok: false, errorCode: code, error: code,
            details: error.details });
        if (workflow.success && 'details' in workflow.data && workflow.data.details !== undefined) {
            return { reason: formatWorkflowProblemMessage(new WorkflowActionError({
                rawCode: workflow.data.errorCode, message: workflow.data.error, failure: workflow.data,
            })), code: workflow.data.errorCode };
        }
    }
    // Only a confirmed no-effect refusal may promise that nothing changed.
    const availability = readApprovalDecisionAvailability(code, typeof error === 'object' && error !== null && 'failureCause' in error
        ? error.failureCause : undefined);
    const cause = availability.failure;
    if (code === 'approval_origin_unavailable' && cause.phase === LIVE_CLI_APPROVAL_DECIDE_METHOD
        && 'nativeErrorReason' in cause && cause.nativeErrorReason === 'unregistered') {
        return { reason: t('approvals.liveOriginUnavailable'), code };
    }
    if (!(error instanceof ApprovalExecutionError)) {
        if (availability.uncertain) return { reason: t('errors.scmOutcomeUnknown'), code: diagnosticCode ?? availability.transient?.code ?? null };
        if (availability.transient) return { reason: availability.transient.message, code: diagnosticCode ?? availability.transient.code };
    }
    // Detail pages may pass the stored executor diagnostic as their fallback.
    // Keep machine codes as diagnostics after readable copy on every Action.
    const reason = error instanceof ApprovalExecutionError ? t('approvals.failureGeneric')
        : /^[a-z][a-z0-9_]*(?::[a-z0-9_]+)*$/.test(fallbackMessage.trim())
            ? neutralReason : fallbackMessage;
    // A stored public failure can supply the readable reason already selected
    // above. Keep it with the cause; raw thrown transport prose stays excluded.
    const publicReason = typeof error === 'object' && error !== null && !(error instanceof Error)
        && 'error' in error && error.error === reason ? reason : undefined;
    // A runtime family's refusal carries its typed reason in its error; the presenter reads that reason, never the text.
    const runtimeRefusal = readRuntimeActionDisabledReason(error) ? { error: (error as { error: string }).error } : null;
    return { reason: presentActionExecutionFailure({ ok: false,
        errorCode: diagnosticCode ?? 'approval_execution_failed', failureCause: availability.failure, ...runtimeRefusal,
        ...(publicReason ? { message: publicReason } : {}) }, reason).reason, code: diagnosticCode };
}

/**
 * A settled request whose approved effect failed. The decision was saved, so a bare machine code never
 * reads as "failed to update approval": it reads as an unrecorded reason, with the code in Technical details.
 */
export function presentRecordedApprovalFailure(failure: Readonly<{ errorCode?: string; error?: string; details?: unknown; failureCause?: unknown }>): ReturnType<typeof presentApprovalFailure> {
    return presentApprovalFailure(failure, failure.error || failure.errorCode || t('approvals.failureNoReason'), t('approvals.failureNoReason'));
}

/** The Action refusal stays in the cause when imperative decision callers receive an Error. */
export function readApprovalDecisionFailure(error: unknown) {
    return readActionFailureEnvelope(error, { treatReturnedErrorEnvelopeAsFailure: true })
        ?? (error instanceof Error ? readActionFailureEnvelope(error.cause) : null);
}

/**
 * The one alert for a decision that failed: the readable reason, and its typed code only behind a
 * deliberate Technical details, including when the approved effect has a recorded failure.
 */
export function alertApprovalFailure(error: unknown, fallbackMessage = t('approvals.decisionError')): void {
    // A confirmed cancellation is already visible in the approval or execution receipt.
    if (error instanceof HappyError && (error.code === 'approval_canceled'
        || error instanceof ApprovalExecutionError && error.code === 'cancelled')) return;
    const { reason, code } = presentApprovalFailure(error, fallbackMessage);
    const diagnostic = readApprovalDecisionFailure(error) ?? (error instanceof HappyError ? error : null);
    alertActionFailure({ reason, code, requestId: diagnostic?.requestId,
        context: {
            ...readSafeFailureDetails(diagnostic?.details),
            ...diagnostic?.failureCause,
            ...(diagnostic?.effectAttempted === undefined ? {} : { effectAttempted: diagnostic.effectAttempted }),
        },
    });
}

/** Distinguishes a settled effect failure from a decision that could not be saved. */
export class ApprovalExecutionError extends HappyError {
    constructor(execution: ApprovalExecutionV1) {
        const failure = readActionFailureEnvelope({ ...execution, errorCode: execution.errorCode ?? 'approval_execution_failed' });
        super(execution.error ?? 'approval_execution_failed', false, {
            code: execution.errorCode ?? 'approval_execution_failed',
            details: failure?.details,
            failureCause: failure?.failureCause,
            requestId: failure?.requestId,
            effectAttempted: failure?.effectAttempted,
            cause: failure ?? undefined,
        });
        Object.setPrototypeOf(this, ApprovalExecutionError.prototype);
    }
}

/** A recorded decision is not a successful user outcome when its physical effect failed. */
export function assertApprovalExecutionSucceeded(execution: ApprovalExecutionV1): void {
    if (execution.ok !== false) return;
    if (isApprovalDecisionStale(execution) || isActionOutcomeUnknownErrorCodeV1(execution.errorCode)) {
        const failure = readActionFailureEnvelope(execution);
        if (failure) requireActionSuccess(failure);
    }
    throw new ApprovalExecutionError(execution);
}

type ApprovalDecisionArtifact = Pick<DecryptedArtifact, 'id' | 'header'>;
type ApprovalHomeRequest = ApprovalRequest | TargetActionApprovalRequestV1 | ExecutionRunHostActionApprovalRequestV1;

function isTargetActionApproval(approval: ApprovalHomeRequest): approval is TargetActionApprovalRequestV1 {
    return 'kind' in approval && approval.kind === 'plugin_target_action';
}

function requiresResolvedReplayRoute(approval: ApprovalHomeRequest): boolean {
    const executor = 'kind' in approval && approval.kind !== 'plugin_target_action' ? null : resolveApprovalExecutor(approval);
    if (isTargetActionApproval(approval)) {
        return executor?.kind === 'daemon' || Boolean(approval.executionOriginV1?.serverIdentityId?.trim());
    }
    return approval.v === 2 && (
        executor?.kind === 'daemon'
        || Boolean(approval.executionOriginV1.serverIdentityId?.trim())
    );
}

export function isApprovalReplayRouteUnavailable(approval: ApprovalHomeRequest | null): boolean {
    // Public credential-bound decisions already reach the exact admitted Home /
    // Session through the executor. The daemon, not a browser profile alias,
    // resolves and admits the saved execution origin on that transport.
    if (getCurrentAuth()?.credentialAuthorityKind === 'api_token') return false;
    return Boolean(approval && requiresResolvedReplayRoute(approval) && !resolveApprovalReplayRoute(approval));
}

function readServerId(
    artifact: ApprovalDecisionArtifact,
    approval: ApprovalHomeRequest | null,
    replayRoute: ApprovalReplayRoute | null,
    sessionId: string,
    serverIdHint?: string | null,
): string | null {
    if (replayRoute) return replayRoute.serverId;
    // The mounted Artifact Home remains usable for cancellation even when its
    // execution origin cannot be reached. Approve/reject require replayRoute below.
    const normalizedServerIdHint = serverIdHint?.trim() ?? '';
    if (normalizedServerIdHint.length > 0) return normalizedServerIdHint;
    if (approval && 'kind' in approval && approval.kind === 'plugin_target_action') return null;
    const headerServerId = typeof artifact.header?.serverId === 'string' ? artifact.header.serverId.trim() : '';
    if (headerServerId.length > 0) return headerServerId;
    if (approval?.v === 2) return approval.executionOriginV1.serverId.trim() || null;
    return resolvePreferredServerIdForSessionId(sessionId) ?? null;
}

export type ApprovalDecisionOptions = Readonly<{
    /** The canonical execution receipt, distinct from recording the decision. */
    onExecution?: (execution: ApprovalExecutionV1 | null, delivery?: SessionInputAdmissionResultV1) => void;
    /** The deciding person's reduced operands, admitted by the requested Action. */
    narrowedInput?: unknown;
    /** A resource proposal's turned-down items, as the person last saw them (plan 60 AGW-8). */
    declinedItems?: readonly Readonly<Record<string, unknown>>[];
    /** The present person's answer for one selected shared check (D15); approving the Action is not consent. */
    triggerConsent?: Readonly<{ automationId: string; triggerId: string; decision: 'allow' | 'skip' }>;
}>;

/** Presentation and decisions use the same proven Home, including portable replay origins. */
export function useApprovalHome(
    artifact: ApprovalDecisionArtifact,
    approval: ApprovalHomeRequest | null,
    sessionId: string,
    serverIdHint?: string | null,
): Readonly<{ serverId: string | null; replayRoute: ApprovalReplayRoute | null }> {
    const serverProfilesGeneration = useServerProfilesGeneration();
    const replayRoute = React.useMemo(
        () => resolveApprovalReplayRoute(approval),
        [approval, serverProfilesGeneration],
    );
    const serverId = React.useMemo(
        () => readServerId(artifact, approval, replayRoute, sessionId, serverIdHint),
        [approval, artifact, replayRoute, serverIdHint, sessionId],
    );
    return { serverId, replayRoute };
}

export function useApprovalDecisionHandler(
    artifact: ApprovalDecisionArtifact,
    approval: ApprovalHomeRequest | null,
    sessionId: string,
    serverIdHint?: string | null,
): (decision: 'approve' | 'reject' | 'cancel', options?: ApprovalDecisionOptions) => Promise<boolean> {
    const { serverId, replayRoute } = useApprovalHome(artifact, approval, sessionId, serverIdHint);
    const executor = React.useMemo(
        () => createDefaultActionExecutor({
            resolveServerIdForSessionId: (targetSessionId) => resolvePreferredServerIdForSessionId(targetSessionId) ?? null,
            // An allowed Agent/MCP Saved Secret reveal is displayed once, here, to the person who allowed it;
            // the replay and the requester receive only the value-free outcome.
            savedSecretRevealAction: async ({ input, context }) => {
                if (!context.serverId) return { ok: false, errorCode: 'unavailable', error: 'unavailable' };
                const { presentApprovedSavedSecretReveal } = await import('@/components/secrets/approvedSavedSecretReveal');
                return await presentApprovedSavedSecretReveal(context.serverId, input);
            },
        }),
        [],
    );
    const mounted = React.useRef(true);
    // Callers already observe this Artifact. Join that observation rather than
    // treating an early readback as settlement or starting another reader.
    const observedApproval = React.useRef({ artifactId: artifact.id, serverId, approval });
    observedApproval.current = { artifactId: artifact.id, serverId, approval };
    const settlementWaiters = React.useRef(new Set<(request: ApprovalHomeRequest | null) => void>());
    React.useEffect(() => {
        if (approval && !isApprovalRequestV2TerminalStatus(approval.status)) return;
        for (const settle of settlementWaiters.current) settle(approval);
        settlementWaiters.current.clear();
    }, [approval]);
    React.useEffect(() => () => {
        for (const settle of settlementWaiters.current) settle(null);
        settlementWaiters.current.clear();
    }, [artifact.id, serverId]);
    const awaitObservedSettlement = React.useCallback(() => {
        const observed = observedApproval.current;
        if (!mounted.current || observed.artifactId !== artifact.id || observed.serverId !== serverId) return Promise.resolve(null);
        const current = observed.approval;
        if (!current || isApprovalRequestV2TerminalStatus(current.status)) return Promise.resolve(current);
        return new Promise<ApprovalHomeRequest | null>(resolve => { settlementWaiters.current.add(resolve); });
    }, [artifact.id, serverId]);
    const publicPreparation = React.useRef<AbortController | null>(null);
    React.useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; publicPreparation.current?.abort(); };
    }, [artifact.id, approval, serverId]);
    return React.useCallback(async (decision: 'approve' | 'reject' | 'cancel', options?: ApprovalDecisionOptions) => {
        if (!approval) return false;
        const builtInApproval = 'kind' in approval ? null : approval;
        // Missing execution custody cannot record consent. Keep the request open
        // even when its portable Home route is also unavailable.
        if (
            decision === 'approve'
            && builtInApproval && resolveApprovalExecutor(builtInApproval).kind === 'unavailable'
        ) return false;
        // Account-owned replay resolves immutable Home identity here. A child-token
        // decision instead delegates that admission to its existing public transport;
        // present-user UI approvals remain on their exact mounted route.
        if (decision !== 'cancel' && isApprovalReplayRouteUnavailable(approval)) {
            throw new HappyError('approval_origin_unavailable', false, { code: 'approval_origin_unavailable' });
        }
        const revealsPairingLink = decision === 'approve' && builtInApproval?.actionId === 'machines.pairing.create';
        // Live-only links reach only this deciding person; the requester receives a held result.
        const revealsInvitation = decision === 'approve'
            && (builtInApproval?.actionId === 'teams.invitations.create' || builtInApproval?.actionId === 'teams.invitations.reissue'
                || revealsPairingLink);
        const publicLinkActionId = builtInApproval?.actionId === 'session.public_link.create' || builtInApproval?.actionId === 'artifact.public_link.create'
            ? builtInApproval.actionId : null;
        const publicLink = decision === 'approve' && publicLinkActionId !== null;
        const preparation = publicLink ? new AbortController() : null;
        if (preparation) publicPreparation.current = preparation;
        let narrowedInput = options?.narrowedInput;
        let account: LazyActionAccountContext | null = null;
        let retainedForReveal = false;
        try {
            if (revealsInvitation || publicLink) {
                if (!serverId) return false;
                account = await captureLazyActionAccountContext(serverId);
                if (account.credentialAuthorityKind !== 'account') return false;
                account.assertCurrent();
            }
            if (publicLink && account && preparation && builtInApproval) {
                const { preparePublicLinkApproval } = await import('@/components/sharing/publicLinkApprovalPreparation');
                if (preparation.signal.aborted || !mounted.current) return true;
                const captured = account;
                const prepared = await preparePublicLinkApproval({ approval: builtInApproval, account: captured, executor, signal: preparation.signal,
                    isCurrent: () => mounted.current && !preparation.signal.aborted && captured.accountLifetime.isCurrent() });
                if (publicPreparation.current === preparation) publicPreparation.current = null;
                if (prepared.kind === 'handled') return true;
                narrowedInput = prepared.narrowedInput;
            }
            const decisionInput = {
                artifactId: artifact.id,
                decision,
                ...(decision === 'approve' && narrowedInput !== undefined ? { narrowedInput } : {}),
                ...(decision === 'approve' && options?.triggerConsent ? { triggerConsent: options.triggerConsent } : {}),
            };
            const presentUser = decision === 'approve' && (narrowedInput !== undefined || options?.triggerConsent !== undefined);
            const decisionContext: ActionExecutorContext = { surface: 'ui',
                ...(presentUser ? { authority: 'present_user' as const } : {}),
                ...(serverId ? { serverId } : {}),
                ...(account ? { expectedAccountId: account.accountId } : {}) };
            let result = await executor.execute(
                'approval.request.decide' as ActionId,
                decisionInput,
                decisionContext,
            );
            if (!result.ok && result.errorCode === 'approval_context_unavailable'
                && decision === 'approve' && builtInApproval?.v === 2 && narrowedInput === undefined
                && mounted.current && !preparation?.signal.aborted) {
                // This typed refusal is pre-effect. Resume this same consent
                // once through the canonical approved-request/CAS owner; it
                // re-reads custody and never replays an executing claim. Choices
                // keep their existing Open-only narrowing contract.
                result = await executor.execute('approval.request.decide', decisionInput, {
                    ...decisionContext,
                    ...(builtInApproval.executionOriginV1.accountId
                        ? { expectedAccountId: builtInApproval.executionOriginV1.accountId } : {}),
                });
            }
            let outcome: unknown = result.ok ? result.result : null;
            if (!result.ok && result.effectAttempted !== false
                && readApprovalDecisionAvailability(result.errorCode, result.failureCause).uncertain) {
                // Another execution or a lost acknowledgement can leave the decision's
                // immediate answer behind its durable receipt. Read the exact approval
                // through the existing executor; never replay an uncertain effect.
                const observed = await executor.execute('approval.request.get', { artifactId: artifact.id }, {
                    surface: 'ui', ...(serverId ? { serverId } : {}),
                    ...(decisionContext.expectedAccountId ? { expectedAccountId: decisionContext.expectedAccountId } : {}),
                }).catch(() => null);
                const receipt = observed?.ok && typeof observed.result === 'object' && observed.result !== null && 'request' in observed.result
                    ? ApprovalRequestPublicReadSchema.safeParse(observed.result.request) : null;
                if (receipt?.success) {
                    const { status, execution } = receipt.data;
                    if ((status === 'executed' || status === 'failed' || status === 'outcome_unknown')
                        && execution?.ok === (status === 'executed')) outcome = { status, execution };
                    else if (status === 'approved' || status === 'executing') outcome = await awaitObservedSettlement();
                }
            }
            if (!result.ok && outcome === null) requireActionSuccess(result);
            // A decision can be recorded successfully while its execution was refused.
            // Never let a stale receipt become an optimistic "Approved" answer.
            const execution = typeof outcome === 'object' && outcome !== null && 'execution' in outcome
                ? ApprovalExecutionV1Schema.safeParse(outcome.execution) : null;
            // The Action owner has durably recorded this one-shot decision even
            // when its effect failed. Wake every Artifact projection and expose
            // that receipt before presenting the typed failure.
            if (serverId) publishHomeAccountChange(serverId, [artifact.id], { changeKinds: ['artifact'] });
            const delivery = typeof outcome === 'object' && outcome !== null && 'delivery' in outcome
                ? SessionInputAdmissionResultV1Schema.safeParse(outcome.delivery) : null;
            if (delivery?.success) options?.onExecution?.(execution?.success ? execution.data : null, delivery.data);
            else options?.onExecution?.(execution?.success ? execution.data : null);
            if (execution?.success) assertApprovalExecutionSucceeded(execution.data);
            // A storage proposal remembers what the person turned down; best effort, the decision stands.
            if (builtInApproval) void recordResourceProposalDeclines(builtInApproval, decision, narrowedInput, options?.declinedItems, serverId);
            // Token creation returns its secret to the retained requesting
            // invocation; its approver has no reveal to adopt.
            if (!revealsInvitation || !account) return true;
            account.assertCurrent();
            const live = typeof outcome === 'object' && outcome !== null && 'liveExecution' in outcome
                ? outcome.liveExecution : null;
            // A retained invocation owns its private result. Its successful
            // decision still counts as handled when this app has no reveal.
            if (typeof live !== 'object' || live === null || !('ok' in live) || live.ok !== true
                || !('result' in live)) return true;
            const captured = account;
            let props: React.ComponentProps<typeof TeamLinkDelivery>;
            if (revealsPairingLink) {
                const pairing = MachinePairingCreateOutputSchema.safeParse(live.result);
                if (!pairing.success) return false;
                props = {
                    url: pairing.data.link,
                    testIDPrefix: 'pairing-approval',
                    title: t('homeSetup.pairingComputerStepOpenTitle'),
                    description: t('homeSetup.pairingComputerStepJoin'),
                    copyLabel: t('homeSetup.copyLink'),
                    shareLabel: t('homeSetup.shareLink'),
                    qrAccessibilityLabel: t('homeSetup.pairingScanTitle'),
                };
            } else {
                const parsed = builtInApproval?.actionId === 'teams.invitations.create'
                    ? TeamInvitationCreateResultV1Schema.safeParse(live.result)
                    : TeamInvitationReissueResultV1Schema.safeParse(live.result);
                if (!parsed.success) return false;
                // Email delivery and replay legitimately have no human bearer to reveal.
                if (parsed.data.joinUrl === null) return true;
                props = {
                    url: parsed.data.joinUrl,
                    testIDPrefix: 'team-invite-approval',
                    title: t('teams.invitations.linkRow'),
                    copyLabel: t('teams.invitations.copyLink'),
                    shareLabel: t('teams.invitations.shareLink'),
                    qrAccessibilityLabel: t('teams.invitations.qrLabel'),
                };
            }
            let retirement: Readonly<{ dispose: () => void }> | undefined;
            const modalId = Modal.show({
                component: TeamLinkDelivery,
                props,
                chrome: { kind: 'card', header: 'none', title: props.title, phonePresentation: 'sheet' },
                onHostUnmount: () => {
                    retirement?.dispose();
                    captured.dispose();
                },
            });
            retirement = captured.accountLifetime.onRetire(() => {
                Modal.update(modalId, { ...props, url: '' });
                Modal.hide(modalId);
            });
            retainedForReveal = true;
            return true;
        } catch (error) {
            if (publicLink && preparation?.signal.aborted) return true;
            if (revealsInvitation && account && !account.accountLifetime.isCurrent()) return false;
            throw error;
        } finally {
            if (publicPreparation.current === preparation) publicPreparation.current = null;
            if (!retainedForReveal) account?.dispose();
        }
    }, [approval, artifact.id, awaitObservedSettlement, executor, replayRoute, serverId]);
}
