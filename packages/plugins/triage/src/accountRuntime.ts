import { definePlugin } from '@happier-dev/plugin-sdk';
import { TRIAGE_ACCOUNT_DEFINITION } from './accountDefinition.js';

/** Compile only the canonical Account registrations, retaining their execution placement. */
export const activate = definePlugin(TRIAGE_ACCOUNT_DEFINITION).activateAccount;
