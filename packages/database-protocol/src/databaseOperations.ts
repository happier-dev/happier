import { z } from 'zod/mini';
import { WorkspaceAddressV2Schema } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { DeploymentEnvironmentRefV1Schema } from '@happier-dev/protocol/deployments/deploymentEnvironmentRefV1';
import { DatabaseEngineIdV1Schema, DatabaseTargetV1Schema } from './databaseTargets.js';
import { DatabaseAccessSummaryV1Schema, DatabaseOperationClassV1Schema } from './databaseAccess.js';
import { DatabaseStatsObservationV1Schema } from './databaseStats.js';
import {
    DatabaseRelationV1Schema,
    type DatabaseRelationV1,
    DatabaseOrderV1Schema,
    type DatabaseOrderV1,
    type DatabaseFilterV1,
    DatabaseFilterV1Schema,
    DatabaseRowsBindingV1Schema,
    type DatabaseRowsBindingV1,
    DatabaseRowsContinuationV1Schema,
    type DatabaseRowsContinuationV1,
    DatabasePageDemandV1Schema,
    type DatabasePageDemandV1,
    DatabaseStatementV1Schema,
    type DatabaseStatementV1,
    DatabaseReadStatementInputV1Schema,
    type DatabaseReadStatementInputV1,
    DatabaseWriteStatementInputV1Schema,
    type DatabaseWriteStatementInputV1,
    DatabaseStatementRunInputV1Schema,
    type DatabaseStatementRunInputV1,
    DatabaseCellReadOperandV1Schema,
    DatabaseStatsOperationInputV1Schema,
    type DatabaseStatsOperationInputV1,
    databaseOperationContextV1 as operationContext
} from './databaseOperands.js';
import { DatabaseContinuationV1Schema, type DatabaseContinuationV1, DatabaseCompletenessV1Schema, type DatabaseCompletenessV1 } from './databaseContinuations.js';
export { DatabaseRelationV1Schema } from './databaseOperands.js';
export type { DatabaseRelationV1 } from './databaseOperands.js';
export { DatabaseOrderV1Schema } from './databaseOperands.js';
export type { DatabaseOrderV1 } from './databaseOperands.js';
export type { DatabaseFilterV1 } from './databaseOperands.js';
export { DatabaseFilterV1Schema } from './databaseOperands.js';
export { DatabaseRowsBindingV1Schema } from './databaseOperands.js';
export type { DatabaseRowsBindingV1 } from './databaseOperands.js';
export { DatabaseRowsContinuationV1Schema } from './databaseOperands.js';
export type { DatabaseRowsContinuationV1 } from './databaseOperands.js';
export { DatabasePageDemandV1Schema } from './databaseOperands.js';
export type { DatabasePageDemandV1 } from './databaseOperands.js';
export { DatabaseStatementV1Schema } from './databaseOperands.js';
export type { DatabaseStatementV1 } from './databaseOperands.js';
export { DatabaseReadStatementInputV1Schema } from './databaseOperands.js';
export type { DatabaseReadStatementInputV1 } from './databaseOperands.js';
export { DatabaseWriteStatementInputV1Schema } from './databaseOperands.js';
export type { DatabaseWriteStatementInputV1 } from './databaseOperands.js';
export { DatabaseStatementRunInputV1Schema } from './databaseOperands.js';
export type { DatabaseStatementRunInputV1 } from './databaseOperands.js';
export { DatabaseCellReadOperandV1Schema } from './databaseOperands.js';
export { DatabaseStatsOperationInputV1Schema } from './databaseOperands.js';
export type { DatabaseStatsOperationInputV1 } from './databaseOperands.js';
export { DatabaseContinuationV1Schema } from './databaseContinuations.js';
export type { DatabaseContinuationV1 } from './databaseContinuations.js';
export { DatabaseCompletenessV1Schema } from './databaseContinuations.js';
export type { DatabaseCompletenessV1 } from './databaseContinuations.js';

import {
    DatabaseCellV1Schema, DatabaseColumnV1Schema, DatabaseNamedCellV1Schema, DatabaseRowV1Schema,
    DatabaseValueV1Schema, DatabaseValueRangeV1Schema, DatabaseWriteValueV1Schema,
    type DatabaseValueV1,
} from './databaseValues.js';

const name = z.string().check(z.minLength(1));
const nonnegativeInteger = z.number().check(z.int(), z.nonnegative());
const positiveInteger = z.number().check(z.int(), z.positive());
const count = z.string().check(z.regex(/^\d+$/u));

