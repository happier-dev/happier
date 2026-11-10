import type {
    LocalServiceActionAuditEventV1,
    LocalServiceActionRequestV1,
    LocalServiceActionResultV1,
} from '@happier-dev/protocol';

import {
    executeLocalServiceAction,
    type ResolvedLocalServiceActionTarget,
    type LocalServiceActionExecutionContext,
    type RestartProjectManagedService,
    type LocalServiceActionExecutionOutcome,
} from './executor';
import { resolveLocalServiceActionEligibility } from './policy';
import { selectVisibleMachineProjectServices } from '../launch/machineServiceDisclosure';
import type { TerminateDetectedService } from './terminate';
import type { LocalServiceInventoryRegistry } from '../inventory/registry';
import type { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import type { LocalServiceLauncherHistoryStore } from '../launch/leaves';

type ManagedServicesOwner = ReturnType<typeof createManagedServicesOwner>;

export type LocalServiceActionRoutes = Readonly<{
    execute(request: LocalServiceActionRequestV1, execution?: LocalServiceActionExecutionContext): Promise<LocalServiceActionResultV1>;
}>;

function createAuditEvent(input: Readonly<{
    eventIndex: number;
    request: LocalServiceActionRequestV1;
    result: LocalServiceActionAuditEventV1['result'];
    reasonCode?: string;
    recordedAt: number;
}>): LocalServiceActionAuditEventV1 {
    return {
        v: 1,
        eventId: `${input.request.requestId}:${input.eventIndex}:${input.result}`,
        requestId: input.request.requestId,
        machineId: input.request.target.machineId,
        action: input.request.action,
        result: input.result,
        ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
        recordedAt: input.recordedAt,
    };
}

function deniedResult(input: Readonly<{
    request: LocalServiceActionRequestV1;
    reasonCode: string;
    requestedAt: number;
}>): LocalServiceActionResultV1 {
    return executionResult({
        request: input.request,
        status: 'denied',
        reasonCode: input.reasonCode,
        requestedAt: input.requestedAt,
        confirmed: false,
    });
}

function executionResult(input: Readonly<{
    request: LocalServiceActionRequestV1;
    status: LocalServiceActionResultV1['status'];
    requestedAt: number;
    reasonCode?: string;
    undoKey?: string;
    confirmed: boolean;
    review?: Extract<LocalServiceActionExecutionOutcome, { reasonCode: string }>;
}>): LocalServiceActionResultV1 {
    const auditEvents = [
        createAuditEvent({
            eventIndex: 0,
            request: input.request,
            result: 'requested',
            recordedAt: input.requestedAt,
        }),
    ];
    if (input.confirmed) {
        auditEvents.push(createAuditEvent({
            eventIndex: auditEvents.length,
            request: input.request,
            result: 'confirmed',
            recordedAt: input.requestedAt,
        }));
    }
    auditEvents.push(createAuditEvent({
        eventIndex: auditEvents.length,
        request: input.request,
        result: input.status,
        ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
        recordedAt: input.requestedAt,
    }));
    return {
        v: 1,
        requestId: input.request.requestId,
        action: input.request.action,
        status: input.status,
        ...(input.undoKey ? { undoKey: input.undoKey } : {}),
        ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
        auditEvents,
        ...(input.review?.reviewedEffect !== undefined ? { reviewedEffect: input.review.reviewedEffect } : {}),
        ...(input.review?.reviewedEffectDigest ? { reviewedEffectDigest: input.review.reviewedEffectDigest } : {}),
    };
}

async function resolveActionTarget(input: Readonly<{
    request: LocalServiceActionRequestV1;
    machineId: string;
    inventoryRegistry: LocalServiceInventoryRegistry;
    projectManagedServices?: Pick<ManagedServicesOwner, 'resolveProjectService'>;
    execution?: LocalServiceActionExecutionContext;
}>): Promise<ResolvedLocalServiceActionTarget | Readonly<{ kind: 'undo_forget'; undoKey: string }> | Readonly<{ reasonCode: string }>> {
    const target = input.request.target;
    if (target.machineId !== input.machineId) {
        return { reasonCode: 'wrong_machine' };
    }
    const admission = input.execution?.ingress?.machineAdmission;
    const requesterOnly = admission?.role === 'use' && admission.actorAccountId !== admission.custodianAccountId;
    if (requesterOnly && target.kind === 'inventory_entry') return { reasonCode: 'unknown_inventory_entry' };
    if (input.request.undoKey) {
        if (input.request.action !== 'forget' || target.kind !== 'inventory_entry'
            || target.inventoryEntryId !== input.request.undoKey) return { reasonCode: 'wrong_target_kind' };
        return { kind: 'undo_forget', undoKey: input.request.undoKey };
    }
    if (target.kind === 'inventory_entry') {
        const entry = input.inventoryRegistry.getSnapshot().entries.find((candidate) => (
            candidate.id === target.inventoryEntryId
            && candidate.machineId === input.machineId
        ));
        return entry
            ? { kind: 'inventory_entry', entry }
            : { reasonCode: 'unknown_inventory_entry' };
    }

    const resolved = input.projectManagedServices?.resolveProjectService(target);
    if (resolved?.status !== 'found') return {
        reasonCode: resolved?.status === 'mismatch' ? 'managed_service_target_mismatch' : 'unknown_managed_service',
    };
    const handle = resolved.handle;
    if (requesterOnly) {
        const serverId = input.execution?.actionContext.serverId;
        const visible = serverId ? await selectVisibleMachineProjectServices({ serverId, machineId: input.machineId },
            [handle], { requesterAccountId: admission.actorAccountId, context: input.execution?.actionContext }) : [];
        if (!visible.length) return { reasonCode: 'unknown_managed_service' };
    }
    return { kind: 'managed_service', handle };
}

export function createLocalServiceActionRoutes(input: Readonly<{
    machineId: string;
    inventoryRegistry: LocalServiceInventoryRegistry;
    projectManagedServices?: Pick<ManagedServicesOwner, 'resolveProjectService'>;
    launcherHistory?: LocalServiceLauncherHistoryStore;
    restartManagedService?: RestartProjectManagedService;
    terminateEnabled?: () => boolean;
    verifyConfirmationNonce?: (request: LocalServiceActionRequestV1) => boolean;
    terminateDetectedService?: TerminateDetectedService;
    now?: () => number;
}>): LocalServiceActionRoutes {
    const now = input.now ?? (() => Date.now());
    return {
        async execute(request, execution) {
            const requestedAt = now();
            const target = await resolveActionTarget({
                request,
                machineId: input.machineId,
                inventoryRegistry: input.inventoryRegistry,
                projectManagedServices: input.projectManagedServices,
                execution,
            });
            if ('reasonCode' in target) {
                return deniedResult({ request, requestedAt, reasonCode: target.reasonCode });
            }
            if (target.kind === 'undo_forget') {
                const restored = input.inventoryRegistry.undoForget(target.undoKey);
                return executionResult({
                    request,
                    requestedAt,
                    confirmed: false,
                    status: restored.ok ? 'succeeded' : 'denied',
                    ...(!restored.ok ? { reasonCode: restored.reason } : {}),
                });
            }

            const decision = resolveLocalServiceActionEligibility({
                action: request.action,
                target,
                terminateEnabled: input.terminateEnabled?.() === true,
                restartAdmitted: Boolean(input.restartManagedService && execution?.ingress && execution.prepareStartAction),
            });
            if (!decision.enabled) {
                return deniedResult({
                    request,
                    requestedAt,
                    reasonCode: decision.reasonCode ?? 'action_not_allowed',
                });
            }

            if (decision.requiresConfirmation && !request.confirmationNonce) {
                return deniedResult({
                    request,
                    requestedAt,
                    reasonCode: 'confirmation_required',
                });
            }
            if (decision.requiresConfirmation && input.verifyConfirmationNonce?.(request) !== true) {
                return deniedResult({
                    request,
                    requestedAt,
                    reasonCode: 'confirmation_nonce_invalid',
                });
            }

            const outcome = await executeLocalServiceAction({
                request,
                target,
                inventoryRegistry: input.inventoryRegistry,
                terminateDetectedService: input.terminateDetectedService,
                launcherHistory: input.launcherHistory,
                restartManagedService: input.restartManagedService,
                execution,
                now: requestedAt,
            });
            return executionResult({
                request,
                status: outcome.status,
                ...(outcome.status === 'succeeded' ? {} : { reasonCode: outcome.reasonCode, review: outcome }),
                ...(outcome.status === 'succeeded' && outcome.undoKey ? { undoKey: outcome.undoKey } : {}),
                requestedAt,
                confirmed: decision.requiresConfirmation,
            });
        },
    };
}
