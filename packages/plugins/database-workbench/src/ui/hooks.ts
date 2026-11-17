import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { DatabaseCompletenessV1, DatabaseRelationV1, DatabaseStatsReadV1, DatabaseTargetsListInputV1 } from '@happier-dev/database-protocol';
import type { WorkbenchInstance } from './workbench.js';
import type { WorkbenchChange, WorkbenchLocation, WorkbenchStatementsObservation, WorkbenchStatus } from './models.js';
import type { WorkbenchResource } from './resource.js';
import type { CodeEditorProps, CodeEditorSelectionRange } from '@happier-dev/plugin-ui/presentation';
import { createDatabaseCompletionSource } from './completions.js';
import { createWorkbenchPaneState, workbenchPaneKey, type WorkbenchPaneIdentity, type WorkbenchPaneState } from './state.js';
import { selectRelationChanges } from './apply.js';

const paneState = createWorkbenchPaneState();

/** Scope is supplied by the opened Project/Session; the targets owner decides membership. */
export function useDatabasePaneState(scope: DatabaseTargetsListInputV1['scope'], identity?: WorkbenchPaneIdentity) {
    const key = workbenchPaneKey(scope, identity);
    const subscribe = useCallback((listener: () => void) => paneState.subscribe(key, listener), [key]);
    const get = useCallback(() => paneState.get(key), [key]);
    const pane = useSyncExternalStore(subscribe, get, get);
    const setPane = useCallback((value: WorkbenchPaneState) => paneState.set(key, value), [key]);
    return useMemo(() => ({ pane, setPane }), [pane, setPane]);
}

export function useDatabasePicker(scope: DatabaseTargetsListInputV1['scope'], identity?: WorkbenchPaneIdentity) {
    const targets = useDatabaseTargets(scope);
    const key = workbenchPaneKey(scope, identity);
    const subscribe = useCallback((listener: () => void) => paneState.subscribe(key, listener), [key]);
    const get = useCallback(() => paneState.get(key).targetKey, [key]);
    const selectedTargetKey = useSyncExternalStore(subscribe, get, get);
    const select = useCallback((targetKey: string) => {
        if (paneState.get(key).targetKey !== targetKey) paneState.set(key, { targetKey, location: null });
    }, [key]);
    return useMemo(() => ({ ...targets, selectedTargetKey, select }), [targets, selectedTargetKey, select]);
}