export const DatabaseOperationNameV1Schema = z.enum([
    'describe', 'schemas.list', 'relations.list', 'relation.structure', 'rows.read',
    'cell.read', 'statement.run', 'statement.explain', 'edits.apply', 'stats.read',
]);
export type DatabaseOperationNameV1 = z.infer<typeof DatabaseOperationNameV1Schema>;
export const DatabaseCapabilityV1Schema = z.discriminatedUnion('available', [
    z.strictObject({ operation: DatabaseOperationNameV1Schema, available: z.literal(true) }),
    z.strictObject({ operation: DatabaseOperationNameV1Schema, available: z.literal(false), code: name, reason: z.string() }),
]);
export type DatabaseCapabilityV1 = z.infer<typeof DatabaseCapabilityV1Schema>;

export const DatabaseDescribeInputV1Schema = z.strictObject({ operation: z.literal('describe'), ...operationContext });
export type DatabaseDescribeInputV1 = z.infer<typeof DatabaseDescribeInputV1Schema>;
export const DatabaseSchemasListInputV1Schema = z.strictObject({
    operation: z.literal('schemas.list'), ...operationContext, database: z.optional(name),
    search: z.optional(z.string()), page: z.strictObject({ rows: positiveInteger, after: z.optional(name) }),
});
export type DatabaseSchemasListInputV1 = z.infer<typeof DatabaseSchemasListInputV1Schema>;
export const DatabaseRelationsListInputV1Schema = z.strictObject({
    operation: z.literal('relations.list'), ...operationContext, database: z.optional(name), schema: name,
    search: z.optional(z.string()), page: z.strictObject({ rows: positiveInteger, after: z.optional(name) }),
});
export type DatabaseRelationsListInputV1 = z.infer<typeof DatabaseRelationsListInputV1Schema>;
export const DatabaseRelationStructureInputV1Schema = z.strictObject({
    operation: z.literal('relation.structure'), ...operationContext, relation: DatabaseRelationV1Schema,
});
export type DatabaseRelationStructureInputV1 = z.infer<typeof DatabaseRelationStructureInputV1Schema>;
export const DatabaseRowsReadInputV1Schema = z.strictObject({
    operation: z.literal('rows.read'), ...operationContext, relation: DatabaseRelationV1Schema, columns: z.array(name),
    filter: z.optional(DatabaseFilterV1Schema), order: z.array(DatabaseOrderV1Schema),
    page: z.strictObject({ rows: positiveInteger, continuation: z.optional(DatabaseRowsContinuationV1Schema) }),
});
export type DatabaseRowsReadInputV1 = z.infer<typeof DatabaseRowsReadInputV1Schema>;
export const DatabaseCellReadInputV1Schema = z.strictObject({
    operation: z.literal('cell.read'), ...DatabaseCellReadOperandV1Schema.shape, range: DatabaseValueRangeV1Schema,
});
export type DatabaseCellReadInputV1 = z.infer<typeof DatabaseCellReadInputV1Schema>;
export const DatabaseStatementExplainInputV1Schema = z.strictObject({
    operation: z.literal('statement.explain'), ...operationContext,
    statement: DatabaseStatementV1Schema, mode: z.enum(['plan', 'analyze']), accessMode: DatabaseOperationClassV1Schema,
});
export type DatabaseStatementExplainInputV1 = z.infer<typeof DatabaseStatementExplainInputV1Schema>;

const key = z.array(DatabaseNamedCellV1Schema).check(z.minLength(1));
const writes = z.array(z.strictObject({ column: name, value: DatabaseWriteValueV1Schema }));
export const DatabaseEditV1Schema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('insert'), values: writes }),
    z.strictObject({ kind: z.literal('update'), key, values: writes.check(z.minLength(1)), original: z.array(DatabaseNamedCellV1Schema).check(z.minLength(1)) }),
    z.strictObject({ kind: z.literal('delete'), key }),
]);
export type DatabaseEditV1 = z.infer<typeof DatabaseEditV1Schema>;
export const DatabaseEditsApplyInputV1Schema = z.strictObject({
    operation: z.literal('edits.apply'), ...operationContext, relation: DatabaseRelationV1Schema,
    changes: z.array(DatabaseEditV1Schema).check(z.minLength(1)),
});
export type DatabaseEditsApplyInputV1 = z.infer<typeof DatabaseEditsApplyInputV1Schema>;
export const DatabaseOperationInputV1Schema = z.union([
    DatabaseDescribeInputV1Schema, DatabaseSchemasListInputV1Schema, DatabaseRelationsListInputV1Schema,
    DatabaseRelationStructureInputV1Schema, DatabaseRowsReadInputV1Schema, DatabaseCellReadInputV1Schema,
    DatabaseStatementRunInputV1Schema, DatabaseStatementExplainInputV1Schema, DatabaseEditsApplyInputV1Schema,
    DatabaseStatsOperationInputV1Schema,
]);
export type DatabaseOperationInputV1 = z.infer<typeof DatabaseOperationInputV1Schema>;

