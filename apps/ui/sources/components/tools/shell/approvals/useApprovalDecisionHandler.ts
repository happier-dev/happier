import * as React from 'react';
import { getCurrentAuth } from '@/auth/context/currentAuth';

import type { ActionExecutorContext} from '@happier-dev/protocol/actions/executor/types';
import type { ActionId} from '@happier-dev/protocol/actions/actionIds';
import { readActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ApprovalRequest} from '@happier-dev/protocol/approvals/approvalRequestV1';
import type { TargetActionApprovalRequestV1} from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import type { ExecutionRunHostActionApprovalRequestV1 } from '@happier-dev/protocol/approvals/executionRunHostActionApprovalRequestV1';
import { ApprovalExecutionV1Schema, ApprovalRequestPublicSettlementSchema, resolveApprovalExecutor, type ApprovalExecutionV1 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { TeamInvitationCreateResultV1Schema, TeamInvitationReissueResultV1Schema } from '@happier-dev/protocol/teams';

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
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { WorkflowActionFailureV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';
import { formatWorkflowProblemMessage } from '@/components/workflows/presentation/workflowProblemPresentation';

export { resolveApprovalReplayRoute };

/** Live errors and durable execution failures retain the same typed outcome. */
export function isApprovalDecisionStale(error: unknown): boolean {
    return error instanceof HappyError ? error.code === 'approval_stale'
        : typeof error === 'object' && error !== null && 'errorCode' in error && error.errorCode === 'approval_stale';
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
    if (isApprovalDecisionStale(error)) return { reason: t('approvals.staleFailure'), code: null };
    const code = typeof error === 'object' && error !== null
        ? 'errorCode' in error ? error.errorCode : 'code' in error ? error.code : null
        : error;
    const diagnosticCode = typeof code === 'string' && /^[a-z][a-z0-9_]*$/.test(code) ? code : null;
    const providerCode = ProviderErrorCodeV1Schema.safeParse(code);
    if (providerCode.success && providerCode.data.startsWith('provider_')) {
        return { reason: t(presentProviderError(providerCode.data).descriptionKey), code: null };
    }
    if (error instanceof HappyError && error.code === 'present_user_required') {
        return { reason: t('approvals.decisionAuthorityError'), code: null };
    }
    // The reviewed change met a newer revision, so the executor applied nothing; its English diagnostic is not product copy.
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
    const failureCause = readActionFailureCauseV1(typeof error === 'object' && error !== null && 'failureCause' in error
        ? error.failureCause : undefined);
    const transient = readTransientAvailabilityFailure(code) ?? readTransientAvailabilityFailure(failureCause.errorCode);
    if (transient && !(error instanceof ApprovalExecutionError)) {
        return { reason: transient.effectMayHaveApplied ? t('errors.scmOutcomeUnknown') : transient.message, code: diagnosticCode ?? transient.code };
    }
    // A Service Unavailable response cannot establish whether the Home saved
    // this decision. Ask the person to inspect it before submitting it again.
    if (code === 'unavailable' && failureCause.httpStatus === 503 && !(error instanceof ApprovalExecutionError)) {
        return { reason: t('errors.scmOutcomeUnknown'), code };
    }
    // Detail pages may pass the stored executor diagnostic as their fallback.
    // Keep machine codes as diagnostics after readable copy on every Action.
    const reason = error instanceof ApprovalExecutionError ? t('approvals.failureGeneric')
        : /^[a-z][a-z0-9_]*(?::[a-z0-9_]+)*$/.test(fallbackMessage.trim())
            ? neutralReason : fallbackMessage;
    // Keep the validated cause for the shared presenter, without transport prose.
    return { reason: resolveActionExecutionErrorMessage({ code, failureCause }, reason), code: diagnosticCode };
}

/**
 * A settled request whose approved effect failed. The decision was saved, so a bare machine code never
 * reads as "failed to update approval": it reads as an unrecorded reason, with the code in Technical details.
 */
export function presentRecordedApprovalFailure(failure: Readonly<{ errorCode?: string; error?: string; details?: unknown; failureCause?: unknown }>): ReturnType<typeof presentApprovalFailure> {
    return presentApprovalFailure(failure, failure.error || failure.errorCode || t('approvals.failureNoReason'), t('approvals.failureNoReason'));
}

/**
 * The one alert for a decision that failed: the readable reason, and its typed code only behind a
 * deliberate Technical details, including when the approved effect has a recorded failure.
 */
export function alertApprovalFailure(error: unknown, fallbackMessage = t('approvals.decisionError')): void {
    // A confirmed execution cancellation is already visible in its receipt.
    if (error instanceof ApprovalExecutionError && error.code === 'cancelled') return;
    const { reason, code } = presentApprovalFailure(error, fallbackMessage);
    const failureCause = typeof error === 'object' && error !== null && 'failureCause' in error && error.failureCause !== undefined
        ? readActionFailureCauseV1(error.failureCause) : undefined;
    const details = typeof error === 'object' && error !== null && 'details' in error ? error.details : undefined;
    alertActionFailure({ reason, code,
        requestId: typeof error === 'object' && error !== null && 'requestId' in error && typeof error.requestId === 'string'
            ? error.requestId : undefined,
        context: {
        ...readSafeFailureDetails(details),
        ...failureCause,
    } });
}

/** Distinguishes a settled effect failure from a decision that could not be saved. */
export class ApprovalExecutionError extends HappyError {
    constructor(execution: ApprovalExecutionV1) {
        super(execution.error ?? 'approval_execution_failed', false, {
            code: execution.errorCode ?? 'approval_execution_failed',
            details: execution.details,
            failureCause: execution.failureCause === undefined ? undefined : readActionFailureCauseV1(execution.failureCause),
        });
        Object.setPrototypeOf(this, ApprovalExecutionError.prototype);
    }
}

/** A recorded decision is not a successful user outcome when its physical effect failed. */
export function assertApprovalExecutionSucceeded(execution: ApprovalExecutionV1): void {
    if (execution.ok !== false) return;
    if (isApprovalDecisionStale(execution)) {
        throw new HappyError(execution.error ?? 'approval_stale', false, { code: 'approval_stale' });
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
    onExecution?: (execution: ApprovalExecutionV1 | null) => void;
    /** The deciding person's reduced operands, admitted by the requested Action. */
    narrowedInput?: unknown;
    /** A resource proposal's turned-down items, as the person last saw them (plan 60 AGW-8). */
    declinedItems?: readonly Readonly<Record<string, unknown>>[];
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
        const revealsInvitation = decision === 'approve'
            && (builtInApproval?.actionId === 'teams.invitations.create' || builtInApproval?.actionId === 'teams.invitations.reissue');
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
            };
            const decisionContext: ActionExecutorContext = { surface: 'ui',
                ...(decision === 'approve' && narrowedInput !== undefined ? { authority: 'present_user' as const } : {}),
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
            if (!result.ok && result.errorCode === 'approval_execution_outcome_unknown') {
                // Another execution or a lost acknowledgement can leave the decision's
                // immediate answer behind its durable receipt. Read the exact approval
                // through the existing executor; never replay an uncertain effect.
                const observed = await executor.execute('approval.request.get', { artifactId: artifact.id }, {
                    surface: 'ui', ...(serverId ? { serverId } : {}),
                    ...(approval.v === 2 ? { expectedAccountId: approval.executionOriginV1.accountId } : {}),
                }).catch(() => null);
                const receipt = observed?.ok && typeof observed.result === 'object' && observed.result !== null && 'request' in observed.result
                    ? ApprovalRequestPublicSettlementSchema.safeParse(observed.result.request) : null;
                if (receipt?.success && (receipt.data.status === 'executed' || receipt.data.status === 'failed' || receipt.data.status === 'outcome_unknown') && receipt.data.execution) {
                    outcome = { status: receipt.data.status, execution: receipt.data.execution };
                    // The retained originating form settles through its canonical
                    // Artifact reader/continuation, including a missing socket echo.
                    if (serverId) publishHomeAccountChange(serverId, [artifact.id], { changeKinds: ['artifact'] });
                }
            }
            if (!result.ok && outcome === null) throw new HappyError(result.error, false, {
                code: result.errorCode, details: result.details, failureCause: result.failureCause,
            });
            // A decision can be recorded successfully while its execution was refused.
            // Never let a stale receipt become an optimistic "Approved" answer.
            const execution = typeof outcome === 'object' && outcome !== null && 'execution' in outcome
                ? ApprovalExecutionV1Schema.safeParse(outcome.execution) : null;
            // The Action owner has durably recorded this one-shot decision even
            // when its effect failed. Wake every Artifact projection and expose
            // that receipt before presenting the typed failure.
            if (serverId) publishHomeAccountChange(serverId, [artifact.id], { changeKinds: ['artifact'] });
            options?.onExecution?.(execution?.success ? execution.data : null);
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
            const parsed = builtInApproval?.actionId === 'teams.invitations.create'
                ? TeamInvitationCreateResultV1Schema.safeParse(live.result)
                : TeamInvitationReissueResultV1Schema.safeParse(live.result);
            if (!parsed.success) return false;
            // Email delivery and replay legitimately have no human bearer to reveal.
            if (parsed.data.joinUrl === null) return true;
            const props = {
                url: parsed.data.joinUrl,
                testIDPrefix: 'team-invite-approval',
                title: t('teams.invitations.linkRow'),
                copyLabel: t('teams.invitations.copyLink'),
                shareLabel: t('teams.invitations.shareLink'),
                qrAccessibilityLabel: t('teams.invitations.qrLabel'),
            };
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
    }, [approval, artifact.id, executor, replayRoute, serverId]);
}
