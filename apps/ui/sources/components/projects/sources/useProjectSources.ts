import * as React from 'react';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createProjectSourcesController, type ProjectSourcesState } from './projectSourcesController';
import { observeProjectSources } from './observeProjectSources';
import { readProjectSourceAddressMachines } from './projectSourceAddressMachines';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { readProjectSourcesCatalog } from './projectSourcesCatalog';
import { useActiveServerAccountScopeLifetime, useMachineListStatusForServer } from '@/sync/store/hooks';

/** The Sources' action executor, loaded at first use (shared with Open's repository address). */
export function useProjectSourceActionExecute() {
    const [execute] = React.useState(() => {
        // Preserve lazy evaluation at this hook's demand boundary without a CommonJS-only loader.
        const load = async () => createFrontDoorActionExecute((await import('@/sync/ops/actions/defaultActionExecutor')).createDefaultActionExecutor());
        let loaded: ReturnType<typeof load> | null = null;
        return async (...args: Parameters<ReturnType<typeof createFrontDoorActionExecute>>) => (await (loaded ??= load()))(...args);
    });
    return execute;
}

/** The screen opts into catalog demand; mounting a closed picker does no work. */
export function useProjectSources(scope: ServerAccountScope, options: Readonly<{ enabled?: boolean }> = {}) {
    const execute = useProjectSourceActionExecute();
    const activeLifetime = useActiveServerAccountScopeLifetime();
    const lifetime = activeLifetime && areServerAccountScopesEqual(activeLifetime.scope, scope) ? activeLifetime : null;
    const inventoryStatus = useMachineListStatusForServer(scope.serverId);
    const catalog = lifetime ? readProjectSourcesCatalog(lifetime, execute) : null;
    const controller = React.useMemo(() => createProjectSourcesController({ serverId: scope.serverId, accountId: scope.accountId }, execute,
        () => readProjectSourceAddressMachines(scope.serverId), catalog?.read),
        [scope.serverId, scope.accountId, execute, catalog]);
    const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
    React.useEffect(() => {
        // React replays setup after development StrictMode cleanup. The same
        // captured owner resumes; scope replacement still retires the old one.
        controller.resume();
        const retirement = lifetime?.onRetire(() => { controller.retireCatalog(); controller.dispose(); });
        if (options.enabled !== false) void controller.load();
        return () => retirement?.dispose();
    }, [controller, options.enabled, lifetime]);
    React.useEffect(() => () => { controller.dispose(); }, [controller]);
    React.useEffect(() => {
        if (options.enabled === false || state.addressResolution.kind !== 'waiting_for_machines'
            || inventoryStatus === 'loading' || !lifetime?.isCurrent()
            || !areServerAccountScopesEqual(lifetime.scope, scope)) return;
        void controller.resolveAddress(state.addressResolution.address);
    }, [controller, inventoryStatus, lifetime, options.enabled, scope, state.addressResolution]);
    React.useEffect(() => {
        if (options.enabled === false) return;
        const stopDemand = catalog?.demand();
        const stopDetail = observeProjectSources(controller, { detailOnly: Boolean(catalog) });
        return () => { stopDemand?.(); stopDetail(); };
    }, [catalog, controller, options.enabled]);
    return { state, controller };
}

type SourceReadState = Pick<ProjectSourcesState, 'current' | 'detailStatus' | 'issue'>;
const UNAVAILABLE_SOURCE_READ: SourceReadState = Object.freeze({ current: null, detailStatus: 'initial', issue: null });

/** One accepted Source provenance demands its existing authorized reader, not a catalog scan. */
export function useProjectSource(lifetime: ServerAccountScopeLifetime | null, sourceId: string | null) {
    const execute = useProjectSourceActionExecute();
    const owner = React.useMemo(() => lifetime?.isCurrent() && sourceId
        ? readProjectSourcesCatalog(lifetime, execute).readSource(sourceId) : null, [execute, lifetime, sourceId]);
    const controller = owner?.controller ?? null;
    const subscribe = React.useCallback((listener: () => void) => {
        const unsubscribe = controller?.subscribe(listener);
        const retirement = lifetime?.onRetire(listener);
        return () => { unsubscribe?.(); retirement?.dispose(); };
    }, [controller, lifetime]);
    const getSnapshot = React.useCallback((): SourceReadState => lifetime?.isCurrent() && controller
        ? controller.getSnapshot() : UNAVAILABLE_SOURCE_READ, [controller, lifetime]);
    const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    React.useEffect(() => {
        if (lifetime?.isCurrent()) return owner?.demand();
    }, [owner, lifetime]);
    // Keep the last admitted presentation during a refresh, as the Source
    // controller does, including transient offline failures. Definitive refusal
    // and Account retirement withdraw it; display grants no effect authority.
    const current = lifetime?.isCurrent() && (state.detailStatus === 'ready' || state.detailStatus === 'loading' || state.detailStatus === 'offline')
        && state.current?.id === sourceId ? state.current : null;
    const source = React.useMemo(() => current && lifetime ? { serverId: lifetime.scope.serverId, source: current } : null, [current, lifetime]);
    return React.useMemo(() => ({ status: state.detailStatus, issue: state.issue, source }), [source, state.detailStatus, state.issue]);
}
