import type {
    DatabaseCellResultV1,
    DatabaseDescriptorV1,
    DatabaseFailureV1,
    DatabaseIncomingForeignKeyV1,
    DatabaseNamedCellV1,
    DatabaseRowsResultV1,
    DatabaseOperationResultV1,
    DatabaseRelationV1,
    DatabaseTargetV1,
    DatabaseTargetsListInputV1,
    DatabaseStatsReadV1,
    DatabaseStatsObservationV1,
} from '@happier-dev/plugin-sdk/database';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createCanonicalJsonSigningInput, PluginError } from '@happier-dev/plugin-sdk';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import { workbenchTargetKey } from '../targetIdentity.js';
import { inspectJsonCell } from './cellInspection.js';
import { createConsoleState } from './consoleState.js';
import { createConsole, type WorkbenchConsole } from './console.js';
import { createStagedEdits } from './drafts.js';
import { projectRelationPage } from './projections.js';
import { databaseEngineName, databaseFacts } from './surface/engines.js';
import { createResource, type WorkbenchResource } from './resource.js';
import { createKeyedState } from './state.js';
import { createApplyControl, projectStagedApplyInput, selectRelationChanges } from './apply.js';
import { sameRelation, mergeWorkbenchLocation, foreignKeyNavigation, incomingForeignKeyNavigation, foreignKeyBack, keyEqualityFilter } from './location.js';
import type {
    DatabaseRelations, DatabaseTargets, WorkbenchApplyOutcome, WorkbenchChange, WorkbenchLocation,
    WorkbenchOptions, WorkbenchReview, WorkbenchCellState, WorkbenchActivityResource, WorkbenchControlBinding,
    WorkbenchConflictReloadFailure,
} from './models.js';

export class WorkbenchOperationError extends PluginError {
    constructor(readonly failure: DatabaseFailureV1) {
        super({
            code: failure.code,
            message: ('cause' in failure ? failure.cause?.message : undefined) ?? ('reason' in failure ? failure.reason : undefined),
            details: projectNativeJsonValueForTransport(failure),
        });
    }
}
function success<O extends Extract<DatabaseOperationResultV1, { ok: true }>['operation']>(result: DatabaseOperationResultV1, operation: O): Extract<DatabaseOperationResultV1, { ok: true; operation: O }> {
    if (!result.ok) throw new WorkbenchOperationError(result);
    if (result.operation !== operation) throw new TypeError('Database operation returned a different result kind');
    // The operation discriminant proves this generic correlation.
    return result as Extract<DatabaseOperationResultV1, { ok: true; operation: O }>;
}
const key = (value: unknown): string => JSON.stringify(value);
export { workbenchTargetKey } from '../targetIdentity.js';
type ReviewScope = Pick<WorkbenchChange, 'targetKey' | 'relation'>;
type DraftRow = ReviewScope & Pick<WorkbenchChange, 'rowKey'>;
const draftKey = (row: DraftRow) => key([row.targetKey, row.relation, row.rowKey]);
const reviewKey = (scope: ReviewScope) => key([scope.targetKey, scope.relation]);
type ApplyConflict = Extract<WorkbenchApplyOutcome, { kind: 'conflict' }>;

