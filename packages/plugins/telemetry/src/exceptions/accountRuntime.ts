import { definePlugin } from '@happier-dev/plugin-sdk';
import { TELEMETRY_ACCOUNT_DEFINITION } from './serviceFacts.js';

export const activate = definePlugin(TELEMETRY_ACCOUNT_DEFINITION).activateAccount;
