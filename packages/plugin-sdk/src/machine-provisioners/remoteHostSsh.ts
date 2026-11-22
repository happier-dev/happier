/** @moduleRealm daemon */
export {
    buildOpenScpCommand,
    buildOpenSshCommand,
    parseRemoteHostWorkspaceBindingV1,
    REMOTE_HOST_SSH_PROVISIONER,
    SSH_PASSWORD_ENV,
    type OpenSshAuth,
} from '@happier-dev/cli-common/ssh';
export { MANAGED_NATIVE_GUEST_PLATFORM_COMMAND } from '@happier-dev/cli-common/machines/managed';
export { materializeSshIdentityPrivateKeyToTempFile } from '@happier-dev/cli-common/systemTasks';
export { createHappierTempDir, removeHappierTempDirAsync } from '@happier-dev/cli-common/tempDirs';
