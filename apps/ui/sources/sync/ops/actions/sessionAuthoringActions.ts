import { SessionAuthoringOpenResultV1Schema, type SessionAuthoringOpenResultV1, type SessionAuthoringOpenV1 } from '@happier-dev/protocol/plugins/ui';
import { ActionApprovalRequestCreatedResultSchema, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { createFrontDoorActionExecute } from './frontDoorRuntimeActionExecutor';

/** A mounted caller supplies the existing approval/result-custody owner. */
export type MountedAuthoringActionExecute = (actionId: ActionId, input: unknown,
    options?: Readonly<{ signal?: AbortSignal }>) => Promise<ActionExecuteResult>;

/** What opening New Session came to, in the published settlement vocabulary plus the Action's own two outcomes. */
export type SessionAuthoringOpenOutcome = SessionAuthoringOpenResultV1
    | Readonly<{ kind: 'approvalPending'; artifactId: string }>
    | Readonly<{ kind: 'refused'; errorCode: string }>;

/**
 * The one first-party entry to `session.authoring.open`: every UI caller runs the same admission as agent and MCP
 * callers, and every outcome other than opened (or a caller that has gone) is shown once, here — a refusal with its
 * typed reason, a waiting approval with a way to review it. Callers only decide what to do on `opened`.
 */
export async function openSessionAuthoringAction(input: SessionAuthoringOpenV1,
    lifetime: ServerAccountScopeLifetime, options?: Readonly<{
        signal?: AbortSignal;
        executeAction?: MountedAuthoringActionExecute;
        /** The caller's own surface lifetime, beyond its Account. */
        isCurrent?: () => boolean;
    }>): Promise<SessionAuthoringOpenOutcome> {
    const current = () => lifetime.isCurrent() && options?.isCurrent?.() !== false && options?.signal?.aborted !== true;
    if (!current()) return { kind: 'stale', reason: 'host_retired' };
    const execute: MountedAuthoringActionExecute = options?.executeAction
        // This module dispatches only session.authoring.open, so the default port names it literally.
        ?? ((_actionId, actionInput, invocation) => createFrontDoorActionExecute()('session.authoring.open', actionInput, {
            surface: 'ui', authority: 'present_user', serverId: lifetime.scope.serverId,
            expectedAccountId: lifetime.scope.accountId, ...(invocation?.signal ? { signal: invocation.signal } : {}),
        }));
    let result: ActionExecuteResult;
    try {
        result = await execute('session.authoring.open', input, { signal: options?.signal });
    } catch (error) {
        result = { ok: false, errorCode: readErrorCode(error), error: error instanceof Error ? error.message : 'session.authoring.open failed' };
    }
    if (!current()) return { kind: 'stale', reason: 'host_retired' };
    const outcome = readOutcome(result);
    await presentOutcome(outcome, result, lifetime);
    return outcome;
}

function readErrorCode(error: unknown): string {
    const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
    return typeof code === 'string' && code ? code : 'action_failed';
}

function readOutcome(result: ActionExecuteResult): SessionAuthoringOpenOutcome {
    // A created approval request arrives as a receipt or inside the approval_required refusal.
    const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.ok ? result.result : result.details);
    if (approval.success) return { kind: 'approvalPending', artifactId: approval.data.artifactId };
    if (!result.ok) return result.errorCode === 'cancelled'
        ? { kind: 'unavailable', reason: 'aborted' } : { kind: 'refused', errorCode: result.errorCode };
    const parsed = SessionAuthoringOpenResultV1Schema.safeParse(result.result);
    return parsed.success ? parsed.data : { kind: 'unavailable', reason: 'client_unavailable' };
}

async function presentOutcome(outcome: SessionAuthoringOpenOutcome, result: ActionExecuteResult,
    lifetime: ServerAccountScopeLifetime): Promise<void> {
    if (outcome.kind === 'opened' || outcome.kind === 'stale'
        || (outcome.kind === 'unavailable' && outcome.reason === 'aborted')) return;
    // Presentation owners load only when there is something to show (and stay out of this module's import graph).
    if (outcome.kind === 'approvalPending') {
        const { announceActionApprovalPending } = await import('@/components/approvals/announceActionApprovalPending');
        announceActionApprovalPending(outcome.artifactId, lifetime.scope.serverId);
        return;
    }
    const [{ publishPresentationNotice }, { resolveActionExecutionFailureMessage }, { t }] = await Promise.all([
        import('@/components/sessions/presentation/presentationNotices'),
        import('./resolveActionExecutionFailureMessage'),
        import('@/text'),
    ]);
    const fallback = t('errors.operationFailed');
    publishPresentationNotice({ key: 'session-authoring-open', severity: 'error',
        message: outcome.kind === 'refused' ? resolveActionExecutionFailureMessage(result, fallback) ?? fallback : fallback });
}
