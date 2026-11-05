import type { DeploymentBackupConfigurationV1 } from '@happier-dev/deployment-protocol';
import type { OwnServerNativeRestorePrepareReceipt } from './nativeRestore';

/** Nonsecret native evidence retained by the existing prepare Action operation. */
export type OwnServerRestorePreparationForHost = Readonly<{
    prepared: OwnServerNativeRestorePrepareReceipt;
    configuration: DeploymentBackupConfigurationV1;
}>;

/** The shape is owned by the deployment protocol, where the restore sheet reads the same evidence. */
export { DeploymentRestorePreparationV1Schema as OwnServerRestorePreparationForHostSchema } from '@happier-dev/deployment-protocol';
