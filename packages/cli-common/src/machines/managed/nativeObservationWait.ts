import { waitForChangeOrDeadline } from '../../lifecycle/waitForChangeOrDeadline.js';
import { ManagedMachineControllerError } from './controllerErrors.js';

/** CD32/CD33: external native APIs have no completion push. This cadence is not a deadline. */
export function createManagedNativeObservationWait(signal?: AbortSignal) {
    let intervalMs = 5_000;
    return async (changes?: Readonly<{
        waitForChange(signal: AbortSignal): Promise<void>;
        onChange(): Promise<boolean>;
    }>): Promise<boolean> => {
        const nextObservationAt = Date.now() + intervalMs;
        for (;;) {
            const outcome = await waitForChangeOrDeadline({ signal, unref: true,
                remainingMs: Math.max(0, nextObservationAt - Date.now()),
                waitForChange: changes?.waitForChange ?? (() => new Promise<void>(() => {})),
            });
            if (outcome === 'aborted' || signal?.aborted) throw new ManagedMachineControllerError('cancelled');
            if (outcome === 'deadline') break;
            if (changes && !await changes.onChange()) return false;
        }
        intervalMs = Math.min(intervalMs * 2, 60_000);
        return true;
    };
}
