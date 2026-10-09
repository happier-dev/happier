import * as React from 'react';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createProjectSourcesController, type ProjectSourcesState } from './projectSourcesController';
import { observeProjectSources } from './observeProjectSources';
import { readProjectSourceAddressMachines } from './projectSourceAddressMachines';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { readProjectSourcesCatalog } from './projectSourcesCatalog';

function useSourceActionExecute() {
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
    const execute = useSourceActionExecute();
    const lifetime = captureActiveServerAccountScopeLifetime();
    const catalog = lifetime && areServerAccountScopesEqual(lifetime.scope, scope) ? readProjectSourcesCatalog(lifetime, execute) : null;
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
    const execute = useSourceActionExecute();
    const controller = React.useMemo(() => lifetime && sourceId
        ? createProjectSourcesController(lifetime.scope, execute) : null, [execute, lifetime, sourceId]);
    const subscribe = React.useCallback((listener: () => void) => {
        const unsubscribe = controller?.subscribe(listener);
        const retirement = lifetime?.onRetire(() => { controller?.dispose(); listener(); });
        return () => { unsubscribe?.(); retirement?.dispose(); };
    }, [controller, lifetime]);
    const getSnapshot = React.useCallback((): SourceReadState => lifetime?.isCurrent() && controller
        ? controller.getSnapshot() : UNAVAILABLE_SOURCE_READ, [controller, lifetime]);
    const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    React.useEffect(() => {
        if (!controller || !sourceId || !lifetime?.isCurrent()) return;
        controller.resume();
        const stop = observeProjectSources(controller, { detailOnly: true });
        void controller.select(sourceId);
        return () => { stop(); controller.dispose(); };
    }, [controller, lifetime, sourceId]);
    // Keep the last admitted presentation during a refresh, as the Source
    // controller does. An offline/refused read or Account retirement supplies
    // no Source slot; context values themselves never grant effect authority.
    const current = lifetime?.isCurrent() && (state.detailStatus === 'ready' || state.detailStatus === 'loading')
        && state.current?.id === sourceId ? state.current : null;
    const source = React.useMemo(() => current && lifetime ? { serverId: lifetime.scope.serverId, source: current } : null, [current, lifetime]);
    return React.useMemo(() => ({ status: state.detailStatus, issue: state.issue, source }), [source, state.detailStatus, state.issue]);
}
