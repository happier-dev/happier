import type { DatabaseRelationV1, DatabaseCellV1, DatabaseForeignKeyV1, DatabaseIncomingForeignKeyV1, DatabaseFilterV1 } from '@happier-dev/database-protocol';
import type { WorkbenchLocation } from './models.js';

export function sameRelation(left?: DatabaseRelationV1, right?: DatabaseRelationV1): boolean {
    return left === right || left !== undefined && right !== undefined
        && left.database === right.database && left.schema === right.schema && left.name === right.name;
}

export function mergeWorkbenchLocation(previous: WorkbenchLocation, intent: Partial<WorkbenchLocation>): WorkbenchLocation {
    const next = { ...previous, ...intent };
    const changedQuery = next.targetKey !== previous.targetKey || !sameRelation(next.relation, previous.relation)
        || next.conditions !== previous.conditions || next.sort !== previous.sort || next.columns !== previous.columns;
    return changedQuery && !intent.page ? { ...next, page: { rows: previous.page.rows, offset: 0 } } : next;
}

export type ForeignKeyNavigation = Readonly<{ status: 'ready'; location: WorkbenchLocation }>
    | Readonly<{ status: 'unavailable'; reason: 'null_key' | 'missing_key' | 'partial_key' }>;

/** All parts of the declared constraint are bound; NULL has no referenced row. */
export function foreignKeyNavigation(location: WorkbenchLocation, foreignKey: DatabaseForeignKeyV1,
    columns: readonly string[], cells: readonly DatabaseCellV1[]): ForeignKeyNavigation {
    return navigateByKey(location, foreignKey.target, foreignKey.columns, foreignKey.targetColumns, columns, cells);
}

export function incomingForeignKeyNavigation(location: WorkbenchLocation, reference: DatabaseIncomingForeignKeyV1,
    columns: readonly string[], cells: readonly DatabaseCellV1[]): ForeignKeyNavigation {
    return navigateByKey(location, reference.source, reference.targetColumns, reference.sourceColumns, columns, cells);
}

function navigateByKey(location: WorkbenchLocation, destination: DatabaseRelationV1, currentKey: readonly string[],
    destinationKey: readonly string[], columns: readonly string[], cells: readonly DatabaseCellV1[]): ForeignKeyNavigation {
    const filters: DatabaseFilterV1[] = [];
    for (const [index, column] of currentKey.entries()) {
        const value = cells[columns.indexOf(column)];
        if (!value) return { status: 'unavailable', reason: 'missing_key' };
        if (value.type === 'null') return { status: 'unavailable', reason: 'null_key' };
        if (value.type === 'partial') return { status: 'unavailable', reason: 'partial_key' };
        filters.push({ kind: 'comparison', column: destinationKey[index]!, operator: 'eq', value });
    }
    const { fkTrail, relation, ...source } = location;
    return { status: 'ready', location: { ...location, relation: destination, mode: 'data', columns: [], sort: [],
        conditions: filters.length === 1 ? filters[0] : { kind: 'and', filters }, page: { rows: location.page.rows, offset: 0 },
        fkTrail: relation ? [...fkTrail, { ...source, relation }] : fkTrail } };
}
export function foreignKeyBack(location: WorkbenchLocation): WorkbenchLocation | undefined {
    const previous = location.fkTrail.at(-1);
    if (!previous) return undefined;
    return { ...location, ...previous, conditions: previous.conditions, fkTrail: location.fkTrail.slice(0, -1) };
}
