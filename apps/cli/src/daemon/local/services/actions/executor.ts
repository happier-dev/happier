import type { LocalServiceActionRequestV1 } from '@happier-dev/protocol';

import type { LocalServiceInventoryRegistry } from '../inventory/registry';
import type { NormalizedLocalServiceInventoryEntry } from '../inventory/scanner';
import type { TerminateDetectedService } from './terminate';

export type ResolvedLocalServiceActionTarget =
    Readonly<{ kind: 'inventory_entry'; entry: NormalizedLocalServiceInventoryEntry }>;

export type LocalServiceActionExecutionOutcome =
    | Readonly<{ status: 'succeeded' }>
    | Readonly<{ status: 'denied' | 'failed'; reasonCode: string }>;

export async function executeLocalServiceAction(input: Readonly<{
    request: LocalServiceActionRequestV1;
    target: ResolvedLocalServiceActionTarget;
    inventoryRegistry: LocalServiceInventoryRegistry;
    terminateDetectedService?: TerminateDetectedService;
    now: number;
}>): Promise<LocalServiceActionExecutionOutcome> {
    switch (input.request.action) {
        case 'copy_url':
        case 'open_preview':
            return { status: 'succeeded' };
        case 'forget': {
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
        // `stop_managed` / `restart_managed` remain in the published action catalog but the
        // managed local-service runtime they executed against was removed with its producerless
        // registry (RU2 surfaces finalization, DEC-6). No managed target kind can be resolved,
        // so execution can only deny. Removal condition: delete both kinds with the next
        // plugin-SDK contraction.
        case 'stop_managed':
        case 'restart_managed':
            return { status: 'denied', reasonCode: 'wrong_target_kind' };
        case 'terminate_detected': {
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
