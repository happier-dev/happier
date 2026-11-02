import { z } from 'zod/mini';
import { DeploymentIdentifierV1Schema } from '@happier-dev/protocol';

export { DeploymentIdentifierV1Schema, DeploymentRevisionV1Schema, DeploymentTimestampV1Schema,
    DeploymentEnvironmentRefV1Schema, DeploymentDigestV1Schema, DeploymentTextV1Schema, type DeploymentEnvironmentRefV1 } from '@happier-dev/protocol';
export type DeploymentIdentifierV1 = z.infer<typeof DeploymentIdentifierV1Schema>;
