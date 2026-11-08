import { definePlugin, type DefinedPlugin } from '@happier-dev/plugin-sdk';
import { definition } from './definition.js';

// The portable artifact shares Account declarations without importing daemon filesystem/Exec code.
const plugin = definePlugin(definition);

export const activateAccount: DefinedPlugin['activateAccount'] = (api, target) => {
  plugin.activateAccount(api, target ?? { artifactId: 'account-runtime', exportName: 'activateAccount' });
};
