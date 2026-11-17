import { z } from 'zod/mini';

const id = z.string().check(z.minLength(1));

export const DatabaseBuiltinEngineIdV1Schema = z.enum(['postgresql', 'mysql', 'sqlite']);
export type DatabaseBuiltinEngineIdV1 = z.infer<typeof DatabaseBuiltinEngineIdV1Schema>;
/** Contributed engine identities are not restricted to the bundled engines. */
export const DatabaseEngineIdV1Schema = id;
export type DatabaseEngineIdV1 = z.infer<typeof DatabaseEngineIdV1Schema>;

export {
    DatabaseWorktreeSourceV1Schema, DatabaseWorktreeTargetV1Schema,
    DatabaseDeploymentServiceTargetV1Schema, DatabaseManagedDeploymentTargetV1Schema,
    DatabaseManualTargetV1Schema, DatabaseTargetV1Schema,
    type DatabaseWorktreeSourceV1, type DatabaseWorktreeTargetV1,
    type DatabaseDeploymentServiceTargetV1, type DatabaseManagedDeploymentTargetV1,
    type DatabaseManualTargetV1, type DatabaseTargetV1,
} from '@happier-dev/protocol/databases/databaseTargetIdentityV1';
