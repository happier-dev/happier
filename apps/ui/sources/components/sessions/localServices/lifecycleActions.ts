import * as React from 'react';

import { createLocalServiceActionConfirmationNonceV1, LocalServiceActionResultV1Schema, LocalServiceManagedServiceActionTargetV1Schema, type LocalServiceActionKindV1, type LocalServiceActionRequestV1 } from '@happier-dev/protocol/local/services/actions/v1';
import { resolveLocalServiceActionKindForRuntimeActionId } from '@happier-dev/protocol/actions/specs/localServices';
import type { RuntimeActionExecute } from '@happier-dev/protocol/actions/executor/types';
import { DaemonLocalServiceLauncherHistoryClearResponseV1Schema, DaemonLocalServiceLauncherLeafRequestV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';

import type { LocalServiceLauncherSnapshot, LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';
import { randomUUID } from '@/platform/randomUUID';
import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { t } from '@/text';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { readLocalServiceActionOutcome } from './localServiceActionOutcome';
import { executeLocalServiceActionWithAdmission, isLocalServiceActionAdmissionCurrent, readLocalServiceSetupConsentReview, useLocalServiceActionExecutor, type LocalServiceActionAdmission } from './localServiceActionAdmission';

/** History is a scoped presentation mutation, never a process lifecycle control. */
export function useLocalServiceLauncherHistoryClearAction(context: LocalServiceActionAdmission & Readonly<{
    runtimeActionExecute?: RuntimeActionExecute | null;
    machineId?: string | null;
    serverId?: string | null;
    sessionId?: string | null;
    scope?: 'workspace' | 'machine';
    workspaceRoot?: string | null;
    applyLauncherSnapshot?: (snapshot: LocalServiceLauncherSnapshot) => void;
}>): (() => Promise<unknown>) | undefined {
    const machineId = normalizeNonEmptyString(context.machineId);
    const serverId = normalizeNonEmptyString(context.serverId);
    const sessionId = normalizeNonEmptyString(context.sessionId);
    const scope = context.scope ?? 'workspace';
    return React.useMemo(() => {
        if (!context.runtimeActionExecute || !machineId || (scope === 'workspace' && !context.workspaceRoot && !sessionId)) return undefined;
        const request = DaemonLocalServiceLauncherLeafRequestV1Schema.parse({ machineId, scope,
            ...(sessionId ? { sessionId } : {}), ...(context.workspaceRoot ? { workspaceRoot: context.workspaceRoot } : {}),
        });
        return async () => {
            const result = await executeLocalServiceActionWithAdmission({ execute: context.runtimeActionExecute!, admission: context,
                request: { actionId: 'localServices.launcher.history.clear', input: request,
                    context: { surface: 'ui', ...(serverId ? { serverId } : {}) },
                },
            });
            const response = DaemonLocalServiceLauncherHistoryClearResponseV1Schema.safeParse(result);
            if (response.success && response.data.snapshot.machineId === request.machineId
                && (!request.sessionId || response.data.snapshot.sessionId === request.sessionId)
                && isLocalServiceActionAdmissionCurrent(context)) context.applyLauncherSnapshot?.(response.data.snapshot);
            return result;
        };
    }, [machineId, serverId, sessionId, scope, context.workspaceRoot, context.runtimeActionExecute, context.applyLauncherSnapshot,
        context.expectedAccountId, context.signal, context.isCurrent, context.onApprovalPending]);
}

function normalizeNonEmptyString(value: string | null | undefined): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

export function createLocalServiceActionRequestId(): string {
    return `local-service-action-request:${randomUUID()}`;
}

/** Detected processes retain their distinct owner and never acquire managed control authority. */
type InventoryEntryActionKind = Extract<LocalServiceActionKindV1, 'terminate_detected' | 'forget' | 'copy_url'>;

function readManagedServiceActionTarget(target: LocalServiceLaunchTarget) {
    if (target.source !== 'managed_service' || target.sourceClass?.kind !== 'managed_service') return undefined;
    const parsed = LocalServiceManagedServiceActionTargetV1Schema.safeParse({
        kind: 'managed_service',
        managedServiceId: target.sourceClass.managedServiceId,
        machineId: target.machineId,
        ...(target.sessionId ? { sessionId: target.sessionId } : {}),
        ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}),
        ...(target.cwd ? { cwd: target.cwd } : {}),
        ...(target.declaration ? { declaration: target.declaration } : {}),
    });
    return parsed.success ? parsed.data : undefined;
}