const WorkbenchContext = createContext<WorkbenchInstance | null>(null);
export function WorkbenchProvider(props: Readonly<{ instance: WorkbenchInstance; children?: ReactNode }>) {
    return createElement(WorkbenchContext.Provider, { value: props.instance }, props.children);
}
export function useWorkbenchInstance(): WorkbenchInstance {
    const instance = useContext(WorkbenchContext);
    if (!instance) throw new Error('Database hooks require a WorkbenchProvider');
    return instance;
}
function useResource<T>(resource: WorkbenchResource<T>) {
    const snapshot = useSyncExternalStore(resource.subscribe, resource.get, resource.get);
    useEffect(() => { void resource.demand(); }, [resource]);
    return snapshot;
}
/** Page intent stays local; acquisition and revisits use the instance's existing resources. */
function useCatalogueCursor(identity: object, firstAfter?: string) {
    const initial = useMemo(() => ({ identity, cursors: [firstAfter] }), [identity, firstAfter]);
    const [held, setHeld] = useState(initial);
    const history = held.identity === identity ? held : initial;
    const next = useCallback((after: string) => setHeld({ identity, cursors: [...history.cursors, after] }), [identity, history]);
    const previous = useCallback(() => setHeld({ identity, cursors: history.cursors.slice(0, -1) }), [identity, history]);
    return { after: history.cursors[history.cursors.length - 1], next,
        previousPage: history.cursors.length > 1 ? previous : undefined };
}
function catalogueAfter(completeness: DatabaseCompletenessV1 | undefined) {
    return completeness && !completeness.complete && completeness.continuation?.kind === 'catalog'
        ? completeness.continuation.after : undefined;
}
function useLocationValue<T>(instance: WorkbenchInstance, select: (location: WorkbenchLocation) => T): T {
    const subscribe = useCallback((listener: () => void) => instance.local.subscribe('location', listener), [instance]);
    const get = useCallback(() => select(instance.local.get('location')), [instance, select]);
    return useSyncExternalStore(subscribe, get, get);
}
const selectLocation = (location: WorkbenchLocation) => location;
export function projectWorkbenchStatus<T>(snapshot: ReturnType<WorkbenchResource<T>['get']>, empty = false): WorkbenchStatus {
    if (snapshot.status === 'loading') return 'loading';
    if (snapshot.status === 'failed') {
        if (snapshot.data !== undefined) return 'stale';
        return 'unavailable';
    }
    return empty ? 'empty' : 'ready';
}
const emptyTargets = Object.freeze([]);
const emptySchemas = Object.freeze([]);
const emptyColumns = Object.freeze([]);
const emptyRows = Object.freeze([]);
export function useDatabaseTargets(scope: DatabaseTargetsListInputV1['scope']) {
    const instance = useWorkbenchInstance();
    const resource = instance.targets(scope);
    const snapshot = useResource(resource);
    return useMemo(() => ({ targets: snapshot.data?.targets ?? emptyTargets, looked: snapshot.data?.looked ?? emptyTargets,
        completeness: snapshot.data?.completeness,
        status: projectWorkbenchStatus(snapshot, snapshot.data?.targets.length === 0), error: snapshot.error,
        refresh: () => resource.invalidate() }), [snapshot, resource]);
}
export function useDatabaseRelations(targetKey: string, after?: string) {
    const instance = useWorkbenchInstance();
    const cursor = useCatalogueCursor(instance.relations(targetKey, after), after);
    const resource = instance.relations(targetKey, cursor.after);
    const snapshot = useResource(resource);
    return useMemo(() => {
        const completeness = snapshot.data?.completeness;
        const nextPageAfter = catalogueAfter(completeness);
        return { schemas: snapshot.data?.schemas ?? emptySchemas, completeness, nextPageAfter,
            nextPage: nextPageAfter === undefined ? undefined : () => cursor.next(nextPageAfter), previousPage: cursor.previousPage,
            status: projectWorkbenchStatus(snapshot, snapshot.data?.schemas.length === 0),
            error: snapshot.error, refresh: () => resource.invalidate() };
    }, [snapshot, resource, cursor.next, cursor.previousPage]);
}
/** Mount in an expanded group. Unopened schemas perform zero relation reads. */
export function useDatabaseSchemaRelations(targetKey: string, schema: string, after?: string) {
    const instance = useWorkbenchInstance();
    const cursor = useCatalogueCursor(instance.schemaRelations(targetKey, schema, after), after);
    const resource = instance.schemaRelations(targetKey, schema, cursor.after);
    const snapshot = useResource(resource);
    return useMemo(() => {
        const completeness = snapshot.data?.completeness;
        const nextPageAfter = catalogueAfter(completeness);
        return { relations: snapshot.data?.relations ?? emptyRows, completeness,
            nextPageAfter, nextPage: nextPageAfter === undefined ? undefined : () => cursor.next(nextPageAfter),
            previousPage: cursor.previousPage,
            status: projectWorkbenchStatus(snapshot, snapshot.data?.relations.length === 0), error: snapshot.error,
            refresh: () => resource.invalidate() };
    }, [snapshot, resource, cursor.next, cursor.previousPage]);
}
export function useRelationPage(location: WorkbenchLocation) {
    const instance = useWorkbenchInstance();
    const resource = instance.page(location);
    const snapshot = useResource(resource);
    return useMemo(() => ({ ...snapshot.data, columns: snapshot.data?.columns ?? emptyColumns, rows: snapshot.data?.rows ?? emptyRows,
        page: snapshot.data?.page ?? { offset: location.page.offset, limit: location.page.rows, approxTotal: null, hasNext: false },
        sort: location.sort, conditions: location.conditions,
        capabilities: snapshot.data?.capabilities ?? { edit: false, insert: false, delete: false },
        status: projectWorkbenchStatus(snapshot, snapshot.data?.rows.length === 0), error: snapshot.error,
        cellValue: snapshot.data?.cellValue, inspectJson: snapshot.data?.inspectJson, foreignKey: snapshot.data?.foreignKey,
        exportInput: snapshot.data?.exportInput, refresh: () => resource.invalidate() }), [snapshot, resource, location]);
}
export function useStructure(relation: DatabaseRelationV1) {
    const instance = useWorkbenchInstance();
    const location = useWorkbenchLocation();
    const resource = instance.structure(location.targetKey, relation);
    const snapshot = useResource(resource);
    return useMemo(() => ({ columns: snapshot.data?.columns.map(column => ({ name: column.name, type: column.nativeType,
        nullable: column.nullable, default: column.defaultExpression ?? null })) ?? emptyColumns,
        viewDefinition: snapshot.data?.viewDefinition,
        primaryKey: snapshot.data?.primaryKey ?? emptyColumns, foreignKeys: snapshot.data?.foreignKeys ?? emptyRows,
        indexes: snapshot.data?.indexes.map(index => ({ ...index, method: null })) ?? emptyRows,
        status: snapshot.status === 'failed' ? 'unsupported' as const : snapshot.status === 'loading' ? 'loading' as const
            : snapshot.data?.columns.length ? 'loaded' as const : 'empty' as const,
        error: snapshot.error, refresh: () => resource.invalidate() }), [snapshot, resource]);
}
export function useWorkbenchLocation() {
    const instance = useWorkbenchInstance();
    const location = useLocationValue(instance, selectLocation);
    return useMemo(() => ({ ...location, navigate: instance.navigate, back: instance.back }), [instance, location]);
}
/** Call from the resize-end intent; pointer movement stays inside Collection. */
export function useWorkbenchColumnWidths(relation: DatabaseRelationV1) {
    const instance = useWorkbenchInstance();
    const select = useCallback((location: WorkbenchLocation) => JSON.stringify([location.targetKey, relation]),
        [relation.database, relation.schema, relation.name]);
    const key = useLocationValue(instance, select);
    const subscribe = useCallback((listener: () => void) => instance.widths.subscribe(key, listener), [instance, key]);
    const get = useCallback(() => instance.widths.get(key), [instance, key]);
    const value = useSyncExternalStore(subscribe, get, get);
    const commit = useCallback((widths: Readonly<Record<string, number>>) => instance.widths.set(key, widths), [instance, key]);
    return useMemo(() => ({ widths: value, commit }), [value, commit]);
}
export function useDatabaseAccess(targetKey: string) {
    const instance = useWorkbenchInstance();
    const resource = instance.access(targetKey);
    const snapshot = useResource(resource);
    return useMemo(() => ({ ...snapshot.data, status: projectWorkbenchStatus(snapshot), error: snapshot.error }), [snapshot]);
}
export function useWorkbenchDraft(instance: WorkbenchInstance, scope?: Readonly<{ targetKey: string; relation: DatabaseRelationV1 }>) {
    const changes = useSyncExternalStore(instance.drafts.subscribe, instance.drafts.changes, instance.drafts.changes);
    const select = useCallback((location: WorkbenchLocation) => {
        const targetKey = scope?.targetKey ?? location.targetKey;
        const relation = scope?.relation ?? location.relation;
        return relation ? JSON.stringify([targetKey, relation]) : '';
    }, [scope?.targetKey, scope?.relation]);
    const key = useLocationValue(instance, select);
    const location = instance.local.get('location');
    const targetKey = scope?.targetKey ?? location.targetKey;
    const relation = scope?.relation ?? location.relation;
    const subscribe = useCallback((listener: () => void) => instance.applyOutcomes.subscribe(key, listener), [instance, key]);
    const get = useCallback(() => instance.applyOutcomes.get(key), [instance, key]);
    const outcome = useSyncExternalStore(subscribe, get, get);
    return useMemo(() => {
        const selected = selectRelationChanges(changes, targetKey, relation);
        return {
            counts: { edits: selected.filter(item => item.change.kind === 'update').length, inserts: selected.filter(item => item.change.kind === 'insert').length,
                removals: selected.filter(item => item.change.kind === 'delete').length },
            stage: (change: WorkbenchChange) => instance.drafts.stage(instance.draftKey(change), change),
            takeBack: (change: Pick<WorkbenchChange, 'rowKey' | 'relation' | 'targetKey'>) => instance.drafts.takeBack(instance.draftKey(change)),
            discard: () => instance.drafts.takeBackMany(selected.map(instance.draftKey)),
            cellState: (rowKey: string, column: string) => instance.cellState(rowKey, column),
            review: () => instance.review(targetKey, relation),
            apply: instance.apply,
            outcome,
        };
    }, [changes, instance, outcome, targetKey, relation]);
}

