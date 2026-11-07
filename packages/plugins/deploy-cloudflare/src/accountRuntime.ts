import { definePlugin } from '@happier-dev/plugin-sdk';
import { definition } from './definition.js';

// The portable artifact shares Account declarations without importing daemon filesystem/Exec code.
export const activateAccount = definePlugin(definition).activateAccount;
