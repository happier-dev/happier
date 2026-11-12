import type { TriageDataActionContext } from '../actions/dataContext.js';
import type { Disposable, PluginWorkItemV1, PluginWorkItemsFindLinkedRequestV1, PluginWorkItemsFindLinkedResultV1, PluginWorkItemTransitionInputV1, PluginWorkItemsWatchRequestV1, PluginWorkItemsResolveRequestV1, PluginWorkItemsResolveResultV1, PluginWorkItemsRuntime } from '@happier-dev/plugin-sdk';
import { buildTriageEntryRouteSegmentV1, readTriageEntryRouteSegmentV1,
    TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, TriageTaskWriteResultV1Schema,
    triageTaskStatusCategoryV1, type TriageTaskWriteResultV1 } from '@happier-dev/triage-protocol/v1';
import type { TriageEntryRefV1, TriageEntryLocatorV1, TriageGetInputV1 } from '@happier-dev/triage-protocol/v1';
import { reobserveTriageEntry } from '../actions/reobserveEntry.js';
import { TRIAGE_TASKS_TRANSITION_ACTION_LOCAL_ID_V1 } from '../actions/tasksProtocol.js';
import type { TriageReadSourceSessionLinksInputV1 } from '../actions/sessionLinksProtocol.js';
import { bindCorpusCollections } from '../corpus/collections/bindCorpusCollections.js';
import { renderSourceQualifiedId } from '../corpus/identity/components.js';
import { foldTriageListWindow, TRIAGE_LIST_DEFAULT_LENS_V1 } from '../projection/listWindow.js';
import { requireTriageAccountStorage } from '../requiredAccountStorage.js';
import { createTriageSourceSessionRelations } from '../sessions/sourceSessionRelations.js';
import { observeTriageSourceSessionLinks } from '../sessions/sessionLinksObservation.js';
import { buildTriageRouteSubPathV1, TRIAGE_ROUTE_DEFAULT_LENS_V1 } from '../ui/navigation/location.js';
import { isInternalTaskConfiguredInstanceV1 } from '../internalTasks/configuration.js';
import { getInternalTasks, readInternalTaskList, type TaskList } from '../internalTasks/source.js';

type WorkItemContext = Pick<TriageDataActionContext, 'services' | 'signal' | 'invokedAtMs'>;
// The Board creates a fresh context for each surface load, and passes that same
// context to discovery and resolution. Keep only that operation's admitted read.
const taskSurfaceReads = new WeakMap<WorkItemContext, Promise<TaskList | null>>();
function taskListForSurface(context: WorkItemContext) {
    let read = taskSurfaceReads.get(context);
    if (read === undefined) { read = readInternalTaskList(context); taskSurfaceReads.set(context, read); }
    return read;
}
type ResolvedWorkItem = Readonly<{
    item: PluginWorkItemV1;
    entryRef: TriageEntryRefV1;
    sourceInstanceId: string;
    locator: TriageEntryLocatorV1;
}>;

export const TRIAGE_WORK_ITEMS_TRANSITION_ACTION_LOCAL_ID_V1 = 'work-items/transition-v1';

/** The host owns the watch signal; the relation owner owns asynchronous attachment. */
export const TRIAGE_WORK_ITEMS_RUNTIME: PluginWorkItemsRuntime = {
    resolve: resolveTriageWorkItems,
    findLinked: findLinkedTriageWorkItems,
    watch(request, changed, context) {
        const pending = observeTriageWorkItems(request, changed, context);
        void pending.catch(() => { if (!context.signal.aborted) changed(); });
        return () => { void pending.then(observation => observation.dispose()).catch(() => {}); };
    },
};