/** Completion reads held metadata only; unopened schemas and columns stay unread. */
export function useDatabaseCompletions(targetKey: string, relation?: DatabaseRelationV1) {
    const instance = useWorkbenchInstance();
    return useMemo(() => createDatabaseCompletionSource(() => ({
        schemas: instance.relations(targetKey).get().data?.schemas,
        ...(relation ? { relations: instance.schemaRelations(targetKey, relation.schema).get().data?.relations,
            columns: instance.structure(targetKey, relation).get().data?.columns } : {}),
    })), [instance, targetKey, relation?.database, relation?.schema, relation?.name]);
}

export function useDatabaseConsole(targetKey: string) {
    const instance = useWorkbenchInstance();
    const location = useWorkbenchLocation();
    const completionSource = useDatabaseCompletions(targetKey, location.relation);
    const controller = instance.console(targetKey);
    const text = useSyncExternalStore(controller.text.subscribe, controller.text.get, controller.text.get);
    const subscribeSelection = useCallback((listener: () => void) => controller.selection.subscribe('selection', listener), [controller]);
    const getSelection = useCallback(() => controller.selection.get('selection'), [controller]);
    const selection = useSyncExternalStore(subscribeSelection, getSelection, getSelection);
    const subscribeExecution = useCallback((listener: () => void) => controller.execution.subscribe('run', listener), [controller]);
    const getExecution = useCallback(() => controller.execution.get('run'), [controller]);
    const execution = useSyncExternalStore(subscribeExecution, getExecution, getExecution);
    const subscribeParameters = useCallback((listener: () => void) => controller.parameterInputs.subscribe('parameters', listener), [controller]);
    const getParameters = useCallback(() => controller.parameterInputs.get('parameters'), [controller]);
    const parameterInputs = useSyncExternalStore(subscribeParameters, getParameters, getParameters);
    const onSelection = useCallback((range: CodeEditorSelectionRange | null) => { if (range) controller.setSelection(range); }, [controller]);
    const editorProps = useMemo(() => ({ value: text.sql, onChange: controller.setText, onSelection, completionSource,
        language: 'sql', resetKey: targetKey } satisfies CodeEditorProps), [controller, onSelection, completionSource, targetKey, text.sql]);
    return useMemo(() => ({ text: text.sql, history: text.history, selection, parameterInputs, ...execution,
        setText: controller.setText, setSelection: controller.setSelection, setMode: controller.setMode, setParameters: controller.setParameters, setParameterInputs: controller.setParameterInputs,
        run: controller.run, explain: controller.explain, cancel: controller.cancel, clearHistory: controller.clearHistory,
        editorProps }), [controller, text, selection, parameterInputs, execution, editorProps]);
}
export function useWorkbenchCellState(rowKey: string, column: string) {
    const instance = useWorkbenchInstance();
    const select = useCallback((location: WorkbenchLocation) => location.relation
        ? instance.draftKey({ targetKey: location.targetKey, relation: location.relation, rowKey }) : '', [instance, rowKey]);
    const key = useLocationValue(instance, select);
    const subscribe = useCallback((listener: () => void) => instance.drafts.subscribeRow(key, listener), [instance, key]);
    const get = useCallback(() => instance.drafts.get(key), [instance, key]);
    const row = useSyncExternalStore(subscribe, get, get);
    return useMemo(() => instance.cellState(rowKey, column), [instance, row, rowKey, column, key]);
}

