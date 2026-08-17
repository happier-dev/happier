import { AZURE_DEVOPS_PLUGIN } from './manifest.js';

/**
 * The single Azure DevOps registration spine.
 *
 * It is projected from the one `definePlugin` owner rather than hand-written, so a declared
 * Action, hosting provider, or Connected Account descriptor can never drift from a registered
 * handler in either direction. There is no second activation, host branch, registry, scheduler, or
 * refresh loop: the mounted PRs & Issues view owns refresh demand, and this source performs one
 * requested read per invocation.
 */
export const activate = AZURE_DEVOPS_PLUGIN.activate;
