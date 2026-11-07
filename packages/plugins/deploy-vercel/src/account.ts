import { definePlugin } from '@happier-dev/plugin-sdk';
import { accountActions, pluginIdentity } from './platform/accountActions.js';
import { targetInputTypes, targetOptionsResources } from './platform/options.js';

// Consume the same declaration map through the SDK's Account handler adapter.
// The only exported artifact capability is activation; the daemon manifest owns
// the full declaration, including its filesystem-backed upload role.
export const activateAccount = definePlugin({ ...pluginIdentity, actions: accountActions,
  resources: targetOptionsResources, inputTypes: targetInputTypes }).activateAccount;
