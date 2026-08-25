import * as React from 'react';

import {
    createLocalServiceActionConfirmationNonceV1,
    LocalServiceActionResultV1Schema,
    type LocalServiceActionKindV1,
    type LocalServiceActionRequestV1,
    type RuntimeActionExecute,
} from '@happier-dev/protocol';

import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';
import { randomUUID } from '@/platform/randomUUID';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';

function normalizeNonEmptyString(value: string | null | undefined): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

export function createLocalServiceActionRequestId(): string {
    return `local-service-action-request:${randomUUID()}`;
}

/**
 * The action kinds an `inventory_entry` target accepts. This is the only target arm the
 * daemon can resolve: the `managed_service` arm and its `stop_managed`/`restart_managed`
 * kinds addressed a runtime that was removed with its producerless registry (RU2 surfaces
 * finalization, DEC-6).
 */
type InventoryEntryActionKind = Extract<LocalServiceActionKindV1, 'terminate_detected' | 'forget' | 'copy_url'>;

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
}>): LocalServiceActionRequestV1 {
    return buildInventoryEntryActionRequest({
        ...input,
        action: 'forget',
    });
}

export function buildLocalServiceCopyUrlRequest(input: Readonly<{
    inventoryEntryId: string;
    machineId: string;
    sessionId?: string | null;
    workspaceId?: string | null;
    requestId?: string;
}>): LocalServiceActionRequestV1 {
    return buildInventoryEntryActionRequest({
        ...input,
        action: 'copy_url',
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
            const inventoryEntryId = readInventoryEntryIdFromTarget(target);
            if (target.source !== 'inventory_entry' || !inventoryEntryId) {
                return undefined;
            }
            return await runtimeActionExecute({
                actionId: 'localServices.actions.forget',
                input: buildDetectedLocalServiceForgetRequest({
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
 * The single owner of "copy a local service URL" (G14, second half).
 *
 * The row's copy button used to write the clipboard directly while a policied, audited
 * `localServices.actions.copyUrl` existed for agents only — one concept with two owners, one of
 * them unaudited. Copying now goes through the audited action whenever the row has a target the
 * action layer can address, and only a row the action cannot target (a package script, a terminal
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
    }>,
): (target: LocalServiceLaunchTarget, value: string) => Promise<boolean> {
    const machineId = normalizeNonEmptyString(context.machineId);
    const sessionId = normalizeNonEmptyString(context.sessionId);
    const workspaceId = normalizeNonEmptyString(context.workspaceId);
    const serverId = normalizeNonEmptyString(context.serverId);
    const runtimeActionExecute = context.runtimeActionExecute ?? undefined;
    const copyToClipboard = context.copyToClipboard ?? setClipboardStringSafe;

    return React.useCallback(async (target: LocalServiceLaunchTarget, value: string) => {
        const inventoryEntryId = readInventoryEntryIdFromTarget(target);
        const dispatchable = Boolean(runtimeActionExecute)
            && Boolean(machineId)
            && target.source === 'inventory_entry'
            && Boolean(inventoryEntryId);
        if (!dispatchable) {
            return await copyToClipboard(value);
        }
        const result = await runtimeActionExecute!({
            actionId: 'localServices.actions.copyUrl',
            input: buildLocalServiceCopyUrlRequest({
                inventoryEntryId: inventoryEntryId!,
                machineId: machineId!,
                sessionId: sessionId ?? target.sessionId,
                workspaceId: workspaceId ?? target.workspaceId,
            }),
            context: {
                ...(sessionId ? { defaultSessionId: sessionId } : {}),
                ...(serverId ? { serverId } : {}),
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