export async function findLinkedTriageWorkItems(request: PluginWorkItemsFindLinkedRequestV1, context: WorkItemContext): Promise<PluginWorkItemsFindLinkedResultV1> {
    context.signal.throwIfAborted();
    const sessionIds = [...new Set(request.sessionIds)];
    if (sessionIds.length === 0) return { itemIds: [], complete: true };
    const relations = createTriageSourceSessionRelations(context, bindCorpusCollections(requireTriageAccountStorage(context)), undefined, () => taskListForSurface(context));
    const [{ sources }, read] = await Promise.all([
        relations.readSources(), relations.readSessions(sessionIds),
    ]);
    context.signal.throwIfAborted();
    // The relation owner supplies both proven links and coverage, including partial reads.
    const itemIds = [...new Set(read.links.flatMap(link => {
        const kind = sources.get(renderSourceQualifiedId(link.entryRef.source))?.descriptor.kinds.find(kind => kind.id === link.entryRef.kindId);
        return kind?.task === true ? [buildTriageEntryRouteSegmentV1(link.entryRef)] : [];
    }))];
    return { itemIds, complete: read.kind === 'complete' };
}

export async function observeTriageWorkItems(request: PluginWorkItemsWatchRequestV1, changed: () => void, context: TriageDataActionContext): Promise<Disposable> {
    const entries = [...new Set(request.itemIds)].flatMap(itemId => {
        const entryRef = readTriageEntryRouteSegmentV1(itemId);
        return entryRef === null ? [] : [{ entryRef }];
    });
    const inputs: TriageReadSourceSessionLinksInputV1[] = [...new Set(request.sessionIds ?? [])].map(sessionId => ({ v: 1, sessionId }));
    if (entries.length > 0) inputs.push({ v: 1, entries });
    if (inputs.length === 0) return { dispose() {} };
    return observeTriageSourceSessionLinks(inputs, changed, context);
}

export async function transitionTriageWorkItem(request: PluginWorkItemTransitionInputV1, context: TriageDataActionContext): Promise<TriageTaskWriteResultV1> {
    const current = (await readWorkItems({ serverId: request.serverId, itemIds: [request.itemId] }, context)).get(request.itemId);
    if (current === undefined || !current.item.transitions?.some(transition => transition.id === request.transitionId)) {
        return { kind: 'refused', reason: 'unsupportedOperation' };
    }
    return TriageTaskWriteResultV1Schema.parse(await context.services.actions.execute({
        pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, localId: TRIAGE_TASKS_TRANSITION_ACTION_LOCAL_ID_V1,
    }, {
        v: 1, entryRef: current.entryRef, sourceInstanceId: current.sourceInstanceId,
        lastKnownLocator: current.locator, transitionId: request.transitionId,
    }, { signal: context.signal }));
}

export async function resolveTriageWorkItems(
    request: PluginWorkItemsResolveRequestV1,
    context: WorkItemContext,
): Promise<PluginWorkItemsResolveResultV1> {
    const current = await readWorkItems(request, context);
    return Object.fromEntries(request.itemIds.map(id => [id, current.get(id)?.item ?? null]));
}