export const DatabaseDescriptorV1Schema = z.strictObject({
    target: DatabaseTargetV1Schema, label: z.string(), engine: DatabaseEngineIdV1Schema,
    origin: z.strictObject({ label: z.string(), environment: z.optional(z.enum(['development', 'preview', 'production'])) }),
    capabilities: z.array(DatabaseCapabilityV1Schema),
    access: z.optional(DatabaseAccessSummaryV1Schema),
    placement: z.strictObject({ serverId: name, accountId: name, machineId: name, installationId: name }),
});
export type DatabaseDescriptorV1 = z.infer<typeof DatabaseDescriptorV1Schema>;
/** Connect selects a concrete worktree or Environment; Project listing spans worktrees. */
const databaseTargetsConnectScopes = [
        z.strictObject({ kind: z.literal('worktree'), accountId: name, installationId: name, projectKey: name, workspace: WorkspaceAddressV2Schema }),
        z.strictObject({ kind: z.literal('environment'), environment: DeploymentEnvironmentRefV1Schema }),
] as const;
export const DatabaseTargetsConnectScopeV1Schema = z.discriminatedUnion('kind', databaseTargetsConnectScopes);
export const DatabaseTargetsListInputV1Schema = z.strictObject({
    scope: z.discriminatedUnion('kind', [
        ...databaseTargetsConnectScopes,
        z.strictObject({ kind: z.literal('project'), accountId: name, installationId: name, projectKey: name }),
    ]),
});
export type DatabaseTargetsListInputV1 = z.infer<typeof DatabaseTargetsListInputV1Schema>;
export const DatabaseTargetsListResultV1Schema = z.strictObject({ targets: z.array(DatabaseDescriptorV1Schema), completeness: DatabaseCompletenessV1Schema });
export type DatabaseTargetsListResultV1 = z.infer<typeof DatabaseTargetsListResultV1Schema>;

export const DatabaseRelationSummaryV1Schema = z.strictObject({
    relation: DatabaseRelationV1Schema, kind: z.enum(['table', 'view', 'materialized_view']), estimatedRows: z.optional(count),
});
export type DatabaseRelationSummaryV1 = z.infer<typeof DatabaseRelationSummaryV1Schema>;
export const DatabaseIndexV1Schema = z.strictObject({
    name, unique: z.boolean(), primary: z.boolean(),
    columns: z.array(z.union([
        z.strictObject({ kind: z.literal('column'), column: name, direction: z.optional(z.enum(['asc', 'desc'])) }),
        z.strictObject({ kind: z.literal('expression'), expression: z.string(), direction: z.optional(z.enum(['asc', 'desc'])) }),
    ])), predicate: z.optional(z.string()),
});
export type DatabaseIndexV1 = z.infer<typeof DatabaseIndexV1Schema>;
export const DatabaseForeignKeyV1Schema = z.strictObject({
    name, columns: z.array(name).check(z.minLength(1)), target: DatabaseRelationV1Schema,
    targetColumns: z.array(name).check(z.minLength(1)),
}).check(z.refine(value => value.columns.length === value.targetColumns.length, { message: 'Foreign key columns must align.' }));
export type DatabaseForeignKeyV1 = z.infer<typeof DatabaseForeignKeyV1Schema>;
export const DatabaseRelationStructureV1Schema = z.strictObject({
    relation: DatabaseRelationV1Schema, kind: z.enum(['table', 'view', 'materialized_view']),
    columns: z.array(z.extend(DatabaseColumnV1Schema, { nullable: z.boolean(), generated: z.boolean() })),
    primaryKey: z.array(name), indexes: z.array(DatabaseIndexV1Schema), foreignKeys: z.array(DatabaseForeignKeyV1Schema),
    viewDefinition: z.optional(z.string()), capabilities: z.array(DatabaseCapabilityV1Schema),
});
export type DatabaseRelationStructureV1 = z.infer<typeof DatabaseRelationStructureV1Schema>;

