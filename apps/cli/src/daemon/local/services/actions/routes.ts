import type {
    LocalServiceActionAuditEventV1,
    LocalServiceActionRequestV1,
    LocalServiceActionResultV1,
} from '@happier-dev/protocol';
import { LocalServiceCopyUrlResultV1Schema } from '@happier-dev/protocol/local/services/actions/v1';
import { buildLocalServiceDeclarationPreviewLandingUrlV1 } from '@happier-dev/protocol/local/services/preview/v1';
import { configuration } from '@/configuration';

import {
    executeLocalServiceAction,
    type ResolvedLocalServiceActionTarget,
    type LocalServiceActionExecutionContext,
    type RestartProjectManagedService,
    type PrepareRestartProjectManagedService,
    type LocalServiceActionExecutionOutcome,
} from './executor';
import { resolveLocalServiceActionEligibility } from './policy';
import { selectVisibleMachineProjectServices } from '../launch/machineServiceDisclosure';
import type { TerminateDetectedService } from './terminate';
import type { LocalServiceInventoryRegistry } from '../inventory/registry';
import { buildLocalServicePreviewBrowserTarget, listLocalServicePreviewResources,
    selectLocalServicePreviewForInventoryEntry, type LocalServicePreviewRegistry } from '../preview/registry';
