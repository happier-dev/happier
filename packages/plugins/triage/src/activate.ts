import { TRIAGE_PLUGIN } from './definition.js';

/**
 * The daemon projection of the one authored Triage registration spine.
 *
 * It is projected from the one `definePlugin` owner rather than hand-written,
 * so a declared Action, Composer attachment role or Collection can never drift
 * from a registered implementation in either direction. The same owner projects
 * Account Actions into the declared portable artifact via `activateAccount`.
 */
export const activate = TRIAGE_PLUGIN.activate;
