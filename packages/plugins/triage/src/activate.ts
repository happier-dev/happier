import { TRIAGE_PLUGIN } from './manifest.js';

/**
 * The single Triage registration spine, invoked once by the host through the
 * manifest's declared daemon entrypoint.
 *
 * It is projected from the one `definePlugin` owner rather than hand-written,
 * so a declared Action, Composer attachment role or Collection can never drift
 * from a registered implementation in either direction. No Triage code
 * registers through a second activation, host branch or package.
 */
export const activate = TRIAGE_PLUGIN.activate;
