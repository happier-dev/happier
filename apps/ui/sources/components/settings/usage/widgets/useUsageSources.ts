import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createUsageSourcesController, resolveUsageSourceDismiss, type UsageSourcesController, type UsageSourcesSnapshot } from './usageSourcesController';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';

export type UsageSourcesHookOptions = Omit<Parameters<typeof createUsageSourcesController>[0], 'lifetime'> & Readonly<{
    lifetime: ServerAccountScopeLifetime | null;
}>;

const unavailable: UsageSourcesSnapshot = {
    sources: [], loaded: false, retired: true, pending: [], error: null, approval: null,
    dismissedSourceIds: [], historyDeletion: null,
};
const readUnavailable = () => unavailable;
const subscribeUnavailable = () => () => {};
type MountedController = Readonly<{
    machineId: string;
    lifetime: ServerAccountScopeLifetime;
    executor: UsageSourcesHookOptions['executor'];
    controller: UsageSourcesController;
}>;

/** The mounted leaf owns subscription/disposal. Visible demand explicitly calls discover/refresh. */
export function useUsageSourcesController(options: UsageSourcesHookOptions): Readonly<{
    controller: UsageSourcesController | null;
    snapshot: UsageSourcesSnapshot;
}> {
    const { machineId, lifetime } = options;
    const controllerRef = useRef<UsageSourcesController | null>(null);
    const executorOptions = useMemo(() => ({ usageSourceDismiss: async (
        input: Parameters<typeof resolveUsageSourceDismiss>[0],
        context: Readonly<{ signal?: AbortSignal }>,
    ) => {
        context.signal?.throwIfAborted();
        return resolveUsageSourceDismiss(input, { machineId, lifetime, snapshot: controllerRef.current?.getSnapshot() });
    } }), [machineId, lifetime]);
    const mountedExecution = useMountedActionExecution(lifetime?.scope, { executorOptions });
    const executor = options.executor ?? mountedExecution;
    const execute = executor.execute;
    const [mounted, setMounted] = useState<MountedController | null>(null);
    useEffect(() => {
        if (!lifetime) { setMounted(null); return; }
        // Creation after commit avoids leaking lifetime subscriptions from a discarded render.
        const controller = createUsageSourcesController({ machineId, lifetime, executor: { execute } });
        controllerRef.current = controller;
        setMounted({ machineId, lifetime, executor, controller });
        return () => {
            if (controllerRef.current === controller) controllerRef.current = null;
            controller.dispose();
        };
    }, [machineId, lifetime, execute]);
    // The next render cannot label the previous Machine/Account's rows as its own,
    // even before the effect retires the old controller.
    const controller = mounted?.machineId === machineId && mounted.lifetime === lifetime && mounted.executor?.execute === execute
        ? mounted.controller : null;
    const snapshot = useSyncExternalStore(controller?.subscribe ?? subscribeUnavailable,
        controller?.getSnapshot ?? readUnavailable, controller?.getSnapshot ?? readUnavailable);
    return { controller, snapshot };
}