/** A physical workbench occurrence owns this object until close/Account retirement. */
export function createWorkbenchInstance(options: WorkbenchOptions) {
    const { client } = options;
    const reads = new AbortController();
    const resources = new Map<string, { targetKey?: string; relation?: DatabaseRelationV1; resource: { invalidate(): void; dispose?(): void } }>();
    const targets = new Map<string, DatabaseDescriptorV1>();
    const local = createKeyedState<WorkbenchLocation>(() => options.location);
    const widths = createKeyedState<Readonly<Record<string, number>>>(() => ({}));
    const drafts = createStagedEdits<WorkbenchChange>();
    const applyOutcomes = createKeyedState<WorkbenchApplyOutcome | undefined>(() => undefined);
    const applyControls = new Map<string, WorkbenchControlBinding>();
    const consoleStores = new Map<string, ReturnType<typeof createConsoleState>>();
    const consoles = new Map<string, WorkbenchConsole>();
    let closed = false;
    if (options.selectedTarget) targets.set(workbenchTargetKey(options.selectedTarget.target), options.selectedTarget);
    function resource<T>(
        resourceKey: string, load: () => Promise<T>, targetKey?: string, relation?: DatabaseRelationV1,
        equivalent?: (previous: T, next: T) => boolean,
    ): WorkbenchResource<T> {
        if (closed) throw new Error('Workbench instance is closed');
        const held = resources.get(resourceKey);
        // Each private key is bound to one loader/result type for this instance.
        if (held) return held.resource as WorkbenchResource<T>;
        const value = createResource(load, equivalent);
        resources.set(resourceKey, { targetKey, relation, resource: value as WorkbenchResource<unknown> });
        return value;
    }
    function target(targetKey: string): DatabaseDescriptorV1 {
        const descriptor = targets.get(targetKey);
        if (!descriptor) throw new Error('Select a discovered database target first');
        return descriptor;
    }
    function invalidate(targetKey?: string, relation?: DatabaseRelationV1) {
        for (const held of resources.values()) {
            if (targetKey !== undefined && held.targetKey !== targetKey) continue;
            if (relation && (!held.relation || !sameRelation(held.relation, relation))) continue;
            held.resource.invalidate();
        }
    }
    const unsubscribe = client.subscribeOwnWrites(change => invalidate(workbenchTargetKey(change.target), change.relation));
    const draftOff = drafts.subscribeDirty(dirty => { void client.setUnsavedChanges(dirty); });
    function structure(targetKey: string, relation: DatabaseRelationV1) {
        return resource(key(['structure', targetKey, relation]), async () => success(await client.operation({ operation: 'relation.structure', target: target(targetKey).target, relation }, reads.signal), 'relation.structure').structure, targetKey, relation);
    }
    function consoleState(targetKey: string) {
        let held = consoleStores.get(targetKey);
        if (!held) {
            held = createConsoleState(options.consoleStorage(target(targetKey)));
            consoleStores.set(targetKey, held);
            void held.load().catch(client.presentDeviceStorageError);
        }
        return held;
    }
    function conflictAt(scope: ReviewScope): ApplyConflict | undefined {
        const held = applyOutcomes.get(reviewKey(scope));
        return held?.kind === 'conflict' ? held : undefined;
    }
    function conflictHasDraft(scope: ReviewScope, conflict: ApplyConflict): boolean {
        return conflict.why === 'relation_changed'
            ? selectRelationChanges(drafts.changes(), scope.targetKey, scope.relation).length !== 0
            : drafts.get(draftKey({ ...scope, rowKey: conflict.rowKey })) !== undefined;
    }
    const instance = {
        scope: options.scope,
        local,
        widths,
        drafts,
        applyOutcomes,
        draftKey,
        reviewKey,
        takeBackChanges(scope: ReviewScope, rowKeys: readonly string[]) {
            drafts.takeBackMany(rowKeys.map(rowKey => draftKey({ ...scope, rowKey })));
            const conflict = conflictAt(scope);
            if (conflict && !conflictHasDraft(scope, conflict)) applyOutcomes.set(reviewKey(scope), undefined);
        },
        async reloadConflict(row: DraftRow) {
            const conflict = conflictAt(row);
            const rowDraftKey = draftKey(row);
            const held = drafts.get(rowDraftKey);
            if (closed || !conflict || conflict.why === 'relation_changed' || conflict.rowKey !== row.rowKey
                || !held || held.change.kind === 'insert') return;

            const change = held.change;
            const columns = (change.kind === 'update' ? change.original : change.key).map(cell => cell.column);
            const outcomeKey = reviewKey(row);
            const settlesCurrentDraft = () => !closed && conflictAt(row) === conflict && drafts.get(rowDraftKey) === held;
            const recordReloadFailure = (reloadFailure: WorkbenchConflictReloadFailure) => {
                if (settlesCurrentDraft()) applyOutcomes.set(outcomeKey, { ...conflict, reloadFailure });
            };
            let result: DatabaseRowsResultV1;
            try {
                result = success(await client.operation({
                    operation: 'rows.read', target: target(row.targetKey).target, relation: row.relation, columns, order: [],
                    filter: keyEqualityFilter(change.key), page: { rows: 1 },
                }, reads.signal), 'rows.read').result;
            } catch (error) {
                return recordReloadFailure({ kind: 'failed', error });
            }
            if (!settlesCurrentDraft()) return;
            const [loaded] = result.rows;
            if (!result.completeness.complete || result.rows.length > 1) return recordReloadFailure({ kind: 'incomplete' });
            if (!loaded) return recordReloadFailure({ kind: 'missing' });
            const original: DatabaseNamedCellV1[] = [];
            for (const column of columns) {
                const value = loaded.cells[result.columns.findIndex(loadedColumn => loadedColumn.name === column)];
                if (!value || value.type === 'partial') return recordReloadFailure({ kind: 'incomplete' });
                original.push({ column, value });
            }
            if (change.kind === 'update') drafts.stage(rowDraftKey, { ...held, change: { ...change, original } });
            applyOutcomes.set(outcomeKey, undefined);
        },
        cellState(rowKey: string, column: string): WorkbenchCellState {
            const location = local.get('location');
            if (!location.relation) return { kind: 'unchanged' };
            const held = drafts.get(draftKey({ targetKey: location.targetKey, relation: location.relation, rowKey }));
            if (!held) return { kind: 'unchanged' };
            if (held.change.kind === 'delete') return { kind: 'removed' };
            if (held.change.kind === 'insert') return { kind: 'inserted' };
            return held.change.values.some(value => value.column === column)
                ? { kind: 'edited', old: held.change.original.find(value => value.column === column)?.value }
                : { kind: 'unchanged' };
        },
        review(selected: readonly WorkbenchChange[]): { groups: WorkbenchReview; input: JsonValue } {
            const first = selected[0];
            if (!first) return { groups: [], input: null };
            const rows = selected.map(held => {
                const change = held.change;
                return { rowKey: held.rowKey, label: held.label, kind: change.kind,
                    changes: change.kind === 'delete' ? change.key.map(cell => ({ column: cell.column, old: cell.value }))
                        : change.values.map(value => ({ column: value.column, new: value.value,
                            ...(change.kind === 'update' ? { old: change.original.find(cell => cell.column === value.column)?.value } : {}) })) };
            });
            return { groups: [{ relation: first.relation, rows }],
                input: projectStagedApplyInput(target(first.targetKey).target, first.relation, selected) };
        },
        target,
        /** Account/target retirement shares close's resource cancellation owner. */
        retireTarget(targetKey: string) {
            for (const [resourceKey, held] of resources) {
                if (held.targetKey !== targetKey) continue;
                held.resource.dispose?.();
                resources.delete(resourceKey);
            }
            targets.delete(targetKey);
            consoleStores.delete(targetKey);
        },
        activity(targetKey: string, request: Extract<DatabaseStatsReadV1, { group: 'activity' }>): WorkbenchActivityResource<DatabaseStatsObservationV1> {
            if (closed) throw new Error('Workbench instance is closed');
            const resourceKey = key(['activity', targetKey, request]);
            const held = resources.get(resourceKey);
            if (held) return held.resource as WorkbenchActivityResource<DatabaseStatsObservationV1>;
            if (!options.activityResource) throw new Error('Activity requires the host presented-demand resource owner');
            const descriptor = target(targetKey);
            const value = options.activityResource({ read: async ({ signal }) => success(await client.operation({
                operation: 'stats.read', target: descriptor.target, request,
            }, signal), 'stats.read').observation });
            resources.set(resourceKey, { targetKey, resource: value });
            return value;
        },
        /** One statements/tables/indexes read per open or Refresh; the producer owns ranking and coverage. */
        stats(targetKey: string, request: Exclude<DatabaseStatsReadV1, { group: 'activity' }>): WorkbenchResource<DatabaseStatsObservationV1> {
            return resource(key(['stats', targetKey, request]), async () => success(await client.operation({
                operation: 'stats.read', target: target(targetKey).target, request,
            }, reads.signal), 'stats.read').observation, targetKey);
        },
        lastLook(targetKey: string) {
            if (closed) throw new Error('Workbench instance is closed');
            if (!options.lastLook) throw new Error('Statements comparison requires the host device-local last-look owner');
            return options.lastLook(target(targetKey).target);
        },
        consoleState,
        statementRanges: options.statementRanges,
        client,
        targets(scope: DatabaseTargetsListInputV1['scope']) {
            return resource<DatabaseTargets>(key(['targets', scope]), async () => {
                // An exact page already holds the descriptor from its target read.
                const result: Awaited<ReturnType<typeof client.targets>> = options.selectedTarget
                    ? { targets: [options.selectedTarget], completeness: { complete: true } }
                    : await client.targets({ scope }, reads.signal);
                const machineReads = new Map<string, ReturnType<NonNullable<typeof client.machineDisplayName>>>();
                return { targets: await Promise.all(result.targets.map(async descriptor => {
                    const targetKey = workbenchTargetKey(descriptor.target);
                    targets.set(targetKey, descriptor);
                    const source = descriptor.target.kind === 'worktree' ? descriptor.target.source : undefined;
                    const { serverId, machineId } = descriptor.placement;
                    const machineKey = key([serverId, machineId]);
                    if (client.machineDisplayName && !machineReads.has(machineKey)) {
                        machineReads.set(machineKey, client.machineDisplayName({ serverId, machineId }, { signal: reads.signal }));
                    }
                    const machine = await machineReads.get(machineKey);
                    return { targetKey, target: descriptor.target, name: descriptor.label, engineLabel: databaseEngineName(descriptor.engine),
                        facts: databaseFacts(descriptor),
                        origin: source?.kind === 'service' ? { variable: source.variable, serviceName: source.serviceId } : { connectedBy: descriptor.origin.label },
                        endpointLabel: descriptor.endpointLabel ?? null, relationCount: null,
                        machineLabel: machine?.status === 'ready' ? machine.displayName : null };
                })), looked: result.looked ?? [], completeness: result.completeness };
            }, undefined, undefined, (previous, next) =>
                createCanonicalJsonSigningInput(projectNativeJsonValueForTransport(previous)) ===
                createCanonicalJsonSigningInput(projectNativeJsonValueForTransport(next)));
        },
        /** Schema page only. Expanded groups demand their own relation page. */
        relations(targetKey: string, after?: string) {
            return resource<DatabaseRelations>(key(['schemas', targetKey, after]), async () => {
                const result = success(await client.operation({ operation: 'schemas.list', target: target(targetKey).target,
                    page: { rows: options.cataloguePageRows, ...(after ? { after } : {}) } }, reads.signal), 'schemas.list');
                return { schemas: result.schemas.map(schema => ({ name: schema.name, relations: [] })), completeness: result.completeness };
            }, targetKey);
        },
        schemaRelations(targetKey: string, schema: string, after?: string) {
            return resource(key(['relations', targetKey, schema, after]), async () => {
                const result = success(await client.operation({ operation: 'relations.list', target: target(targetKey).target, schema,
                    page: { rows: options.cataloguePageRows, ...(after ? { after } : {}) } }, reads.signal), 'relations.list');
                return { relations: result.relations.map(item => ({ name: item.relation.name,
                    kind: item.kind === 'materialized_view' ? 'matview' as const : item.kind, approxRows: item.estimatedRows ?? null, ...(item.size ? { size: item.size } : {}) })),
                    completeness: result.completeness };
            }, targetKey);
        },
        structure,
        page(location: WorkbenchLocation) {
            if (!location.relation) throw new Error('Select a relation first');
            const relation = location.relation;
            return resource(key(['page', location.targetKey, relation, location.conditions, location.sort, location.columns, location.page]), async () => {
                const detail = structure(location.targetKey, relation);
                const [metadataDemand, page] = await Promise.allSettled([
                    detail.demand(),
                    client.operation({ operation: 'rows.read', target: target(location.targetKey).target, relation,
                        columns: [...location.columns], order: [...location.sort], ...(location.conditions ? { filter: location.conditions } : {}),
                        page: { rows: location.page.rows, ...(location.page.continuation ? { continuation: location.page.continuation } : {}) } }, reads.signal),
                ]);
                if (metadataDemand.status === 'rejected') throw metadataDemand.reason;
                const metadata = detail.get();
                if (!metadata.data) throw metadata.error;
                if (page.status === 'rejected') throw page.reason;
                const result = success(page.value, 'rows.read').result;
                const projected = projectRelationPage(result, metadata.data);
                const capability = metadata.data.capabilities.find(item => item.operation === 'edits.apply');
                const available = capability?.available === true;
                return { ...projected, insertColumns: metadata.data.columns, page: { offset: location.page.offset, limit: location.page.rows, approxTotal: result.estimate ?? null,
                    hasNext: !result.completeness.complete && result.completeness.continuation?.kind === 'keyset' || !result.completeness.complete && result.completeness.continuation?.kind === 'offset' },
                    sort: location.sort, conditions: location.conditions,
                    foreignKey(rowKey: string, constraintName: string) {
                        const row = projected.rows.find(candidate => candidate.rowKey === rowKey);
                        const foreignKey = metadata.data!.foreignKeys.find(candidate => candidate.name === constraintName);
                        if (!row || !foreignKey) return { status: 'unavailable' as const, reason: 'missing_key' as const };
                        return foreignKeyNavigation(local.get('location'), foreignKey, result.columns.map(column => column.name), row.cells);
                    },
                    incomingForeignKeys: metadata.data.incomingForeignKeys ?? [],
                    // The columns whose value alone tells rows apart: a whole-table unique index on that one column.
                    uniqueColumns: metadata.data.indexes.flatMap(index => index.unique && !index.primary && index.predicate === undefined
                        && index.columns.length === 1 && index.columns[0]!.kind === 'column' ? [index.columns[0]!.column] : []),
                    incomingForeignKey(rowKey: string, reference: DatabaseIncomingForeignKeyV1) {
                        const row = projected.rows.find(candidate => candidate.rowKey === rowKey);
                        if (!row) return { status: 'unavailable' as const, reason: 'missing_key' as const };
                        return incomingForeignKeyNavigation(local.get('location'), reference, result.columns.map(column => column.name), row.cells);
                    },
                    exportInput(rowKeys: readonly string[], format: 'csv' | 'json') {
                        const selected = new Set(rowKeys);
                        return { format, result: { columns: result.columns,
                            rows: result.rows.filter((_row, index) => selected.has(projected.rows[index]!.rowKey)).map(({ cells }) => ({ cells })),
                            completeness: result.completeness } };
                    },
                    capabilities: { edit: available, insert: available, delete: available,
                        ...(capability?.available === false ? { reason: capability.reason } : {}) },
                    cellValue: readCell,
                    inspectJson(rowKey: string, column: string) {
                        const row = projected.rows.find(candidate => candidate.rowKey === rowKey);
                        const cell = row?.cells[result.columns.findIndex(candidate => candidate.name === column)];
                        if (!cell) throw new Error('Select a loaded cell first');
                        return inspectJsonCell(cell, range => readCell(rowKey, column, range));
                    } };
                async function readCell(rowKey: string, column: string, range: Parameters<import('./models.js').WorkbenchCellRead>[2]): Promise<DatabaseCellResultV1> {
                    const row = projected.rows.find(candidate => candidate.rowKey === rowKey);
                    if (!row?.identity) throw new Error('This result has no row identity for value inspection');
                    const cell = resource(key(['cell', location.targetKey, relation, row.identity.key, column, range]), async () => {
                        const value = success(await client.operation({ operation: 'cell.read', target: target(location.targetKey).target,
                            relation, key: row.identity!.key, column, range }, reads.signal), 'cell.read');
                        return { value: value.value, completeness: value.completeness };
                    }, location.targetKey, relation);
                    await cell.demand();
                    const held = cell.get();
                    if (held.status === 'failed') throw held.error;
                    return held.data!;
                }
            }, location.targetKey, relation);
        },
        access(targetKey: string) { return resource(key(['access', targetKey]), () => client.access(target(targetKey).target, reads.signal), targetKey); },
        console(targetKey: string): WorkbenchConsole {
            let held = consoles.get(targetKey);
            if (!held) { held = createConsole(instance, targetKey); consoles.set(targetKey, held); }
            return held;
        },
        async navigate(intent: Partial<WorkbenchLocation>, signal?: AbortSignal) {
            const next = mergeWorkbenchLocation(local.get('location'), intent);
            await client.navigate(next, signal);
            signal?.throwIfAborted();
            local.set('location', next);
            return next;
        },
        /** Go to the database's root, where a link straight to a place reopens from, so Back reaches the rail. */
        async openRoot() {
            await client.openRoot();
        },
        /** The host moved the page (its Back, Forward or a link): take its place without writing it back. */
        adopt(place: Pick<WorkbenchLocation, 'mode' | 'relation'>) {
            const current = local.get('location');
            if (current.mode === place.mode && sameRelation(current.relation, place.relation)) return;
            local.set('location', mergeWorkbenchLocation(current, { mode: place.mode, relation: place.relation }));
        },
        async back() {
            const previous = foreignKeyBack(local.get('location'));
            if (previous) { await client.navigate(previous); local.set('location', previous); }
        },
        refresh(targetKey?: string, relation?: DatabaseRelationV1) {
            invalidate(targetKey, relation);
            const location = local.get('location');
            if (!relation || location.targetKey !== targetKey || !sameRelation(location.relation, relation)) return;
            // The selected view's Refresh is demand even if its subscription is being reattached.
            if (location.mode === 'data') void instance.page(location).demand();
            if (location.mode === 'structure') void structure(location.targetKey, relation).demand();
        },
        apply(relation: DatabaseRelationV1, targetKey = local.get('location').targetKey): WorkbenchControlBinding & { disabled: boolean } {
            const scope = { targetKey, relation };
            const controlKey = reviewKey(scope);
            let held = applyControls.get(controlKey);
            if (!held) {
                held = createApplyControl({ drafts, draftKey, target, isClosed: () => closed,
                    hasConflict: () => conflictAt(scope) !== undefined,
                    onOutcome: outcome => {
                        applyOutcomes.set(controlKey, outcome?.kind === 'conflict' && !conflictHasDraft(scope, outcome) ? undefined : outcome);
                    } }, targetKey, relation);
                applyControls.set(controlKey, held);
            }
            return { ...held, disabled: conflictAt(scope) !== undefined };
        },
        close() { if (closed) return; closed = true; unsubscribe(); draftOff(); reads.abort(); for (const console of consoles.values()) console.close(); consoles.clear(); applyControls.clear(); for (const held of resources.values()) held.resource.dispose?.(); resources.clear(); targets.clear(); consoleStores.clear(); drafts.discard(); },
    };
    return instance;
}
export type WorkbenchInstance = ReturnType<typeof createWorkbenchInstance>;
