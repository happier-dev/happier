import { MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1 } from '@happier-dev/protocol/plugins/events/machineServiceObservationV1';
import type { StablePluginEventsBroker } from '@/plugins/runtime/invocation/services/events';
import { logger } from '@/ui/logger';
import type { WorktreePortsOwner } from './worktreePorts';

/** Consume the lifecycle owner's captured root; never infer removal from filesystem observations. */
export function subscribeWorktreePortRemoval(input: Readonly<{
    broker: Pick<StablePluginEventsBroker, 'subscribeHost'>;
    portsOwner: Pick<WorktreePortsOwner, 'release'>;
    resolveCurrentMachineId(): string | null;
    isCurrent(): boolean;
}>) {
    return input.broker.subscribeHost({
        target: { eventId: MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1, scope: { kind: 'account' } },
        isCurrent: input.isCurrent,
        async listener(event) {
            if (event.eventId !== MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1 || event.payload.kind !== 'worktreeRemoved') return;
            const removal = event.payload.removal;
            if (removal.machineId !== input.resolveCurrentMachineId()) return;
            const released = await input.portsOwner.release({ rootPath: removal.worktreePath });
            if (released.kind === 'unavailable') logger.warn('[WorktreePorts] Assignment release unavailable', {
                code: released.code, reason: released.reason,
            });
        },
    });
}
