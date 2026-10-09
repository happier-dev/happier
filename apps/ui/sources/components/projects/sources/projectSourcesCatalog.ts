import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { observeProjectSources } from './observeProjectSources';
import { createProjectSourcesController, type ProjectSourcesCatalog, type ReadProjectSourcesCatalog } from './projectSourcesController';

type Execute = Parameters<typeof createProjectSourcesController>[1];
type Query = {
    controller: ReturnType<typeof createProjectSourcesController>;
    catalog: ProjectSourcesCatalog;
    subscribers: number;
    stopChanges(): void;
    stopObserve: (() => void) | null;
};

/** One authorized query owner per Account lifetime; editors never own its list transport. */
export function createProjectSourcesCatalog(lifetime: ServerAccountScopeLifetime, execute: Execute) {
    const queries = new Map<string, Query>();
    const defaultKey = JSON.stringify(['', null]);
    let demand = 0;
    function observe(entry: Query) {
        if (demand > 0 && entry.subscribers > 0 && !entry.stopObserve) entry.stopObserve = observeProjectSources(entry.controller);
    }
    function disposeQueries() {
        for (const entry of queries.values()) {
            entry.stopObserve?.(); entry.stopChanges();
            entry.controller.retireCatalog(); entry.controller.dispose();
        }
        queries.clear();
    }
    const read: ReadProjectSourcesCatalog = (query, audience) => {
        const key = JSON.stringify([query, audience ?? null]);
        const existing = queries.get(key);
        if (existing) return existing.catalog;
        const owner = createProjectSourcesController(lifetime.scope, execute);
        const catalog: ProjectSourcesCatalog = {
            getSnapshot: owner.getSnapshot,
            subscribe(listener) {
                entry.subscribers += 1;
                observe(entry);
                const stop = owner.subscribe(listener);
                let subscribed = true;
                return () => {
                    if (!subscribed) return;
                    subscribed = false; stop(); entry.subscribers -= 1;
                    if (entry.subscribers !== 0) return;
                    entry.stopObserve?.(); entry.stopObserve = null;
                    // Only the ordinary catalog persists across navigation. Old search prefixes
                    // have no consumer and must not fan out future Account-change requests.
                    if (key !== defaultKey && queries.get(key) === entry) {
                        entry.stopChanges(); owner.retireCatalog('source_query_retired'); owner.dispose(); queries.delete(key);
                    }
                };
            },
            load: async (...args) => { if (lifetime.isCurrent()) await owner.load(...args); },
            acknowledgeCatalog: (source, created) => {
                if (!lifetime.isCurrent()) return;
                for (const query of queries.values()) query.controller.acknowledgeCatalog(source, created);
            },
            removeCatalogSource: (sourceId, issue) => {
                for (const query of queries.values()) query.controller.removeCatalogSource(sourceId, issue);
            },
        };
        const stopChanges = owner.subscribe(() => {
            const state = owner.getSnapshot();
            if (state.status !== 'ready' || !state.coverage.complete || state.catalogQuery !== '' || state.catalogAudience !== undefined) return;
            const visible = new Map(state.rows.map(source => [source.id, source]));
            // A full authorized inventory settles absence for every filtered projection too.
            for (const query of queries.values()) if (query.controller !== owner) {
                for (const row of query.controller.getSnapshot().rows) {
                    const current = visible.get(row.id);
                    if (current) query.controller.acknowledgeCatalog(current);
                    else query.controller.removeCatalogSource(row.id, 'source_unavailable');
                }
            }
        });
        const entry: Query = { controller: owner, catalog, subscribers: 0, stopChanges, stopObserve: null };
        queries.set(key, entry);
        return catalog;
    };
    const retirement = lifetime.onRetire(disposeQueries);
    return {
        read,
        demand() {
            if (!lifetime.isCurrent()) return () => {};
            demand += 1;
            if (demand === 1) for (const entry of queries.values()) observe(entry);
            return () => {
                demand -= 1;
                if (demand === 0) for (const entry of queries.values()) { entry.stopObserve?.(); entry.stopObserve = null; }
            };
        },
        dispose() {
            retirement.dispose();
            disposeQueries();
        },
    };
}

const catalogs = new WeakMap<ServerAccountScopeLifetime, ReturnType<typeof createProjectSourcesCatalog>>();
export function readProjectSourcesCatalog(lifetime: ServerAccountScopeLifetime, execute: Execute) {
    let catalog = catalogs.get(lifetime);
    if (!catalog) { catalog = createProjectSourcesCatalog(lifetime, execute); catalogs.set(lifetime, catalog); }
    return catalog;
}
