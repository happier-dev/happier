import * as React from 'react';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createProjectSourcesController, getProjectSourceSharingAudience, type ProjectSourcesState } from './projectSourcesController';
import { observeProjectSources } from './observeProjectSources';
import { readProjectSourceAddressMachines } from './projectSourceAddressMachines';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { readProjectSourcesCatalog } from './projectSourcesCatalog';
import { useActiveServerAccountScopeLifetime, useMachineListStatusForServer } from '@/sync/store/hooks';
import { useProjectAccountWorkspaceRefs } from '@/sync/domains/workspaces/projectAccountRows';
import { projectSourceRepositoryFacts, type ProjectSourceRepositoryFacts } from './projectSourceRepositoryFacts';
import { retainShallow } from '@/sync/domains/state/structuralSharing';

const NO_REPOSITORY_FACTS: ReadonlyMap<string, ProjectSourceRepositoryFacts> = new Map();

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
export function useProjectSources(scope: ServerAccountScope, options: Readonly<{
    enabled?: boolean; repositoryFacts?: boolean;
    /** The Source query owner applies Team ownership and the viewer's Team/Group audience before paging. */
    sharedWithTeamId?: string;
    /** Explicit-link readers consume the named Home's credential lifetime rather than focus. */
    lifetime?: ServerAccountScopeLifetime | null;
    /** A portable setup link demands only its selected Source, never the Source inventory. */
    catalog?: boolean;
}> = {}) {
    const execute = useProjectSourceActionExecute();
    const activeLifetime = useActiveServerAccountScopeLifetime();
    const lifetime = options.lifetime === undefined
        ? activeLifetime && areServerAccountScopesEqual(activeLifetime.scope, scope) ? activeLifetime : null
        : options.lifetime;
    const inventoryStatus = useMachineListStatusForServer(scope.serverId);
    const catalog = lifetime ? readProjectSourcesCatalog(lifetime, execute) : null;
    const controller = React.useMemo(() => createProjectSourcesController({ serverId: scope.serverId, accountId: scope.accountId }, execute,
        () => readProjectSourceAddressMachines(scope.serverId), catalog?.read, options.sharedWithTeamId),
        [scope.serverId, scope.accountId, execute, catalog, options.sharedWithTeamId]);
    const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
    const wantsRepositoryFacts = options.enabled !== false && options.repositoryFacts === true;
    const workspaceRefs = useProjectAccountWorkspaceRefs(wantsRepositoryFacts && lifetime !== null);
    const repositoryFacts = React.useMemo(() => wantsRepositoryFacts
        ? projectSourceRepositoryFacts(scope.serverId, state.rows, workspaceRefs) : NO_REPOSITORY_FACTS,
        [wantsRepositoryFacts, scope.serverId, state.rows, workspaceRefs]);
    React.useEffect(() => {
        // React replays setup after development StrictMode cleanup. The same
        // captured owner resumes; scope replacement still retires the old one.
        controller.resume();
        const retirement = lifetime?.onRetire(() => { controller.retireCatalog(); controller.dispose(); });
        if (options.enabled !== false && options.catalog !== false) void controller.load();
        return () => retirement?.dispose();
    }, [controller, options.enabled, options.catalog, lifetime]);
    React.useEffect(() => () => { controller.dispose(); }, [controller]);
    React.useEffect(() => {
        if (options.enabled === false || state.addressResolution.kind !== 'waiting_for_machines'
            || inventoryStatus === 'loading' || !lifetime?.isCurrent()
            || !areServerAccountScopesEqual(lifetime.scope, scope)) return;
        void controller.resolveAddress(state.addressResolution.address);
    }, [controller, inventoryStatus, lifetime, options.enabled, scope, state.addressResolution]);
    React.useEffect(() => {
        if (options.enabled === false) return;
        const stopDemand = options.catalog !== false ? catalog?.demand() : undefined;
        const stopDetail = observeProjectSources(controller, { detailOnly: Boolean(catalog) });
        return () => { stopDemand?.(); stopDetail(); };
    }, [catalog, controller, options.enabled, options.catalog]);
    return { state, controller, repositoryFacts };
}

type SourceReadState = Pick<ProjectSourcesState, 'current' | 'canManage' | 'detailStatus' | 'issue'>;
const UNAVAILABLE_SOURCE_READ: SourceReadState = Object.freeze({ current: null, canManage: false, detailStatus: 'initial', issue: null });

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
    const current = lifetime?.isCurrent() ? presentedProjectSource(state, sourceId) : null;
    const source = React.useMemo(() => current && lifetime ? { serverId: lifetime.scope.serverId, source: current } : null, [current, lifetime]);
    const audience = React.useMemo(() => getProjectSourceSharingAudience({ current, canManage: state.canManage,
        detailStatus: state.detailStatus }), [current, state.canManage, state.detailStatus]);
    const resolveSource = React.useCallback(() => owner?.settle() ?? Promise.resolve(null), [owner]);
    return React.useMemo(() => ({ status: state.detailStatus, issue: state.issue, source, audience, resolveSource }),
        [source, audience, resolveSource, state.detailStatus, state.issue]);
}

function presentedProjectSource(state: SourceReadState, sourceId: string | null) {
    return (state.detailStatus === 'ready' || state.detailStatus === 'loading' || state.detailStatus === 'offline')
        && state.current?.id === sourceId ? state.current : null;
}

/** Names for the Sources already referenced by loaded rows; shares their exact readers, never lists the inventory. */
export function useProjectSourceNames(lifetime: ServerAccountScopeLifetime | null, sourceIds: readonly string[], enabled: boolean) {
    const execute = useProjectSourceActionExecute();
    const selection = React.useMemo(() => {
        const catalog = lifetime?.isCurrent() && enabled ? readProjectSourcesCatalog(lifetime, execute) : null;
        const owners = catalog ? sourceIds.map(id => ({ id, owner: catalog.readSource(id) })) : [];
        let names: readonly (string | null)[] = [];
        const getSnapshot = (): readonly (string | null)[] => {
            const current = lifetime?.isCurrent();
            names = retainShallow(names, owners.map(({ id, owner }) => current
                ? presentedProjectSource(owner.controller.getSnapshot(), id)?.name ?? null : null));
            return names;
        };
        const subscribe = (listener: () => void) => {
            const stops = owners.map(({ owner }) => owner.controller.subscribe(listener));
            const retirement = lifetime?.onRetire(listener);
            return () => { stops.forEach(stop => stop()); retirement?.dispose(); };
        };
        const demand = () => {
            const stops = lifetime?.isCurrent() ? owners.map(({ owner }) => owner.demand()) : [];
            return () => stops.forEach(stop => stop());
        };
        return { getSnapshot, subscribe, demand };
    }, [enabled, execute, lifetime, sourceIds]);
    const names = React.useSyncExternalStore(selection.subscribe, selection.getSnapshot, selection.getSnapshot);
    React.useEffect(selection.demand, [selection]);
    return names;
}