import type { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import type { LocalServiceLauncherHistoryStore } from '../launch/leaves';
import type { HostReviewedChildrenPreparationV1 } from '@happier-dev/protocol/actions/executor/types';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

type ManagedServicesOwner = ReturnType<typeof createManagedServicesOwner>;
type AdmittedLocalServiceAction = Readonly<{ request: LocalServiceActionRequestV1; requestedAt: number;
    target: ResolvedLocalServiceActionTarget; requiresConfirmation: boolean }>;

export type LocalServiceActionRoutes = Readonly<{
    execute(request: LocalServiceActionRequestV1, execution?: LocalServiceActionExecutionContext): Promise<LocalServiceActionResultV1>;
    prepareRestart(request: LocalServiceActionRequestV1, execution: LocalServiceActionExecutionContext): Promise<HostReviewedChildrenPreparationV1 | ActionExecuteResult>;
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
    projectManagedServices?: Pick<ManagedServicesOwner, 'resolveProjectService'> & Partial<Pick<ManagedServicesOwner, 'restoreProjectServices'>>;
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

    await input.projectManagedServices?.restoreProjectServices?.();
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
    accountId?: string;
    inventoryRegistry: LocalServiceInventoryRegistry;
    previewRegistry?: LocalServicePreviewRegistry;
    projectManagedServices?: Pick<ManagedServicesOwner, 'resolveProjectService'> & Partial<Pick<ManagedServicesOwner, 'restoreProjectServices'>>;
    launcherHistory?: LocalServiceLauncherHistoryStore;
    restartManagedService?: RestartProjectManagedService;
    prepareRestartManagedService?: PrepareRestartProjectManagedService;
    terminateEnabled?: () => boolean;
    verifyConfirmationNonce?: (request: LocalServiceActionRequestV1) => boolean;
    terminateDetectedService?: TerminateDetectedService;
    now?: () => number;
}>): LocalServiceActionRoutes {
    const now = input.now ?? (() => Date.now());
    async function admit(
        request: LocalServiceActionRequestV1,
        execution?: LocalServiceActionExecutionContext,
        confirmation: 'transport' | 'action_review' = 'transport',
    ): Promise<AdmittedLocalServiceAction | Readonly<{ result: LocalServiceActionResultV1 }>> {
        const requestedAt = now();
        const target = await resolveActionTarget({
            request,
            machineId: input.machineId,
            inventoryRegistry: input.inventoryRegistry,
            projectManagedServices: input.projectManagedServices,
            execution,
        });
        if ('reasonCode' in target) {
            return { result: deniedResult({ request, requestedAt, reasonCode: target.reasonCode }) };
        }
        if (target.kind === 'undo_forget') {
            const restored = input.inventoryRegistry.undoForget(target.undoKey);
            return { result: executionResult({
                request,
                requestedAt,
                confirmed: false,
                status: restored.ok ? 'succeeded' : 'denied',
                ...(!restored.ok ? { reasonCode: restored.reason } : {}),
            }) };
        }

        const decision = resolveLocalServiceActionEligibility({
            action: request.action,
            target,
            terminateEnabled: input.terminateEnabled?.() === true,
            restartAdmitted: Boolean(input.restartManagedService && input.prepareRestartManagedService && execution?.ingress),
        });
        if (!decision.enabled) {
            return { result: deniedResult({
                request,
                requestedAt,
                reasonCode: decision.reasonCode ?? 'action_not_allowed',
            }) };
        }

        if (decision.requiresConfirmation && !request.confirmationNonce && confirmation === 'transport') {
            return { result: deniedResult({
                request,
                requestedAt,
                reasonCode: 'confirmation_required',
            }) };
        }
        if (decision.requiresConfirmation && request.confirmationNonce && input.verifyConfirmationNonce?.(request) !== true) {
            return { result: deniedResult({
                request,
                requestedAt,
                reasonCode: 'confirmation_nonce_invalid',
            }) };
        }
        return { request, requestedAt, target, requiresConfirmation: decision.requiresConfirmation };
    }
    async function executeAdmitted(admitted: AdmittedLocalServiceAction, execution?: LocalServiceActionExecutionContext) {
        const { request, requestedAt, target } = admitted;
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
        const receipt = executionResult({
            request,
            status: outcome.status,
            ...(outcome.status === 'succeeded' ? {} : { reasonCode: outcome.reasonCode, review: outcome }),
            ...(outcome.status === 'succeeded' && outcome.undoKey ? { undoKey: outcome.undoKey } : {}),
            requestedAt,
            confirmed: admitted.requiresConfirmation,
        });
        if (request.action !== 'copy_url' || outcome.status !== 'succeeded' || execution?.actionContext.surface !== 'cli') {
            return receipt;
        }
        // The Action already admitted this exact occurrence. The launcher feed
        // can hide or refresh rows independently of the stable declaration URL.
        const context = execution.actionContext;
        const destination = target.kind === 'managed_service' && target.handle.kind === 'workspace'
            ? { serverId: target.handle.workspace.serverId, machineId: target.handle.workspace.machineId, targetId: target.handle.serviceId }
            : null;
        const previews = !destination && input.previewRegistry ? listLocalServicePreviewResources(input.previewRegistry) : [];
        const preview = target.kind === 'inventory_entry'
            ? target.entry.state === 'listening' ? selectLocalServicePreviewForInventoryEntry(previews, target.entry,
                execution.ingress?.machineAdmission?.actorAccountId ?? context.runtimeAccountId ?? input.accountId) : undefined
            : previews.findLast(resource => resource.machineId === input.machineId
                && resource.serviceTarget?.managedServiceId === target.handle.instanceId);
        const browserTarget = preview ? buildLocalServicePreviewBrowserTarget(preview) : undefined;
        const locator = destination ?? (browserTarget ? { serverId: context.serverId ?? configuration.activeServerId,
            machineId: browserTarget.machineId, targetId: browserTarget.targetId } : null);
        const destinationUrl = locator && buildLocalServiceDeclarationPreviewLandingUrlV1(configuration.webappUrl, locator);
        return destinationUrl ? LocalServiceCopyUrlResultV1Schema.parse({ ...receipt, destinationUrl })
            : deniedResult({ request, requestedAt, reasonCode: 'local_service_destination_unavailable' });
    }
    return {
        async execute(request, execution) {
            const admitted = await admit(request, execution);
            return 'result' in admitted ? admitted.result : await executeAdmitted(admitted, execution);
        },
        async prepareRestart(request, execution) {
            const settled = (result: LocalServiceActionResultV1): ActionExecuteResult => ({ ok: true, result });
            // This only prepares the replacement. The Action executor owns consent
            // before it invokes the admitted effect returned below.
            const admitted = await admit(request, execution, 'action_review');
            if ('result' in admitted) return settled(admitted.result);
            if (request.action !== 'restart_managed' || admitted.target.kind !== 'managed_service'
                || admitted.target.handle.kind !== 'workspace' || !input.prepareRestartManagedService)
                return settled(deniedResult({ request, requestedAt: admitted.requestedAt, reasonCode: 'managed_service_restart_admission_required' }));
            const prepared = await input.prepareRestartManagedService(request, admitted.target.handle, execution);
            if ('status' in prepared) return settled(executionResult({ request, requestedAt: admitted.requestedAt,
                confirmed: admitted.requiresConfirmation, status: prepared.status,
                ...(prepared.status === 'succeeded' ? {} : { reasonCode: prepared.reasonCode, review: prepared }) }));
            return { ...prepared, executeAdmittedAction: async ({ context }) => ({ ok: true,
                result: await executeAdmitted(admitted, { ...execution, actionContext: context }) }) };
        },
    };
}