function isManagedServiceHomeCurrent(target: LocalServiceLaunchTarget, serverId: string | undefined): boolean {
    return !target.workspace || !serverId || areServerProfileIdentifiersEquivalent(target.workspace.serverId, serverId);
}

function buildManagedServiceActionRequest(input: Readonly<{
    target: LocalServiceLaunchTarget;
    action: Extract<LocalServiceActionKindV1, 'copy_url' | 'forget' | 'stop_managed' | 'restart_managed'>;
    requestId?: string;
}> & Pick<LocalServiceActionRequestV1, 'expectedEffectDigest' | 'choice'>): LocalServiceActionRequestV1 {
    const target = readManagedServiceActionTarget(input.target);
    if (!target) throw new Error('local_service_control_target_unavailable');
    const request: LocalServiceActionRequestV1 = {
        requestId: input.requestId ?? createLocalServiceActionRequestId(), target, action: input.action, force: false,
        ...(input.expectedEffectDigest ? { expectedEffectDigest: input.expectedEffectDigest } : {}),
        ...(input.choice ? { choice: input.choice } : {}),
    };
    return { ...request, confirmationNonce: createLocalServiceActionConfirmationNonceV1(request) };
}

function buildInventoryEntryActionRequest(input: Readonly<{
    inventoryEntryId: string;
    machineId: string;
    action: InventoryEntryActionKind;
    sessionId?: string | null;
    workspaceId?: string | null;
    requestId?: string;
}>): LocalServiceActionRequestV1 {
    const sessionId = normalizeNonEmptyString(input.sessionId);
    const workspaceId = normalizeNonEmptyString(input.workspaceId);
    const request: LocalServiceActionRequestV1 = {
        requestId: input.requestId ?? createLocalServiceActionRequestId(),
        target: {
            kind: 'inventory_entry',
            inventoryEntryId: input.inventoryEntryId,
            machineId: input.machineId,
            ...(sessionId ? { sessionId } : {}),
            ...(workspaceId ? { workspaceId } : {}),
        },
        action: input.action,
        force: false,
    };
    return {
        ...request,
        confirmationNonce: createLocalServiceActionConfirmationNonceV1(request),
    };
}

export function buildDetectedLocalServiceTerminateRequest(input: Readonly<{
    inventoryEntryId: string;
    machineId: string;
    sessionId?: string | null;
    workspaceId?: string | null;
    requestId?: string;
}>): LocalServiceActionRequestV1 {
    return buildInventoryEntryActionRequest({
        ...input,
        action: 'terminate_detected',
    });
}

export function buildDetectedLocalServiceForgetRequest(input: Readonly<{
    inventoryEntryId: string;
    machineId: string;
    sessionId?: string | null;
    workspaceId?: string | null;
    requestId?: string;
    undoKey?: string;
}>): LocalServiceActionRequestV1 {
    return {
        ...buildInventoryEntryActionRequest({
            ...input,
            inventoryEntryId: input.undoKey ?? input.inventoryEntryId,
            action: 'forget',
        }),
        ...(input.undoKey ? { undoKey: input.undoKey } : {}),
    };
}

export function buildLocalServiceCopyUrlRequest(input: Readonly<{
    inventoryEntryId: string;
    machineId: string;
    sessionId?: string | null;
    workspaceId?: string | null;
    requestId?: string;
}> | Readonly<{ target: LocalServiceLaunchTarget; requestId?: string }>): LocalServiceActionRequestV1 {
    if ('target' in input) return buildManagedServiceActionRequest({ ...input, action: 'copy_url' });
    return buildInventoryEntryActionRequest({
        ...input,
        action: 'copy_url',
    });
}

function readInventoryEntryIdFromTarget(target: LocalServiceLaunchTarget): string | undefined {
    if (target.sourceClass?.kind === 'inventory_entry') {
        return normalizeNonEmptyString(target.sourceClass.inventoryEntryId);
    }
    return undefined;
}

