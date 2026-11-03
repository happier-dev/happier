import { isPluginError, type Disposable } from '@happier-dev/plugin-sdk';

import type { TriageDataActionContext } from '../actions/dataContext.js';
import type { TriageReadSourceSessionLinksInputV1 } from '../actions/sessionLinksProtocol.js';
import { bindCorpusCollections } from '../corpus/collections/bindCorpusCollections.js';
import { CORPUS_SESSION_LINKS_COLLECTION, CORPUS_SOURCE_INSTANCES_COLLECTION } from '../corpus/collections/definitions.js';
import { CORPUS_SOURCE_INSTANCES_INDEX_ID, CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../corpus/collections/ids.js';
import { TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../manifest.js';
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

    async function rebuild() {
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
            for (const { selection, scopes: selectedScopes } of scopes) {
                if (controller.signal.aborted || disposed) break;
                if (await owner.hasCorpusReadDemand(selection)) {
                    const relation = 'sessionId' in selection ? { sessionId: selection.sessionId } : { entryRef: selection.entryRef };
                    const query = await triageSessionLinksSelectionV1(links, relation, { signal: discovery.signal });
                    if (!controller.signal.aborted && !disposed) attached.push(links.watch(query, selectedChanged));
                }
                for (const scope of selectedScopes) {
                    if (controller.signal.aborted || disposed) break;
                    if (scope.kind !== 'ready' || scope.roleKinds.length === 0) continue;
                    const operation = scope.source.operations?.readSessionLinks;
                    if (operation === undefined || scope.source.operations?.linkSession === undefined) continue;
                    const entry = 'entryRef' in selection ? selection.entryRef : undefined;
                    try {
                        const observation = await context.services.actions.observeAdmittedTargetedOperation(operation, {
                            v: 1, instance: scope.row.configured,
                            ...(entry === undefined ? {} : { localRef: { kindId: entry.kindId, collisionScope: entry.collisionScope, entryId: entry.entryId } }),
                            ...('sessionId' in selection ? { sessionId: selection.sessionId } : {}),
                        }, selectedChanged, { signal: controller.signal });
                        attached.push(observation);
                    } catch (error) {
                        // Snapshot-only source roles retain their existing manual
                        // refresh contract. This never substitutes a fake watcher
                        // or disables exact corpus observation for healthy co-links.
                        if (!isPluginError(error) || error.code !== 'plugin_action_read_observation_unavailable') {
                            // A refused dependency is not an attached observer.
                            // Keep independent healthy corpus dependencies live;
                            // configuration/registry changes rebuild admission.
                            selectedChanged();
                        }
                    }
                }
            }
        } catch (error) {
            await disposeSubscriptions(attached);
            throw error;
        }
        if (controller.signal.aborted || disposed) {
            await disposeSubscriptions(attached);
        } else dependencies = attached;
    }
    function requestRebuild() {
        const next = rebuild();
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
        notify();
        void requestRebuild().then(notify).catch(notify);
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
