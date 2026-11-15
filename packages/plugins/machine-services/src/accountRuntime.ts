import { definePlugin } from '@happier-dev/plugin-sdk';
import { MACHINE_SERVICES_PLUGIN_ID } from './healthSetup.js';
import { retainedHealthActions } from './healthResults.js';

/** Portable retained reads have no daemon or native probe dependency. */
export const activate = definePlugin({ id: MACHINE_SERVICES_PLUGIN_ID, version: '0.0.0',
    displayName: 'Machine services', actions: retainedHealthActions }).activateAccount;
