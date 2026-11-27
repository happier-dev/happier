import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useOptionalAuth } from '@/auth/context/AuthContext';
import { homeAccountCredentialScope } from '@/auth/storage/tokenStorage';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createUsageSourcesController, type UsageSourcesController, type UsageSourcesSnapshot } from './usageSourcesController';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';

export type UsageSourcesHookOptions = Omit<Parameters<typeof createUsageSourcesController>[0], 'lifetime' | 'credentials'> & Readonly<{
    lifetime: ServerAccountScopeLifetime | null;
}>;

const unavailable: UsageSourcesSnapshot = {
    sources: [], dismissedSources: [], loaded: false, retired: true, pending: [], error: null, approval: null,
    historyDeletion: null, machineReadFailed: false,
};
const readUnavailable = () => unavailable;
const subscribeUnavailable = () => () => {};
type MountedController = Readonly<{
    machineId: string;
    lifetime: ServerAccountScopeLifetime;
    execute: NonNullable<UsageSourcesHookOptions['executor']>['execute'];
    controller: UsageSourcesController;
}>;

/** The mounted leaf owns subscription/disposal. Visible demand explicitly calls discover/refresh. */
export function useUsageSourcesController(options: UsageSourcesHookOptions): Readonly<{
    controller: UsageSourcesController | null;
    snapshot: UsageSourcesSnapshot;
    ready: boolean;
}> {
    const { machineId, lifetime } = options;
    const authCredentials = useOptionalAuth()?.credentials;
    const credentials = lifetime && homeAccountCredentialScope(lifetime.scope.serverId, authCredentials?.token)?.accountId === lifetime.scope.accountId
        ? authCredentials : undefined;
    const mountedExecution = useMountedActionExecution(lifetime?.scope);
    const { execute: executeFromUi, executeForCaller } = mountedExecution;
    const executeMounted = useCallback<MountedController['execute']>((actionId, input, context) =>
        context && (context.surface !== 'ui' || context.authority || context.actionCaller)
            ? executeForCaller(actionId, input, context)
            : executeFromUi(actionId, input, context), [executeForCaller, executeFromUi]);
    const execute = options.executor?.execute ?? executeMounted;
    const ready = options.executor !== undefined || mountedExecution.ready;
    const [mounted, setMounted] = useState<MountedController | null>(null);
    useEffect(() => {
        if (!lifetime) { setMounted(null); return; }
        // Creation after commit avoids leaking lifetime subscriptions from a discarded render.
        const controller = createUsageSourcesController({ machineId, lifetime, executor: { execute }, ...(credentials ? { credentials } : {}) });
        setMounted({ machineId, lifetime, execute, controller });
        return () => controller.dispose();
    }, [machineId, lifetime, execute, credentials]);
    // The next render cannot label the previous Machine/Account's rows as its own,
    // even before the effect retires the old controller.
    const controller = mounted?.machineId === machineId && mounted.lifetime === lifetime && mounted.execute === execute
        ? mounted.controller : null;
    const snapshot = useSyncExternalStore(controller?.subscribe ?? subscribeUnavailable,
        controller?.getSnapshot ?? readUnavailable, controller?.getSnapshot ?? readUnavailable);
    return { controller, snapshot, ready };
}
