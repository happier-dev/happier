import type { LocalServiceActionRequestV1 } from '@happier-dev/protocol';

import type { LocalServiceInventoryRegistry } from '../inventory/registry';
import type { NormalizedLocalServiceInventoryEntry } from '../inventory/scanner';
import {
    type ManagedLocalServiceRegistry,
    type ManagedLocalServiceRuntimeState,
} from '../managed/registry';
import { resolveManagedLocalServiceRestartRequest } from '../managed/restart';
import type { TerminateDetectedService } from './terminate';

export type ResolvedLocalServiceActionTarget =
    | Readonly<{ kind: 'inventory_entry'; entry: NormalizedLocalServiceInventoryEntry }>
    | Readonly<{ kind: 'managed_service'; service: ManagedLocalServiceRuntimeState }>;

export type LocalServiceActionExecutionOutcome =
    | Readonly<{ status: 'succeeded' }>
    | Readonly<{ status: 'denied' | 'failed'; reasonCode: string }>;

export type StopManagedLocalService = (input: Readonly<{
    request: LocalServiceActionRequestV1;
    service: ManagedLocalServiceRuntimeState;
    now: number;
}>) => LocalServiceActionExecutionOutcome | Promise<LocalServiceActionExecutionOutcome>;

export type RestartManagedLocalService = (input: Readonly<{
    request: LocalServiceActionRequestV1;
    service: ManagedLocalServiceRuntimeState;
    now: number;
}>) => LocalServiceActionExecutionOutcome | Promise<LocalServiceActionExecutionOutcome>;

export async function executeLocalServiceAction(input: Readonly<{
    request: LocalServiceActionRequestV1;
    target: ResolvedLocalServiceActionTarget;
    inventoryRegistry: LocalServiceInventoryRegistry;
    managedRegistry: ManagedLocalServiceRegistry;
    stopManagedService?: StopManagedLocalService;
    restartManagedService?: RestartManagedLocalService;
    terminateDetectedService?: TerminateDetectedService;
    now: number;
}>): Promise<LocalServiceActionExecutionOutcome> {
    switch (input.request.action) {
        case 'copy_url':
        case 'open_preview':
            return { status: 'succeeded' };
        case 'forget': {
            if (input.target.kind !== 'inventory_entry') {
                return { status: 'denied', reasonCode: 'wrong_target_kind' };
            }
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
                : { status: 'succeeded' };
        }
        case 'stop_managed': {
            if (input.target.kind !== 'managed_service') {
                return { status: 'denied', reasonCode: 'wrong_target_kind' };
            }
            if (!input.stopManagedService) {
                return { status: 'denied', reasonCode: 'managed_stop_executor_unavailable' };
            }
            let stopped: LocalServiceActionExecutionOutcome;
            try {
                stopped = await input.stopManagedService({
                    request: input.request,
                    service: input.target.service,
                    now: input.now,
                });
            } catch {
                return { status: 'failed', reasonCode: 'managed_stop_executor_failed' };
            }
            if (stopped.status !== 'succeeded') {
                return stopped;
            }
            return input.managedRegistry.getService(input.target.service.id)
                ? { status: 'failed', reasonCode: 'managed_stop_verification_failed' }
                : { status: 'succeeded' };
        }
        case 'restart_managed': {
            if (input.target.kind !== 'managed_service') {
                return { status: 'denied', reasonCode: 'wrong_target_kind' };
            }
            if (!input.restartManagedService) {
                const decision = resolveManagedLocalServiceRestartRequest({
                    serviceId: input.target.service.id,
                    policy: { kind: 'never' },
                });
                return {
                    status: 'denied',
                    reasonCode: decision.ok === false ? decision.reason : 'restart_not_configured',
                };
            }
            let restarted: LocalServiceActionExecutionOutcome;
            try {
                restarted = await input.restartManagedService({
                    request: input.request,
                    service: input.target.service,
                    now: input.now,
                });
            } catch {
                return { status: 'failed', reasonCode: 'managed_restart_executor_failed' };
            }
            if (restarted.status !== 'succeeded') {
                return restarted;
            }
            const service = input.managedRegistry.getService(input.target.service.id);
            return service && service.phase !== 'stopped' && service.phase !== 'failed'
                ? { status: 'succeeded' }
                : { status: 'failed', reasonCode: 'managed_restart_verification_failed' };
        }
        case 'terminate_detected': {
            if (input.target.kind !== 'inventory_entry') {
                return { status: 'denied', reasonCode: 'wrong_target_kind' };
            }
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