async function readWorkItems(request: PluginWorkItemsResolveRequestV1, context: WorkItemContext): Promise<ReadonlyMap<string, ResolvedWorkItem>> {
    context.signal.throwIfAborted();
    const result = new Map<string, ResolvedWorkItem>();
    const entries = [...new Set(request.itemIds)].flatMap(itemId => {
        const entryRef = readTriageEntryRouteSegmentV1(itemId);
        return entryRef === null ? [] : [{ itemId, entryRef }];
    });
    if (entries.length === 0) return result;
    const relations = createTriageSourceSessionRelations(context, bindCorpusCollections(requireTriageAccountStorage(context)), undefined, () => taskListForSurface(context));
    const view = await relations.readSources();
    const tasks = entries.flatMap(entry => {
        const source = view.sources.get(renderSourceQualifiedId(entry.entryRef.source));
        const kind = source?.descriptor.kinds.find(kind => kind.id === entry.entryRef.kindId);
        return source && kind?.task === true ? [{ ...entry, source, kind }] : [];
    });
    const demands = tasks.map(task => ({ task,
        instances: view.configured.rows.filter(row => row.sourceQualifiedId === renderSourceQualifiedId(task.entryRef.source)),
    }));
    const internal = demands.flatMap(demand => demand.instances.flatMap(row => isInternalTaskConfiguredInstanceV1(row.configured)
        ? [{ task: demand.task, input: { v: 1, instance: row.configured,
            localRef: { kindId: demand.task.entryRef.kindId, collisionScope: demand.task.entryRef.collisionScope,
                entryId: demand.task.entryRef.entryId } } satisfies TriageGetInputV1 }] : []));
    // This plugin's task source composes its own admitted list once for both
    // observations and links. Other sources retain their targeted operations.
    const native = new Map((await getInternalTasks(internal.map(demand => demand.input), context,
        internal.length === 0 ? undefined : await taskListForSurface(context)))
        .map((result, index) => [internal[index]!.task, result]));
    const external = tasks.filter(task => !native.has(task));
    const externalLinks = external.length === 0 ? []
        : await relations.readEntries(external.map(task => ({ entryRef: task.entryRef })));
    const linked = new Map(external.map((task, index) => [task, externalLinks[index]?.result]));
    await Promise.all(demands.map(async ({ task, instances }) => {
        const reads = await Promise.all(instances.map(row => reobserveTriageEntry({
            entryRef: task.entryRef, sourceInstanceId: row.configured.instance.sourceInstanceId,
        }, {
            readConfiguredInstance: async id => view.configured.rows.find(row => row.configured.instance.sourceInstanceId === id)?.configured ?? null,
            readSourceSnapshot: async () => ({ contributions: [...view.sources.values()] }),
            executeGet: async (operation, input, options) => native.get(task)?.observation
                ?? context.services.actions.executeAdmittedTargetedOperation(operation, input, options),
            nowMs: () => context.invokedAtMs, signal: context.signal,
        })));
        const row = foldTriageListWindow({
            observations: reads.flatMap(read => read.kind === 'observed' ? [read.observation] : []),
            lanes: [], configuredSourcesStatus: 'complete',
            activeSourceInstanceIds: instances.map(row => row.configured.instance.sourceInstanceId),
            lens: { ...TRIAGE_LIST_DEFAULT_LENS_V1, limit: 1 }, assembledAtMs: context.invokedAtMs,
        }).rows[0];
        const links = native.get(task)?.sessionLinks ?? linked.get(task);
        if (row?.selected.kind !== 'selected' || row.content === null || links?.kind !== 'complete') return;
        const snapshot = row.content.outcome.snapshot;
        const transitions = task.source.operations.transition === undefined ? undefined
            : (snapshot.taskCapabilities ?? task.kind.taskCapabilities)?.transitions?.flatMap(transition => {
                const category = triageTaskStatusCategoryV1(transition.state);
                return category === null || (transition.requiredFields?.length ?? 0) > 0 ? []
                    : [{ id: transition.id, label: transition.label, category }];
            });
        const item: PluginWorkItemV1 = {
            title: snapshot.title, category: triageTaskStatusCategoryV1(snapshot.state),
            ...(snapshot.state.nativeLabel === undefined ? {} : { categoryLabel: snapshot.state.nativeLabel }),
            ...(snapshot.relations?.parent === undefined ? {} : { parentItemId: buildTriageEntryRouteSegmentV1(snapshot.relations.parent) }),
            linkedSessions: links.links.map(link => ({ serverId: request.serverId, sessionId: link.sessionId })),
            page: { pageId: 'tasks', subPath: buildTriageRouteSubPathV1({ ...TRIAGE_ROUTE_DEFAULT_LENS_V1,
                filters: { ...TRIAGE_ROUTE_DEFAULT_LENS_V1.filters, tasks: 'mine' }, selection: task.entryRef }) },
            ...(transitions === undefined ? {} : { transitions }),
        };
        result.set(task.itemId, { item, entryRef: task.entryRef, sourceInstanceId: row.selected.sourceInstanceId,
            locator: row.content.outcome.locator });
    }));
    context.signal.throwIfAborted();
    return result;
}
