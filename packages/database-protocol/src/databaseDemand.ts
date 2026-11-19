import { type ProtocolSchemaOutput, defineProtocolArray, defineProtocolNumber, defineProtocolObject } from '@happier-dev/plugin-sdk/protocol';

import { DatabaseDescriptorV1Schema, DatabaseRelationV1Schema } from '@happier-dev/plugin-sdk/database';
import { DatabaseTargetV1Schema } from '@happier-dev/plugin-sdk/database';

export const DatabaseOwnWriteV1Schema = defineProtocolObject({
    target: DatabaseTargetV1Schema,
    relation: (DatabaseRelationV1Schema).optional(),
}, { policy: 'closed' });
export type DatabaseOwnWriteV1 = ProtocolSchemaOutput<typeof DatabaseOwnWriteV1Schema>;

const revision = defineProtocolNumber({ integer: true, minimum: 0 });

/** Descriptor bytes plus the committed own-write signal for this open demand. */
export const DatabaseDemandSnapshotV1Schema = defineProtocolObject({
    descriptor: DatabaseDescriptorV1Schema,
    ownWriteRevision: revision,
    relationRevisions: defineProtocolArray(defineProtocolObject({ relation: DatabaseRelationV1Schema, revision }, { policy: 'closed' })),
}, { policy: 'closed' });
export type DatabaseDemandSnapshotV1 = ProtocolSchemaOutput<typeof DatabaseDemandSnapshotV1Schema>;
export { DATABASE_CONNECTION_RESOURCE_ID_V1 } from '@happier-dev/plugin-sdk/database';
