import * as React from 'react';

import {
    createLocalServiceActionConfirmationNonceV1,
    type LocalServiceActionKindV1,
    type LocalServiceActionRequestV1,
    type RuntimeActionExecute,
} from '@happier-dev/protocol';

import type { ManagedLocalServiceRow } from '@/sync/domains/local/services/managed/store';
import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';
import { randomUUID } from '@/platform/randomUUID';

function normalizeNonEmptyString(value: string | null | undefined): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

export function createLocalServiceActionRequestId(): string {
    return `local-service-action-request:${randomUUID()}`;
}

function buildManagedLocalServiceActionRequest(input: Readonly<{
    row: ManagedLocalServiceRow;
    machineId: string;
    action: Extract<LocalServiceActionKindV1, 'stop_managed' | 'restart_managed'>;
    sessionId?: string | null;
    workspaceId?: string | null;
    requestId?: string;
}>): LocalServiceActionRequestV1 {
    const sessionId = normalizeNonEmptyString(input.sessionId);
    const workspaceId = normalizeNonEmptyString(input.workspaceId);
    const target: LocalServiceActionRequestV1['target'] = {
        kind: 'managed_service',
        managedServiceId: input.row.id,
        machineId: input.machineId,
        ...(sessionId ? { sessionId } : {}),
        ...(workspaceId ? { workspaceId } : {}),
    };
    const request: LocalServiceActionRequestV1 = {
        requestId: input.requestId ?? createLocalServiceActionRequestId(),
        target,
        action: input.action,
        force: false,
    };
    return {
        ...request,
        confirmationNonce: createLocalServiceActionConfirmationNonceV1(request),
    };
}

function buildInventoryEntryActionRequest(input: Readonly<{
    inventoryEntryId: string;
    machineId: string;
    action: Extract<LocalServiceActionKindV1, 'terminate_detected'>;
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

export function buildManagedLocalServiceStopRequest(input: Readonly<{
    row: ManagedLocalServiceRow;
    machineId: string;
    sessionId?: string | null;
    workspaceId?: string | null;
    requestId?: string;
}>): LocalServiceActionRequestV1 {
    return buildManagedLocalServiceActionRequest({
        ...input,
        action: 'stop_managed',
    });
}

export function buildManagedLocalServiceRestartRequest(input: Readonly<{
    row: ManagedLocalServiceRow;
    machineId: string;
    sessionId?: string | null;
    workspaceId?: string | null;
    requestId?: string;
}>): LocalServiceActionRequestV1 {
    return buildManagedLocalServiceActionRequest({
        ...input,
        action: 'restart_managed',
    });
}

function useManagedLocalServiceAction(
    context: Readonly<{
        runtimeActionExecute?: RuntimeActionExecute | null;
        machineId?: string | null;
        sessionId?: string | null;
        workspaceId?: string | null;
        serverId?: string | null;
        action: Extract<LocalServiceActionKindV1, 'stop_managed' | 'restart_managed'>;
        actionId: 'localServices.actions.stopManaged' | 'localServices.actions.restartManaged';
    }>,
): ((row: ManagedLocalServiceRow) => Promise<unknown>) | undefined {
    const machineId = normalizeNonEmptyString(context.machineId);
    const sessionId = normalizeNonEmptyString(context.sessionId);
    const workspaceId = normalizeNonEmptyString(context.workspaceId);
    const serverId = normalizeNonEmptyString(context.serverId);
    const runtimeActionExecute = context.runtimeActionExecute ?? undefined;

    return React.useMemo(() => {
        if (!runtimeActionExecute || !machineId) {
            return undefined;
        }
        return async (row: ManagedLocalServiceRow) => {
            if (row.phase !== 'running' || !row.supportedActions.includes(context.action)) {
                return undefined;
            }
            return await runtimeActionExecute({
                actionId: context.actionId,
                input: buildManagedLocalServiceActionRequest({
                    row,
                    machineId,
                    sessionId,
                    workspaceId,
                    action: context.action,
                }),
                context: {
                    ...(sessionId ? { defaultSessionId: sessionId } : {}),
                    ...(serverId ? { serverId } : {}),
                    surface: 'ui',
                },
            });
        };
    }, [context.action, context.actionId, machineId, runtimeActionExecute, serverId, sessionId, workspaceId]);
}

export function useManagedLocalServiceStopAction(
    context: Readonly<{
        runtimeActionExecute?: RuntimeActionExecute | null;
        machineId?: string | null;
        sessionId?: string | null;
        workspaceId?: string | null;
        serverId?: string | null;
    }>,
): ((row: ManagedLocalServiceRow) => Promise<unknown>) | undefined {
    return useManagedLocalServiceAction({
        ...context,
        action: 'stop_managed',
        actionId: 'localServices.actions.stopManaged',
    });
}

export function useManagedLocalServiceRestartAction(
    context: Readonly<{
        runtimeActionExecute?: RuntimeActionExecute | null;
        machineId?: string | null;
        sessionId?: string | null;
        workspaceId?: string | null;
        serverId?: string | null;
    }>,
): ((row: ManagedLocalServiceRow) => Promise<unknown>) | undefined {
    return useManagedLocalServiceAction({
        ...context,
        action: 'restart_managed',
        actionId: 'localServices.actions.restartManaged',
    });
}

function readInventoryEntryIdFromTarget(target: LocalServiceLaunchTarget): string | undefined {
    if (target.sourceClass?.kind === 'inventory_entry') {
        return normalizeNonEmptyString(target.sourceClass.inventoryEntryId);
    }
    if (target.id.startsWith('inventory:')) {
        return normalizeNonEmptyString(target.id.slice('inventory:'.length));
    }
    return undefined;
}

export function useDetectedLocalServiceTerminateAction(
    context: Readonly<{
        runtimeActionExecute?: RuntimeActionExecute | null;
        machineId?: string | null;
        sessionId?: string | null;
        workspaceId?: string | null;
        serverId?: string | null;
    }>,
): ((target: LocalServiceLaunchTarget) => Promise<unknown>) | undefined {
    const machineId = normalizeNonEmptyString(context.machineId);
    const sessionId = normalizeNonEmptyString(context.sessionId);
    const workspaceId = normalizeNonEmptyString(context.workspaceId);
    const serverId = normalizeNonEmptyString(context.serverId);
    const runtimeActionExecute = context.runtimeActionExecute ?? undefined;

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
