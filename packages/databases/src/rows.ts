import type { DatabaseRowsBindingV1 } from '@happier-dev/database-protocol';

/** Project both request and continuation through the same wire-field order. */
export function databaseRowsBindingV1(input: DatabaseRowsBindingV1): DatabaseRowsBindingV1 {
    return {
        target: input.target,
        relation: input.relation,
        columns: input.columns,
        ...(input.filter ? { filter: input.filter } : {}),
        order: input.order,
    };
}
