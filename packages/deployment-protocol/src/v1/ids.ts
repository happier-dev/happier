import { z } from 'zod/mini';
import { DeploymentIdentifierV1Schema } from '@happier-dev/protocol/deployments/deploymentIdentifiersV1';

export { DeploymentIdentifierV1Schema, DeploymentRevisionV1Schema, DeploymentTimestampV1Schema } from '@happier-dev/protocol/deployments/deploymentIdentifiersV1';
export { DeploymentEnvironmentRefV1Schema, type DeploymentEnvironmentRefV1 } from '@happier-dev/protocol/deployments/deploymentEnvironmentRefV1';
export { DeploymentDigestV1Schema, DeploymentTextV1Schema } from '@happier-dev/protocol/deployments/storedAppInputV1';
export type DeploymentIdentifierV1 = z.infer<typeof DeploymentIdentifierV1Schema>;
