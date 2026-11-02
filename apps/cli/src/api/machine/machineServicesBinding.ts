import type { MachineMetadataFieldPortV1, MachineMetadataFieldReadV1 } from '@happier-dev/protocol';
import { createMachineServicesRuntime } from '@/daemon/local/services/launch/machineServices';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';
import type { MachineServiceActionDirectTargetInvocation } from '@/session/actions/createCliActionDeps';
import type { MachineMetadataChange } from './machineMetadataPublication';
import { logger } from '@/ui/logger';

/** One ApiMachine façade lifetime; observation custody and pending dedupe remain
 * in the incumbent semanticEntries owner, not in this lifecycle binding. */
export function createApiMachineServicesBinding(input: Readonly<{
    profileId: string;
    machineId: string;
    readMetadata(): MachineMetadataFieldReadV1;
    captureMetadataPort(): MachineMetadataFieldPortV1;
    restoreEnvironmentServices?: Parameters<typeof createMachineServicesRuntime>[0]['restoreEnvironmentServices'];
}>) {
    let disposed = false;
    let started = false;
    let unsubscribe: (() => void) | null = null;
    let initialization: Promise<ReturnType<typeof createMachineServicesRuntime> | null> | null = null;
    async function acquire() {
        if (disposed) return null;
        if (!initialization) {
            const pending = (async () => {
                const serverId = await resolveServerProfileHomeIdentityId(input.profileId);
                return serverId ? createMachineServicesRuntime({ target: { serverId, machineId: input.machineId },
                    readMetadata: input.readMetadata, captureMetadataPort: input.captureMetadataPort,
                    restoreEnvironmentServices: input.restoreEnvironmentServices }) : null;
            })();
            initialization = pending;
            // Missing Home evidence can advance on a later event or request;
            // it never becomes a guessed profile/URL identity or a retry loop.
            void pending.then(runtime => {
                if (!runtime && initialization === pending && !disposed) initialization = null;
            });
        }
        return initialization;
    }
    async function reconcile() {
        const runtime = await acquire();
        if (!disposed) await runtime?.reconcile();
    }
    const wake = () => {
        // Push has no awaiting caller. Reporting does not settle native custody;
        // explicit Actions and disposal retain their original fallible promises.
        void reconcile().catch(() => logger.warn('[API MACHINE] Machine service observation reconciliation failed'));
    };
    function start() {
        if (disposed || started) return;
        started = true;
        unsubscribe = pluginReloadController.subscribe(wake);
        wake();
    }
    return {
        start,
        notifyMetadataChanged(change: MachineMetadataChange) { if (started && !disposed && change.serviceWatchesChanged) wake(); },
        async execute(request: MachineServiceActionDirectTargetInvocation) {
            start();
            const runtime = await acquire();
            return !disposed && runtime ? runtime.execute(request) : { kind: 'unavailable' as const, reason: 'admission_unavailable' as const };
        },
        async ensureEnvironmentServices() {
            const runtime = await acquire();
            if (disposed || !runtime) throw Object.assign(new Error('admission_unavailable'), { code: 'admission_unavailable' });
            await runtime.ensureEnvironmentServices();
        },
        async dispose() {
            if (disposed) return;
            disposed = true;
            unsubscribe?.();
            unsubscribe = null;
            await (await initialization)?.dispose();
        },
    };
}
