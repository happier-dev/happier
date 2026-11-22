import { isPluginError, type Disposable } from '@happier-dev/plugin-sdk';

import type { TriageDataActionContext } from '../actions/dataContext.js';
import type { TriageReadSourceSessionLinksInputV1 } from '../actions/sessionLinksProtocol.js';
import { bindCorpusCollections } from '../corpus/collections/bindCorpusCollections.js';
import { CORPUS_SESSION_LINKS_COLLECTION, CORPUS_SOURCE_INSTANCES_COLLECTION } from '../corpus/collections/definitions.js';
import { CORPUS_SOURCE_INSTANCES_INDEX_ID, CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../corpus/collections/ids.js';
import { TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../targetedContributions.js';
import { requireTriageAccountStorage } from '../requiredAccountStorage.js';
import { createTriageSourceSessionRelations } from './sourceSessionRelations.js';
import { triageSessionLinksSelectionV1 } from './readEntrySessionLinks.js';

async function disposeSubscriptions(handles: readonly Disposable[]): Promise<void> {
    const results = await Promise.allSettled(handles.map(handle => Promise.resolve().then(() => handle.dispose())));
    const rejected = results.find(result => result.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
}

/** Observe the selected owner's dependencies; never invoke a relation handler. */
export async function observeTriageSourceSessionLinks(
    input: TriageReadSourceSessionLinksInputV1 | readonly TriageReadSourceSessionLinksInputV1[],
    invalidate: () => void,
    context: TriageDataActionContext,
): Promise<Disposable> {
    const storage = requireTriageAccountStorage(context);
    const collections = bindCorpusCollections(storage);
    const links = storage.collection(CORPUS_SESSION_LINKS_COLLECTION);
    const instances = storage.collection(CORPUS_SOURCE_INSTANCES_COLLECTION);
    let disposed = false;
    // Registry/corpus discovery belongs to this observer, not a replaceable
    // dependency attachment. Invalidation must not abort an unchanged read.
    const discovery = new AbortController();
    let selected: AbortController | undefined;
    let dependencies: Disposable[] = [];
    let pendingRebuild: Promise<void> = Promise.resolve();
    let cleanup: Promise<void> | undefined;
    const notify = () => { if (!disposed && !context.signal.aborted) invalidate(); };
    const inputs = 'v' in input ? [input] : input;
    const selections = inputs.map(input => 'entries' in input ? input.entries : [input]).flat();

    async function rebuild(invalidateAfterRebuild: boolean) {
        selected?.abort();
        const controller = new AbortController();
        selected = controller;
        const previous = dependencies;
        dependencies = [];
        await disposeSubscriptions(previous);
        if (disposed || controller.signal.aborted) return;
        const selectedChanged = () => { if (!controller.signal.aborted) notify(); };
        const owner = createTriageSourceSessionRelations({ ...context, signal: discovery.signal }, collections);
        const attached: Disposable[] = [];
        try {
            const scopes = await Promise.all(selections.map(async selection => ({ selection, scopes: await owner.readScopes(selection) })));
            type ReadyScope = Extract<(typeof scopes)[number]['scopes'][number], { kind: 'ready' }>;
            const byInstance = new Map<string, { scope: ReadyScope; sessionIds: Set<string> }>();
            const watchedSessions = new Set<string>();
            async function observeRole(
                scope: ReadyScope,
                demand: { localRef: { kindId: string; collisionScope: string; entryId: string } } | { sessionIds: string[] },
            ) {
                if (controller.signal.aborted || disposed) return;
                const operation = scope.source?.operations?.readSessionLinks;
                if (operation === undefined || scope.source?.operations?.linkSession === undefined) return;
                try {
                    attached.push(await context.services.actions.observeAdmittedTargetedOperation(operation, {
                        v: 1, instance: scope.row.configured, ...demand,
                    }, selectedChanged, { signal: controller.signal }));
                } catch (error) {
                    // Snapshot-only roles retain manual refresh. A refused
                    // source watch leaves independent corpus watches attached.
                    if (!isPluginError(error) || error.code !== 'plugin_action_read_observation_unavailable') {
                        invalidateAfterRebuild = true;
                    }
                }
            }
            for (const { selection, scopes: selectedScopes } of scopes) {
                if (controller.signal.aborted || disposed) break;
                const sessionId = 'sessionId' in selection ? selection.sessionId : undefined;
                if ((sessionId === undefined || !watchedSessions.has(sessionId)) && await owner.hasCorpusReadDemand(selection)) {
                    const relation = 'sessionId' in selection ? { sessionId: selection.sessionId } : { entryRef: selection.entryRef };
                    const query = await triageSessionLinksSelectionV1(links, relation, { signal: discovery.signal });
                    if (!controller.signal.aborted && !disposed) {
                        attached.push(links.watch(query, selectedChanged));
                        if (sessionId !== undefined) watchedSessions.add(sessionId);
                    }
                }
                for (const scope of selectedScopes) {
                    if (scope.kind !== 'ready' || scope.roleKinds.length === 0) continue;
                    if ('entryRef' in selection) {
                        const { kindId, collisionScope, entryId } = selection.entryRef;
                        await observeRole(scope, { localRef: { kindId, collisionScope, entryId } });
                    } else {
                        const key = scope.lane.sourceInstanceId;
                        const current = byInstance.get(key);
                        if (current !== undefined) current.sessionIds.add(selection.sessionId);
                        else byInstance.set(key, { scope, sessionIds: new Set([selection.sessionId]) });
                    }
                }
            }
            for (const { scope, sessionIds } of byInstance.values()) {
                await observeRole(scope, { sessionIds: [...sessionIds] });
            }
        } catch (error) {
            await disposeSubscriptions(attached);
            throw error;
        }
        if (controller.signal.aborted || disposed) {
            await disposeSubscriptions(attached);
        } else {
            dependencies = attached;
            if (invalidateAfterRebuild) notify();
        }
    }
    function requestRebuild(invalidateAfterRebuild = false) {
        const next = rebuild(invalidateAfterRebuild);
        const completed = pendingRebuild;
        pendingRebuild = Promise.allSettled([completed, next]).then(results => {
            const rejected = results.find(result => result.status === 'rejected');
            if (rejected?.status === 'rejected') throw rejected.reason;
        });
        // The final disposer retains any rejection; event-driven rebuilds also
        // notify their read owner without creating an unhandled rejection.
        void pendingRebuild.catch(() => {});
        return next;
    }
    const changed = () => {
        if (disposed) return;
        // One dependency change requests one read, after its replacement watches
        // are attached so that changes during that read remain observable.
        void requestRebuild(true).catch(notify);
    };
    const configuration = instances.watch({ index: CORPUS_SOURCE_INSTANCES_INDEX_ID.byLifecycle,
        prefix: [CORPUS_SOURCE_INSTANCE_LIFECYCLE.active], order: 'asc' }, changed);
    const registry = context.services.targetedContributions.observeForSelf(TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1,
        { onInvalidated: changed });
    const dispose = (): Promise<void> => {
        if (cleanup !== undefined) return cleanup;
        disposed = true;
        discovery.abort();
        selected?.abort();
        context.signal.removeEventListener('abort', onAbort);
        cleanup = (async () => {
            const pending = await Promise.allSettled([pendingRebuild, disposeSubscriptions([configuration, registry])]);
            const remaining = dependencies;
            dependencies = [];
            const retired = await Promise.allSettled([disposeSubscriptions(remaining)]);
            const rejected = [...pending, ...retired].find(result => result.status === 'rejected');
            if (rejected?.status === 'rejected') throw rejected.reason;
        })();
        return cleanup;
    };
    const onAbort = () => { void dispose().catch(() => {}); };
    if (context.signal.aborted) { await dispose(); return { dispose }; }
    context.signal.addEventListener('abort', onAbort, { once: true });
    try { await requestRebuild(); }
    catch (error) { await dispose(); throw error; }
    return { dispose };
}
