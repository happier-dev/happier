import * as React from 'react';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { ActionApprovalRequestCreatedResultSchema, projectUnexpectedActionFailureV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readProjectSetupConsentFailureV1, type ProjectSetupConsentFailureDetailsV1 } from '@happier-dev/protocol/actions/projectActionFamily';

import { awaitActionApprovalResult, createActionApprovalContinuation, type ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import type { UiActionExecutorContext } from '@/sync/ops/actions/defaultActionExecutor';
import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';
import type { FrontDoorRuntimeActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

/** Native presentation only; admission and approval custody remain with this mounted owner. */
export type LocalServiceActionInvocationOptions = Readonly<{
    confirmation?: NonNullable<NonNullable<Parameters<FrontDoorRuntimeActionExecute>[1]>['presentUserActionConfirmation']>;
}>;

type LocalServiceActionRequest = Parameters<FrontDoorRuntimeActionExecute>[0];
type LocalServiceActionExecute = (request: LocalServiceActionRequest, options?: LocalServiceActionInvocationOptions) => Promise<unknown>;
type LocalServiceRuntimeActionExecute = FrontDoorRuntimeActionExecute;

export type LocalServiceEffectReview = Readonly<{
    actionId: 'localServices.launcher.start' | 'localServices.actions.restartManaged';
    target: LocalServiceLaunchTarget;
    reviewedEffect: JsonValue;
    reviewedEffectDigest: string;
    signal?: AbortSignal;
}>;

export type LocalServiceSetupConsentReview = Readonly<{
    actionId: LocalServiceEffectReview['actionId'];
    target: LocalServiceLaunchTarget;
    consent: ProjectSetupConsentFailureDetailsV1;
    signal?: AbortSignal;
}>;

/** Translate only a schema-validated, request-bound Local Services refusal to the Setup owner's failure. */
export function readLocalServiceSetupConsentReview(value: unknown, response?: Readonly<{
    status: string;
    reasonCode?: string;
    reviewedEffect?: JsonValue;
    reviewedEffectDigest?: string;
}>): ProjectSetupConsentFailureDetailsV1 | null {
    const direct = readProjectSetupConsentFailureV1(value);
    if (direct) return direct.details;
    if (response?.status !== 'denied'
        || (response.reasonCode !== 'project_setup_consent_required' && response.reasonCode !== 'project_setup_effect_changed')) return null;
    return readProjectSetupConsentFailureV1({ ok: false, errorCode: response.reasonCode, error: response.reasonCode,
        details: { kind: 'pendingApproval', code: response.reasonCode,
            reviewedEffect: response.reviewedEffect, reviewedEffectDigest: response.reviewedEffectDigest } })?.details ?? null;
}

/** UI lifetime hints, never caller-supplied daemon authority or a second approval owner. */
export type LocalServiceActionAdmission = Readonly<{
    expectedAccountId?: string | null;
    signal?: AbortSignal;
    isCurrent?: () => boolean;
    onApprovalPending?: (approval: ActionApprovalRegistration) => void;
    reviewEffect?: (review: LocalServiceEffectReview) => Promise<boolean>;
    reviewSetupConsent?: (review: LocalServiceSetupConsentReview) => Promise<boolean>;
}>;

export function isLocalServiceActionAdmissionCurrent(admission: LocalServiceActionAdmission): boolean {
    return !admission.signal?.aborted && (admission.isCurrent?.() ?? true);
}

const cancelled = () => ({ ok: false as const, errorCode: 'cancelled', error: 'cancelled' });

export function useLocalServiceActionExecutor(context: LocalServiceActionAdmission & Readonly<{
    runtimeActionExecute?: LocalServiceRuntimeActionExecute | null;
}>): LocalServiceActionExecute | undefined {
    return React.useMemo(() => context.runtimeActionExecute
        ? (request, options) => executeLocalServiceActionWithAdmission({ execute: context.runtimeActionExecute!, request, admission: context, ...options })
        : undefined, [context.runtimeActionExecute, context.expectedAccountId, context.signal, context.isCurrent, context.onApprovalPending]);
}

/** Join immediate and durable Ask-first results through the existing Artifact continuation. */
export async function executeLocalServiceActionWithAdmission(input: Readonly<{
    execute: LocalServiceRuntimeActionExecute;
    request: LocalServiceActionRequest;
    admission: LocalServiceActionAdmission;
    confirmation?: LocalServiceActionInvocationOptions['confirmation'];
}>): Promise<unknown> {
    const { admission, request } = input;
    if (!isLocalServiceActionAdmissionCurrent(admission)) return cancelled();
    const context: UiActionExecutorContext = { ...request.context,
        ...(admission.expectedAccountId ? { expectedAccountId: admission.expectedAccountId } : {}),
        ...(admission.signal ? { signal: admission.signal } : {}),
    };
    let dispatched = false;
    const retired = () => dispatched && request.actionId === 'localServices.launcher.start'
        ? projectUnexpectedActionFailureV1(null, context.actionRequestId ?? undefined) : cancelled();
    const outcome = await awaitActionApprovalResult<unknown, Readonly<{ value: unknown }>>({
        async execute(callbacks) {
            const args = { ...request, context };
            dispatched = true;
            const value = await (input.confirmation
                ? input.execute(args, { presentUserActionConfirmation: input.confirmation })
                : input.execute(args));
            if (!isLocalServiceActionAdmissionCurrent(admission)) return { value: retired() };
            const approval = ActionApprovalRequestCreatedResultSchema.safeParse(value);
            if (!approval.success) return { value };
            if (approval.data.actionId !== request.actionId) return { value: { ok: false, errorCode: 'approval_binding_mismatch', error: 'approval_binding_mismatch' } };
            // Legacy callers without a mounted continuation retain the truthful pending receipt.
            if (!admission.onApprovalPending || !admission.expectedAccountId || !context.serverId) return { value };
            admission.onApprovalPending(createActionApprovalContinuation({
                artifactId: approval.data.artifactId,
                actionId: request.actionId,
                scope: { serverId: context.serverId, accountId: admission.expectedAccountId },
                expectedInput: request.input,
                ...(admission.signal ? { signal: admission.signal } : {}),
                onSucceeded: callbacks.onApprovalSucceeded,
                onFailed: callbacks.onApprovalFailed,
            }));
            return { approvalPending: true };
        },
        succeeded: value => ({ value: isLocalServiceActionAdmissionCurrent(admission) ? value : retired() }),
        failed: (code, failure) => ({ value: failure ?? { ok: false, errorCode: code, error: code } }),
        aborted: () => ({ value: retired() }),
        ...(admission.signal ? { signal: admission.signal } : {}),
    });
    return outcome.value;
}
