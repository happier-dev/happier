import { z } from 'zod/mini';
import { DatabaseTargetV1Schema } from './databaseTargets.js';
import { DatabaseNamedCellV1Schema, DatabaseValueV1Schema, type DatabaseValueV1 } from './databaseValues.js';

const name = z.string().check(z.minLength(1));
const nonnegativeInteger = z.number().check(z.int(), z.nonnegative());
const positiveInteger = z.number().check(z.int(), z.positive());

export const DatabaseRelationV1Schema = z.strictObject({ database: z.optional(name), schema: name, name });
export type DatabaseRelationV1 = z.infer<typeof DatabaseRelationV1Schema>;
export const DatabaseOrderV1Schema = z.strictObject({
    column: name, direction: z.enum(['asc', 'desc']), nulls: z.optional(z.enum(['first', 'last'])),
});
export type DatabaseOrderV1 = z.infer<typeof DatabaseOrderV1Schema>;
export type DatabaseFilterV1 =
    | { kind: 'comparison'; column: string; operator: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'contains'; value: DatabaseValueV1 }
    | { kind: 'null'; column: string; isNull: boolean }
    | { kind: 'and' | 'or'; filters: DatabaseFilterV1[] }
    | { kind: 'not'; filter: DatabaseFilterV1 };
export const DatabaseFilterV1Schema: z.ZodMiniType<DatabaseFilterV1> = z.lazy(() => z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('comparison'), column: name, operator: z.enum(['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'contains']), value: DatabaseValueV1Schema }),
    z.strictObject({ kind: z.literal('null'), column: name, isNull: z.boolean() }),
    z.strictObject({ kind: z.literal('and'), filters: z.array(DatabaseFilterV1Schema) }),
    z.strictObject({ kind: z.literal('or'), filters: z.array(DatabaseFilterV1Schema) }),
    z.strictObject({ kind: z.literal('not'), filter: DatabaseFilterV1Schema }),
]));

/** Data binding is checked by the execution owner, not a server-side cursor registry. */
export const DatabaseRowsBindingV1Schema = z.strictObject({
    target: DatabaseTargetV1Schema, relation: DatabaseRelationV1Schema, columns: z.array(name),
    filter: z.optional(DatabaseFilterV1Schema), order: z.array(DatabaseOrderV1Schema),
});
export type DatabaseRowsBindingV1 = z.infer<typeof DatabaseRowsBindingV1Schema>;
export const DatabaseRowsContinuationV1Schema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('keyset'), binding: DatabaseRowsBindingV1Schema,
        values: z.array(DatabaseNamedCellV1Schema).check(z.minLength(1)), direction: z.enum(['forward', 'backward']) }),
    z.strictObject({ kind: z.literal('offset'), binding: DatabaseRowsBindingV1Schema, offset: nonnegativeInteger }),
]);
export type DatabaseRowsContinuationV1 = z.infer<typeof DatabaseRowsContinuationV1Schema>;
export const DatabasePageDemandV1Schema = z.strictObject({ rows: positiveInteger });
export type DatabasePageDemandV1 = z.infer<typeof DatabasePageDemandV1Schema>;

export const databaseOperationContextV1 = { target: DatabaseTargetV1Schema, subscriptionId: z.optional(name) };
export const DatabaseStatementV1Schema = z.strictObject({ sql: name, parameters: z.array(DatabaseValueV1Schema) });
export type DatabaseStatementV1 = z.infer<typeof DatabaseStatementV1Schema>;
export const DatabaseReadStatementInputV1Schema = z.strictObject({
    operation: z.literal('statement.run'), ...databaseOperationContextV1, mode: z.literal('read'),
    statement: DatabaseStatementV1Schema, demand: z.optional(DatabasePageDemandV1Schema),
});
export type DatabaseReadStatementInputV1 = z.infer<typeof DatabaseReadStatementInputV1Schema>;
export const DatabaseWriteStatementInputV1Schema = z.strictObject({
    operation: z.literal('statement.run'), ...databaseOperationContextV1, mode: z.literal('write'),
    executionMode: z.literal('transaction'), statements: z.array(DatabaseStatementV1Schema).check(z.minLength(1)),
    demand: z.optional(DatabasePageDemandV1Schema),
});
export type DatabaseWriteStatementInputV1 = z.infer<typeof DatabaseWriteStatementInputV1Schema>;
export const DatabaseStatementRunInputV1Schema = z.discriminatedUnion('mode', [DatabaseReadStatementInputV1Schema, DatabaseWriteStatementInputV1Schema]);
export type DatabaseStatementRunInputV1 = z.infer<typeof DatabaseStatementRunInputV1Schema>;
export const DatabaseCellReadOperandV1Schema = z.strictObject({
    ...databaseOperationContextV1, relation: DatabaseRelationV1Schema,
    key: z.array(DatabaseNamedCellV1Schema).check(z.minLength(1)), column: name,
});
const page = z.extend(DatabasePageDemandV1Schema, { offset: z.optional(nonnegativeInteger) });
export const DatabaseStatsRelationV1Schema = DatabaseRelationV1Schema;
const relationSelection = z.union([
    z.strictObject({ relation: DatabaseStatsRelationV1Schema }),
    z.strictObject({ schema: name, page, search: z.optional(z.string()) }),
]);
export const DatabaseStatsReadV1Schema = z.discriminatedUnion('group', [
    z.strictObject({ kind: z.literal('stats.read'), group: z.literal('statements'), selection: z.strictObject({
        page, order: z.enum(['totalTime', 'calls', 'rows']), statementKey: z.optional(name),
    }) }),
    z.strictObject({ kind: z.literal('stats.read'), group: z.literal('tables'), selection: relationSelection }),
    z.strictObject({ kind: z.literal('stats.read'), group: z.literal('indexes'), selection: relationSelection }),
    z.strictObject({ kind: z.literal('stats.read'), group: z.literal('activity'), selection: z.strictObject({ page, activityKey: z.optional(name) }) }),
    z.strictObject({ kind: z.literal('stats.read'), group: z.literal('size'), selection: z.strictObject({ relation: z.optional(DatabaseStatsRelationV1Schema) }) }),
    z.strictObject({ kind: z.literal('stats.read'), group: z.literal('indexAdvice'), selection: z.strictObject({ statementKey: name }) }),
]);
export type DatabaseStatsReadV1 = z.infer<typeof DatabaseStatsReadV1Schema>;

export const DatabaseStatsOperationInputV1Schema = z.strictObject({
    operation: z.literal('stats.read'), ...databaseOperationContextV1, request: DatabaseStatsReadV1Schema,
});
export type DatabaseStatsOperationInputV1 = z.infer<typeof DatabaseStatsOperationInputV1Schema>;
