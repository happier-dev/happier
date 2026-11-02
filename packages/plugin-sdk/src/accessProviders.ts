import type { PluginContributionRef } from './identity.js';
/** @moduleRealm any */

export type AccessProviderRefV1 = Readonly<{ kind: 'builtin'; id: string }> | PluginContributionRef;
