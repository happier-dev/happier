import { SENTRY_PLUGIN } from './manifest.js';

/**
 * The single Sentry registration spine.
 *
 * It is projected from the one `definePlugin` owner rather than hand-written,
 * so a declared Action can never drift from a registered handler in either
 * direction. Sentry adds no second activation, host branch, registry,
 * scheduler, or refresh loop: the mounted PRs & Issues view owns refresh
 * demand, and this source performs one requested read per invocation.
 */
export const activate = SENTRY_PLUGIN.activate;