export const DatabaseRowsResultV1Schema = z.strictObject({
    columns: z.array(DatabaseColumnV1Schema), rows: z.array(DatabaseRowV1Schema),
    estimate: z.optional(count), completeness: DatabaseCompletenessV1Schema,
}).check(z.refine(value => value.rows.every(row => row.cells.length === value.columns.length)
    && (!value.completeness.complete || value.rows.every(row => row.cells.every(cell => cell.type !== 'partial'))),
{ message: 'Rows must align with columns and partial cells require incomplete results.' }));
export type DatabaseRowsResultV1 = z.infer<typeof DatabaseRowsResultV1Schema>;
export const DatabaseStatementResultV1Schema = z.safeExtend(DatabaseRowsResultV1Schema, {
    command: z.optional(z.string()), affectedRows: z.optional(count),
});
export type DatabaseStatementResultV1 = z.infer<typeof DatabaseStatementResultV1Schema>;
export const DatabaseCellResultV1Schema = z.strictObject({
    value: DatabaseCellV1Schema, completeness: DatabaseCompletenessV1Schema,
}).check(z.refine(value => !value.completeness.complete || value.value.type !== 'partial',
{ message: 'A partial cell requires an incomplete result.' }));
export type DatabaseCellResultV1 = z.infer<typeof DatabaseCellResultV1Schema>;

export const DatabaseFailureCauseV1Schema = z.strictObject({
    source: z.enum(['engine', 'platform', 'transport']), code: name, message: z.string(),
    position: z.optional(positiveInteger), statementIndex: z.optional(nonnegativeInteger),
});
export type DatabaseFailureCauseV1 = z.infer<typeof DatabaseFailureCauseV1Schema>;
export const DatabaseFailureV1Schema = z.discriminatedUnion('status', [
    z.strictObject({ ok: z.literal(false), status: z.literal('failed'), code: name, reason: z.optional(z.string()), cause: z.optional(DatabaseFailureCauseV1Schema) }),
    z.strictObject({ ok: z.literal(false), status: z.literal('unavailable'), code: name, reason: z.string() }),
    z.strictObject({ ok: z.literal(false), status: z.literal('cancelled'), code: z.literal('database_cancelled') }),
    z.strictObject({ ok: z.literal(false), status: z.literal('outcome_unknown'), code: z.literal('database_outcome_unknown'), cause: z.optional(DatabaseFailureCauseV1Schema) }),
    z.strictObject({ ok: z.literal(false), status: z.literal('conflict'), code: z.literal('database_edit_conflict'), changeIndex: nonnegativeInteger, reason: z.enum(['row_changed', 'row_missing', 'relation_changed']) }),
]);
export type DatabaseFailureV1 = z.infer<typeof DatabaseFailureV1Schema>;
export const DatabaseOperationResultV1Schema = z.union([
    DatabaseFailureV1Schema,
    z.strictObject({ ok: z.literal(true), operation: z.literal('describe'), descriptor: DatabaseDescriptorV1Schema }),
    z.strictObject({ ok: z.literal(true), operation: z.literal('schemas.list'), schemas: z.array(z.strictObject({ name })), completeness: DatabaseCompletenessV1Schema }),
    z.strictObject({ ok: z.literal(true), operation: z.literal('relations.list'), relations: z.array(DatabaseRelationSummaryV1Schema), completeness: DatabaseCompletenessV1Schema }),
    z.strictObject({ ok: z.literal(true), operation: z.literal('relation.structure'), structure: DatabaseRelationStructureV1Schema }),
    z.strictObject({ ok: z.literal(true), operation: z.literal('rows.read'), result: DatabaseRowsResultV1Schema }),
    z.safeExtend(DatabaseCellResultV1Schema, { ok: z.literal(true), operation: z.literal('cell.read') }),
    z.strictObject({ ok: z.literal(true), operation: z.literal('statement.run'), results: z.array(DatabaseStatementResultV1Schema),
        // This scopes completeness to the ordered entry list. Absence means all
        // native entries are present; each entry separately describes its rows.
        completeness: z.optional(DatabaseCompletenessV1Schema) }),
    z.strictObject({ ok: z.literal(true), operation: z.literal('statement.explain'), format: z.enum(['text', 'json']), plan: z.union([z.string(), z.json()]), completeness: DatabaseCompletenessV1Schema }),
    z.strictObject({ ok: z.literal(true), operation: z.literal('edits.apply'), status: z.literal('committed'), inserted: count, updated: count, deleted: count }),
    z.strictObject({ ok: z.literal(true), operation: z.literal('stats.read'), observation: DatabaseStatsObservationV1Schema }),
]);
export type DatabaseOperationResultV1 = z.infer<typeof DatabaseOperationResultV1Schema>;