export type ManagedLocalServiceControlAction = (target: LocalServiceLaunchTarget,
    actionId: 'localServices.actions.stopManaged' | 'localServices.actions.restartManaged',
    options?: Pick<LocalServiceActionRequestV1, 'expectedEffectDigest' | 'choice'>) => Promise<unknown>;

/** Exact managed controls use the same published Actions and never optimistically settle custody. */
export function useManagedLocalServiceControlAction(context: Readonly<{
    runtimeActionExecute?: RuntimeActionExecute | null;
    machineId?: string | null;
    sessionId?: string | null;
    serverId?: string | null;
}> & LocalServiceActionAdmission): ManagedLocalServiceControlAction | undefined {
    const runtimeActionExecute = useLocalServiceActionExecutor(context);
    const sessionId = normalizeNonEmptyString(context.sessionId);
    const serverId = normalizeNonEmptyString(context.serverId);
    return React.useMemo<ManagedLocalServiceControlAction | undefined>(() => runtimeActionExecute ? async (target, actionId, options) => {
        if (!readManagedServiceActionTarget(target) || !isManagedServiceHomeCurrent(target, serverId)) return undefined;
        const actionServerId = target.workspace?.serverId ?? serverId;
        const action = resolveLocalServiceActionKindForRuntimeActionId(actionId);
        if (action !== 'stop_managed' && action !== 'restart_managed') return undefined;
        let request = buildManagedServiceActionRequest({ target, action, ...options });
        const dispatch = () => runtimeActionExecute({ actionId,
            input: request,
            context: { ...(sessionId ? { defaultSessionId: sessionId } : {}), ...(actionServerId ? { serverId: actionServerId } : {}), surface: 'ui' },
        });
        let result = await dispatch();
        while (actionId === 'localServices.actions.restartManaged' && isLocalServiceActionAdmissionCurrent(context)) {
            const review = LocalServiceActionResultV1Schema.safeParse(result);
            const matchingResponse = review.success && review.data.requestId === request.requestId && review.data.action === 'restart_managed'
                ? review.data : undefined;
            const consent = readLocalServiceSetupConsentReview(result, matchingResponse);
            if (consent && context.reviewSetupConsent) {
                const prepared = await context.reviewSetupConsent({ actionId, target, consent,
                    ...(context.signal ? { signal: context.signal } : {}) });
                if (!prepared || !isLocalServiceActionAdmissionCurrent(context)) break;
                result = await dispatch();
                continue;
            }
            if (!review.success || review.data.requestId !== request.requestId || review.data.action !== 'restart_managed'
                || review.data.status !== 'denied' || !['project_service_effect_review_required', 'project_service_effect_changed'].includes(review.data.reasonCode ?? '')
                || review.data.reviewedEffect === undefined || !review.data.reviewedEffectDigest || !context.reviewEffect) break;
            const accepted = await context.reviewEffect({ actionId, target, reviewedEffect: review.data.reviewedEffect,
                reviewedEffectDigest: review.data.reviewedEffectDigest, ...(context.signal ? { signal: context.signal } : {}) });
            if (!accepted || !isLocalServiceActionAdmissionCurrent(context)) break;
            request = buildManagedServiceActionRequest({ target, action, ...options, expectedEffectDigest: review.data.reviewedEffectDigest });
            result = await dispatch();
        }
        return result;
    } : undefined, [runtimeActionExecute, serverId, sessionId, context.reviewEffect, context.reviewSetupConsent, context.signal, context.isCurrent]);
}

