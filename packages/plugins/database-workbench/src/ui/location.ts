import type { DatabaseRelationV1 } from '@happier-dev/database-protocol';
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
