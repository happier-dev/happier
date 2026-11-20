import type { DeploymentRestorePreparationV1 } from '@happier-dev/deployments/contracts/v1';

/** Nonsecret native evidence retained by the existing prepare Action operation. */
export type OwnServerRestorePreparationForHost = DeploymentRestorePreparationV1;

/** The shape is owned by the deployment protocol, where the restore sheet reads the same evidence. */
export { DeploymentRestorePreparationV1Schema as OwnServerRestorePreparationForHostSchema } from '@happier-dev/deployments/contracts/v1';
