import { getIrohHomeTunnelRuntime } from '@/sync/runtime/nativeIrohTunnels/runtime';
import { irohMachineTransferRuntimeActivity } from '@/sync/runtime/nativeIrohTunnels/machineTransferLifecycle';
import { getNativeSshTunnelRuntime } from '@/sync/runtime/nativeSshTunnels/runtime';
import { isRuntimeActive, subscribeToRuntimeActiveChange } from '@/utils/runtime/isRuntimeActive';

export type NativeLoopbackTunnelRuntimeActivity = Readonly<{
    markSuspended: () => void;
    markForeground: () => Promise<void>;
}>;

let singletonLifecycleSubscription: Readonly<{ remove: () => void }> | null = null;

export function bindNativeLoopbackTunnelRuntimeActivity(params: Readonly<{
    isActive: () => boolean;
    subscribe: (listener: () => void | Promise<void>) => () => void;
    runtimes: readonly NativeLoopbackTunnelRuntimeActivity[];
}>): Readonly<{ remove: () => void }> {
    let active = params.isActive();
    const onActivityChange = async (): Promise<void> => {
        const nextActive = params.isActive();
        if (nextActive === active) return;
        active = nextActive;
        if (!nextActive) {
            for (const runtime of params.runtimes) runtime.markSuspended();
            return;
        }
        await Promise.allSettled(params.runtimes.map(async (runtime) => await runtime.markForeground()));
    };
    if (!active) {
        for (const runtime of params.runtimes) runtime.markSuspended();
    }
    const unsubscribe = params.subscribe(onActivityChange);
    return { remove: unsubscribe };
}

/**
 * Mounts the process-wide foreground lifecycle for every native loopback
 * tunnel runtime. Provider runtimes retain their own resource supervisors;
 * this owner supplies the one shared app-state listener only.
 */
export function startNativeLoopbackTunnelRuntimeAppStateLifecycle(): void {
    if (singletonLifecycleSubscription) return;
    singletonLifecycleSubscription = bindNativeLoopbackTunnelRuntimeActivity({
        isActive: isRuntimeActive,
        subscribe: subscribeToRuntimeActiveChange,
        runtimes: [
            {
                markSuspended: () => getNativeSshTunnelRuntime().markSuspended(),
                markForeground: async () => await getNativeSshTunnelRuntime().markForeground(),
            },
            getIrohHomeTunnelRuntime(),
            irohMachineTransferRuntimeActivity,
        ],
    });
}
