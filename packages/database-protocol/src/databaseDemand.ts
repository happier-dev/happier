import { z } from 'zod/mini';
import { DatabaseDescriptorV1Schema, DatabaseRelationV1Schema } from './databaseOperations.js';
import { DatabaseTargetV1Schema } from './databaseTargets.js';

export const DatabaseOwnWriteV1Schema = z.strictObject({
    target: DatabaseTargetV1Schema,
    relation: z.optional(DatabaseRelationV1Schema),
});
export type DatabaseOwnWriteV1 = z.infer<typeof DatabaseOwnWriteV1Schema>;

const revision = z.number().check(z.int(), z.nonnegative());

/** Descriptor bytes plus the committed own-write signal for this open demand. */
export const DatabaseDemandSnapshotV1Schema = z.strictObject({
    descriptor: DatabaseDescriptorV1Schema,
    ownWriteRevision: revision,
    relationRevisions: z.array(z.strictObject({ relation: DatabaseRelationV1Schema, revision })),
});
export type DatabaseDemandSnapshotV1 = z.infer<typeof DatabaseDemandSnapshotV1Schema>;
export { DATABASE_CONNECTION_RESOURCE_ID_V1 } from '@happier-dev/protocol/databases/databaseResourceIdentityV1';
