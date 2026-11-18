import { z } from 'zod/mini';
import { DatabaseTargetV1Schema } from './databaseTargets.js';
import { DatabaseValueRangeV1Schema } from './databaseValues.js';
import { DatabaseRowsContinuationV1Schema, DatabaseReadStatementDemandV1Schema,
    DatabaseCellReadOperandV1Schema } from './databaseOperands.js';

const name = z.string().check(z.minLength(1));
const nonnegativeInteger = z.number().check(z.int(), z.nonnegative());

export const DatabaseContinuationV1Schema = z.union([
    DatabaseRowsContinuationV1Schema,
    z.strictObject({ kind: z.literal('stats'), offset: nonnegativeInteger }),
    // The caller retains SQL/parameters from the originating request. Copying them
    // into a reply can itself exceed the smaller response envelope.
    z.strictObject({ kind: z.literal('rerun'), snapshot: z.literal(false), input: z.literal('original'), demand: DatabaseReadStatementDemandV1Schema }),
    z.strictObject({ kind: z.literal('cell'), input: DatabaseCellReadOperandV1Schema, range: DatabaseValueRangeV1Schema }),
    z.strictObject({ kind: z.literal('catalog'), operation: z.enum(['schemas.list', 'relations.list']),
        target: DatabaseTargetV1Schema, database: z.optional(name), schema: z.optional(name), search: z.optional(z.string()), after: name }),
]);
export type DatabaseContinuationV1 = z.infer<typeof DatabaseContinuationV1Schema>;
export const DatabaseCompletenessV1Schema = z.discriminatedUnion('complete', [
    z.strictObject({ complete: z.literal(true) }),
    z.strictObject({ complete: z.literal(false), reason: z.enum(['response_envelope', 'page', 'transport_unproven']), continuation: z.optional(DatabaseContinuationV1Schema) }),
]);
export type DatabaseCompletenessV1 = z.infer<typeof DatabaseCompletenessV1Schema>;
