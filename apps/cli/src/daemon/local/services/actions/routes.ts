import type {
    LocalServiceActionAuditEventV1,
    LocalServiceActionRequestV1,
    LocalServiceActionResultV1,
} from '@happier-dev/protocol';

import {
    executeLocalServiceAction,
    type RestartManagedLocalService,
    type ResolvedLocalServiceActionTarget,
    type StopManagedLocalService,
} from './executor';
import { resolveLocalServiceActionEligibility } from './policy';
import type { TerminateDetectedService } from './terminate';
import type { LocalServiceInventoryRegistry } from '../inventory/registry';
import type {
    ManagedLocalServiceRegistry,
    ManagedLocalServiceRuntimeState,
} from '../managed/registry';

export type LocalServiceActionRoutes = Readonly<{
    execute(request: LocalServiceActionRequestV1): Promise<LocalServiceActionResultV1>;
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
    confirmed: boolean;
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
        ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
        auditEvents,
    };
}

function resolveActionTarget(input: Readonly<{
    request: LocalServiceActionRequestV1;
    machineId: string;
    inventoryRegistry: LocalServiceInventoryRegistry;
    managedRegistry: ManagedLocalServiceRegistry;
}>): ResolvedLocalServiceActionTarget | Readonly<{ reasonCode: string }> {
    const target = input.request.target;
    if (target.machineId !== input.machineId) {
        return { reasonCode: 'wrong_machine' };
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

    const service = input.managedRegistry.getService(target.managedServiceId);
    return service
        ? { kind: 'managed_service', service }
        : { reasonCode: 'unknown_managed_service' };
}

export function createLocalServiceActionRoutes(input: Readonly<{
    machineId: string;
    inventoryRegistry: LocalServiceInventoryRegistry;
    managedRegistry: ManagedLocalServiceRegistry;
    terminateEnabled?: () => boolean;
    managedStopEnabled?: () => boolean;
    managedRestartEnabled?: (service: ManagedLocalServiceRuntimeState) => boolean;
    verifyConfirmationNonce?: (request: LocalServiceActionRequestV1) => boolean;
    stopManagedService?: StopManagedLocalService;
    restartManagedService?: RestartManagedLocalService;
    terminateDetectedService?: TerminateDetectedService;
    now?: () => number;
}>): LocalServiceActionRoutes {
    const now = input.now ?? (() => Date.now());
    return {
        async execute(request) {
            const requestedAt = now();
            const target = resolveActionTarget({
                request,
                machineId: input.machineId,
                inventoryRegistry: input.inventoryRegistry,
                managedRegistry: input.managedRegistry,
            });
            if ('reasonCode' in target) {
                return deniedResult({ request, requestedAt, reasonCode: target.reasonCode });
            }

            const decision = resolveLocalServiceActionEligibility({
                action: request.action,
                target,
                terminateEnabled: input.terminateEnabled?.() === true,
                managedStopEnabled: input.managedStopEnabled?.() === true,
                managedRestartEnabled: target.kind === 'managed_service'
                    && input.managedRestartEnabled?.(target.service) === true,
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
                managedRegistry: input.managedRegistry,
                stopManagedService: input.stopManagedService,
                restartManagedService: input.restartManagedService,
                terminateDetectedService: input.terminateDetectedService,
                now: requestedAt,
            });
            return executionResult({
                request,
                status: outcome.status,
                ...(outcome.status === 'succeeded' ? {} : { reasonCode: outcome.reasonCode }),
                requestedAt,
                confirmed: decision.requiresConfirmation,
            });
        },
    };
}
