import type { LocalServiceActionRequestV1, DaemonLocalServiceLauncherStartRequestV1, RuntimeActionExecuteArgs } from '@happier-dev/protocol';
import type { ActionPrepareResult } from '@happier-dev/protocol/actions/executor/types';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { RpcHandlerContext } from '@/api/rpc/types';

import type { LocalServiceInventoryRegistry } from '../inventory/registry';
import type { NormalizedLocalServiceInventoryEntry } from '../inventory/scanner';
import type { TerminateDetectedService } from './terminate';
import type { ProjectManagedServiceHandle } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import type { LocalServiceLauncherHistoryStore } from '../launch/leaves';

export type ResolvedLocalServiceActionTarget =
    Readonly<{ kind: 'inventory_entry'; entry: NormalizedLocalServiceInventoryEntry }>
    | Readonly<{ kind: 'managed_service'; handle: ProjectManagedServiceHandle }>;

export type LocalServiceActionExecutionOutcome =
    | Readonly<{ status: 'succeeded'; undoKey?: string }>
    | Readonly<{ status: 'denied' | 'failed'; reasonCode: string; reviewedEffect?: JsonValue; reviewedEffectDigest?: string }>;

export type LocalServiceActionExecutionContext = Readonly<{
    ingress?: RpcHandlerContext;
    actionContext: RuntimeActionExecuteArgs['context'];
    prepareStartAction?: (request: DaemonLocalServiceLauncherStartRequestV1, context: RuntimeActionExecuteArgs['context']) => Promise<ActionPrepareResult>;
}>;
export type RestartProjectManagedService = (request: LocalServiceActionRequestV1, handle: ProjectManagedServiceHandle,
    context: LocalServiceActionExecutionContext) => Promise<LocalServiceActionExecutionOutcome>;

/** Exact retained-resource cleanup; serving/new-effect admission is a separate contract. */
export async function stopProjectManagedService(handle: ProjectManagedServiceHandle, signal?: AbortSignal): Promise<LocalServiceActionExecutionOutcome> {
    try {
        const stopped = await handle.stop(signal ? { signal } : undefined);
        return stopped.status === 'stopped' ? { status: 'succeeded' }
            : { status: 'denied', reasonCode: 'managed_service_stop_unconfirmed' };
    } catch (error) {
        return { status: 'failed', reasonCode: error instanceof Error && 'code' in error && typeof error.code === 'string'
            ? error.code : 'managed_service_stop_unconfirmed' };
    }
}

export async function executeLocalServiceAction(input: Readonly<{
    request: LocalServiceActionRequestV1;
    target: ResolvedLocalServiceActionTarget;
    inventoryRegistry: LocalServiceInventoryRegistry;
    launcherHistory?: LocalServiceLauncherHistoryStore;
    terminateDetectedService?: TerminateDetectedService;
    restartManagedService?: RestartProjectManagedService;
    execution?: LocalServiceActionExecutionContext;
    now: number;
}>): Promise<LocalServiceActionExecutionOutcome> {
    switch (input.request.action) {
        case 'copy_url':
        case 'open_preview':
            return { status: 'succeeded' };
        case 'forget': {
            if (input.target.kind === 'managed_service') {
                if (!input.launcherHistory) return { status: 'denied', reasonCode: 'launcher_history_unavailable' };
                input.launcherHistory.dismiss(input.target.handle.serviceId);
                return { status: 'succeeded' };
            }
            if (input.target.kind !== 'inventory_entry') return { status: 'denied', reasonCode: 'wrong_target_kind' };
            const result = input.inventoryRegistry.forgetEntry({
                inventoryId: input.target.entry.id,
                updatedAt: input.now,
            });
            if (!result.ok) {
                return { status: 'denied', reasonCode: result.reason };
            }
            const forgottenEntryId = input.target.entry.id;
            const stillVisible = input.inventoryRegistry
                .getSnapshot()
                .entries
                .some((entry) => entry.id === forgottenEntryId);
            return stillVisible
                ? { status: 'failed', reasonCode: 'forget_verification_failed' }
                : { status: 'succeeded', undoKey: result.undoKey };
        }
        case 'stop_managed': {
            if (input.target.kind !== 'managed_service') return { status: 'denied', reasonCode: 'wrong_target_kind' };
            const signals = [input.execution?.ingress?.signal, input.execution?.actionContext.signal]
                .filter((signal): signal is AbortSignal => signal !== undefined);
            return await stopProjectManagedService(input.target.handle, signals.length ? AbortSignal.any(signals) : undefined);
        }
        case 'restart_managed':
            if (input.target.kind === 'managed_service' && input.restartManagedService && input.execution)
                return await input.restartManagedService(input.request, input.target.handle, input.execution);
            return { status: 'denied', reasonCode: input.target.kind === 'managed_service' ? 'managed_service_restart_admission_required' : 'wrong_target_kind' };
        case 'terminate_detected': {
            if (input.target.kind !== 'inventory_entry') return { status: 'denied', reasonCode: 'wrong_target_kind' };
            if (!input.terminateDetectedService) {
                return { status: 'denied', reasonCode: 'terminate_detected_executor_unavailable' };
            }
            try {
                return await input.terminateDetectedService({
                    request: input.request,
                    entry: input.target.entry,
                    now: input.now,
                });
            } catch {
                return { status: 'failed', reasonCode: 'terminate_detected_executor_failed' };
            }
        }
    }
}