export function useDetectedLocalServiceTerminateAction(
    context: Readonly<{
        runtimeActionExecute?: RuntimeActionExecute | null;
        machineId?: string | null;
        sessionId?: string | null;
        workspaceId?: string | null;
        serverId?: string | null;
    }> & LocalServiceActionAdmission,
): ((target: LocalServiceLaunchTarget) => Promise<unknown>) | undefined {
    const machineId = normalizeNonEmptyString(context.machineId);
    const sessionId = normalizeNonEmptyString(context.sessionId);
    const workspaceId = normalizeNonEmptyString(context.workspaceId);
    const serverId = normalizeNonEmptyString(context.serverId);
    const runtimeActionExecute = useLocalServiceActionExecutor(context);

    return React.useMemo(() => {
        if (!runtimeActionExecute || !machineId) {
            return undefined;
        }
        return async (target: LocalServiceLaunchTarget) => {
            if (target.source !== 'inventory_entry' || !target.actions.includes('terminate_detected')) {
                return undefined;
            }
            const inventoryEntryId = readInventoryEntryIdFromTarget(target);
            if (!inventoryEntryId) {
                return undefined;
            }
            return await runtimeActionExecute({
                actionId: 'localServices.actions.terminateDetected',
                input: buildDetectedLocalServiceTerminateRequest({
                    inventoryEntryId,
                    machineId,
                    sessionId: sessionId ?? target.sessionId,
                    workspaceId: workspaceId ?? target.workspaceId,
                }),
                context: {
                    ...(sessionId ? { defaultSessionId: sessionId } : {}),
                    ...(serverId ? { serverId } : {}),
                    surface: 'ui',
                },
            });
        };
    }, [machineId, runtimeActionExecute, serverId, sessionId, workspaceId]);
}

/**
 * Forget a detected service (G14).
 *
 * The daemon already owned this action end to end — policy, audit and a registry suppression —
 * with no way to reach it from the product. This is the missing affordance, not a second owner:
 * it dispatches the same audited runtime action an agent uses.
 */
export function useDetectedLocalServiceForgetAction(
    context: Readonly<{
        runtimeActionExecute?: RuntimeActionExecute | null;
        machineId?: string | null;
        sessionId?: string | null;
        workspaceId?: string | null;
        serverId?: string | null;
    }> & LocalServiceActionAdmission,
): ((target: LocalServiceLaunchTarget) => Promise<unknown>) | undefined {
    const machineId = normalizeNonEmptyString(context.machineId);
    const sessionId = normalizeNonEmptyString(context.sessionId);
    const workspaceId = normalizeNonEmptyString(context.workspaceId);
    const serverId = normalizeNonEmptyString(context.serverId);
    const runtimeActionExecute = useLocalServiceActionExecutor(context);

    return React.useMemo(() => {
        if (!runtimeActionExecute) {
            return undefined;
        }
        return async (target: LocalServiceLaunchTarget) => {
            const inventoryEntryId = readInventoryEntryIdFromTarget(target);
            const managed = readManagedServiceActionTarget(target);
            if (managed && !isManagedServiceHomeCurrent(target, serverId)) return undefined;
            const actionServerId = managed ? target.workspace?.serverId ?? serverId : serverId;
            if (!managed && (target.source !== 'inventory_entry' || !inventoryEntryId || !machineId)) {
                return undefined;
            }
            const request = {
                actionId: 'localServices.actions.forget',
                input: managed ? buildManagedServiceActionRequest({ target, action: 'forget' }) : buildDetectedLocalServiceForgetRequest({
                    inventoryEntryId: inventoryEntryId!,
                    machineId: machineId!,
                    sessionId: sessionId ?? target.sessionId,
                    workspaceId: workspaceId ?? target.workspaceId,
                }),
                context: {
                    ...(sessionId ? { defaultSessionId: sessionId } : {}),
                    ...(actionServerId ? { serverId: actionServerId } : {}),
                    surface: 'ui',
                },
            } satisfies Parameters<RuntimeActionExecute>[0];
            const result = await runtimeActionExecute(request);
            const parsed = LocalServiceActionResultV1Schema.safeParse(result);
            if (inventoryEntryId && machineId && parsed.success && parsed.data.status === 'succeeded' && parsed.data.undoKey) {
                const undoKey = parsed.data.undoKey;
                const noticeKey = `local-service-forget:${serverId ?? ''}:${machineId}:${undoKey}`;
                publishPresentationNotice({
                    key: noticeKey,
                    message: t('localServices.actions.hiddenNotice'),
                    severity: 'info',
                    undo: {
                        label: t('sessionBoard.companion.actions.undo'),
                        run: async () => {
                            let reasonCode: string | null = null;
                            let result: unknown;
                            try {
                                result = await runtimeActionExecute({
                                    ...request,
                                    input: buildDetectedLocalServiceForgetRequest({
                                        inventoryEntryId, machineId,
                                        sessionId: sessionId ?? target.sessionId,
                                        workspaceId: workspaceId ?? target.workspaceId,
                                        undoKey,
                                    }),
                                });
                                const receipt = LocalServiceActionResultV1Schema.safeParse(result);
                                if (receipt.success && receipt.data.status === 'succeeded') return result;
                                const outcome = readLocalServiceActionOutcome(result);
                                reasonCode = outcome.kind === 'failed' ? outcome.reasonCode : null;
                            } catch {
                                // Transport failure is visible through the same notice owner.
                            }
                            publishPresentationNotice({
                                key: `${noticeKey}:undo-failed`,
                                message: resolveReasonCopy({ reasonCode, kind: 'localServiceAction' }).body,
                                severity: 'error',
                            });
                            return result;
                        },
                    },
                });
            }
            return result;
        };
    }, [machineId, runtimeActionExecute, serverId, sessionId, workspaceId]);
}

