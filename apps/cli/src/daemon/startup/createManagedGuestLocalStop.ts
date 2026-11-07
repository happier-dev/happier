import type { ApiMachineClient } from '@/api/apiMachine';
import { prepareMachinePoweroff } from '@/machines/adminAccess/runElevatedEffect';
import type { ManagedGuestLocalStop } from '@/machines/managed/managedRetentionPolicy';

/** Guest-native effects only; policy timing and material-work drain remain in the reconciler. */
export function createManagedGuestLocalStop(params: Readonly<{
    captureElevation(): ReturnType<ApiMachineClient['captureMachineAdminAccess']> | null;
    requestProcessExit(): void;
}>): ManagedGuestLocalStop {
    return { async prepare(effect, signal) {
        signal?.throwIfAborted();
        if (effect === 'process-exit') return async () => {
            signal?.throwIfAborted();
            params.requestProcessExit();
        };
        try {
            const elevation = params.captureElevation();
            return elevation ? await prepareMachinePoweroff(elevation, signal) : null;
        } catch {
            signal?.throwIfAborted();
            return null;
        }
    } };
}