/** Statements, tables or indexes: one read per open or Refresh. Unavailable is an answer, not a failure. */
export function useDatabaseInsights(targetKey: string, request: Exclude<DatabaseStatsReadV1, { group: 'activity' }>) {
    const instance = useWorkbenchInstance();
    const resource = instance.stats(targetKey, request);
    const snapshot = useResource(resource);
    return useMemo(() => ({ observation: snapshot.data, status: projectWorkbenchStatus(snapshot), error: snapshot.error,
        refresh: () => resource.invalidate() }), [snapshot, resource]);
}

/**
 * "Since your last look" for the statements on screen (R13). One host lifetime per mounted target: the first
 * successful sample of this view records the shown rows once; Refresh compares to that held baseline.
 */
export function useStatementsLastLook(targetKey: string, observation: WorkbenchStatementsObservation | undefined,
    shownKeys: readonly string[]) {
    const instance = useWorkbenchInstance();
    const lastLook = useMemo(() => {
        try { return instance.lastLook(targetKey); } catch { return null; }
    }, [instance, targetKey]);
    const shown = shownKeys.join('\n');
    return useMemo(() => observation && lastLook ? lastLook.observe(observation, shownKeys) : null,
        // The shown keys are compared by value; a new array with the same rows is the same look.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [lastLook, observation, shown]);
}

/** D21: about 5 s while the Activity view is presented, zero while hidden (owner, 2026-11-16). */
export const DATABASE_ACTIVITY_REFRESH_MS = 5000;
const noActivity = { value: null, loading: true, error: null } as const;
/** Live activity: the host's presented-demand owner refreshes it only while this view is shown. */
export function useDatabaseActivity(targetKey: string, request: Extract<DatabaseStatsReadV1, { group: 'activity' }>, presented: boolean) {
    const instance = useWorkbenchInstance();
    const resource = useMemo(() => {
        try { return instance.activity(targetKey, request); } catch { return null; }
        // The request is compared by value.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [instance, targetKey, JSON.stringify(request)]);
    const subscribe = useCallback((listener: () => void) => resource?.subscribe(listener) ?? (() => undefined), [resource]);
    const get = useCallback(() => resource?.getSnapshot() ?? noActivity, [resource]);
    const snapshot = useSyncExternalStore(subscribe, get, get);
    useEffect(() => {
        if (!resource || !presented) return;
        return resource.retainAutoRefresh({ intervalMs: DATABASE_ACTIVITY_REFRESH_MS });
    }, [resource, presented]);
    return useMemo(() => ({ observation: snapshot.value ?? undefined, loading: snapshot.loading, error: snapshot.error,
        supported: resource !== null, refresh: () => resource?.refresh() }), [snapshot, resource]);
}