/**
 * The single owner of "copy a local service URL" (G14, second half).
 *
 * The row's copy button used to write the clipboard directly while a policied, audited
 * `localServices.actions.copyUrl` existed for agents only — one concept with two owners, one of
 * them unaudited. Copying now goes through the audited action whenever the row has a target the
 * action layer can address, and only an unmanaged row the action cannot target (a package script, a terminal
 * URL, a recent entry) falls back to a direct write. That fallback is a capability this lane must
 * not subtract, and it is decided here rather than at the call site so there is still one owner.
 */
export function useLocalServiceCopyUrlAction(
    context: Readonly<{
        runtimeActionExecute?: RuntimeActionExecute | null;
        machineId?: string | null;
        sessionId?: string | null;
        workspaceId?: string | null;
        serverId?: string | null;
        copyToClipboard?: (value: string) => Promise<boolean>;
    }> & LocalServiceActionAdmission,
): (target: LocalServiceLaunchTarget, value: string) => Promise<boolean> {
    const machineId = normalizeNonEmptyString(context.machineId);
    const sessionId = normalizeNonEmptyString(context.sessionId);
    const workspaceId = normalizeNonEmptyString(context.workspaceId);
    const serverId = normalizeNonEmptyString(context.serverId);
    const runtimeActionExecute = useLocalServiceActionExecutor(context);
    const copyToClipboard = context.copyToClipboard ?? setClipboardStringSafe;

    return React.useCallback(async (target: LocalServiceLaunchTarget, value: string) => {
        const inventoryEntryId = readInventoryEntryIdFromTarget(target);
        const managed = readManagedServiceActionTarget(target);
        // A malformed or temporarily unreachable managed target must not gain
        // an unaudited clipboard path merely because its Action port is missing.
        if (target.source === 'managed_service' && (!managed || !runtimeActionExecute || !isManagedServiceHomeCurrent(target, serverId))) return false;
        const actionServerId = managed ? target.workspace?.serverId ?? serverId : serverId;
        const dispatchable = Boolean(runtimeActionExecute)
            && (Boolean(managed) || (Boolean(machineId) && target.source === 'inventory_entry' && Boolean(inventoryEntryId)));
        if (!dispatchable) {
            return await copyToClipboard(value);
        }
        const result = await runtimeActionExecute!({
            actionId: 'localServices.actions.copyUrl',
            input: managed ? buildLocalServiceCopyUrlRequest({ target }) : buildLocalServiceCopyUrlRequest({
                inventoryEntryId: inventoryEntryId!,
                machineId: machineId!,
                sessionId: sessionId ?? target.sessionId,
                workspaceId: workspaceId ?? target.workspaceId,
            }),
            context: {
                ...(sessionId ? { defaultSessionId: sessionId } : {}),
                ...(actionServerId ? { serverId: actionServerId } : {}),
                surface: 'ui',
            },
        });
        const parsed = LocalServiceActionResultV1Schema.safeParse(result);
        // A denied or unparseable result is a real refusal: the clipboard stays untouched rather
        // than routing around the policy the action exists to enforce.
        if (!parsed.success || parsed.data.status !== 'succeeded') {
            return false;
        }
        return await copyToClipboard(value);
    }, [copyToClipboard, machineId, runtimeActionExecute, serverId, sessionId, workspaceId]);
}
