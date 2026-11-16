import type { PluginAccountApi } from '@happier-dev/plugin-sdk';
import { DOCKER_ACCOUNT_SERVICE, DOCKER_PORTABLE_ACCOUNT_RUNTIME } from './machine/dockerAccount.js';

export function activateAccount(api: PluginAccountApi): void {
  api.connectedAccounts.register(DOCKER_ACCOUNT_SERVICE.localId, DOCKER_PORTABLE_ACCOUNT_RUNTIME);
}
