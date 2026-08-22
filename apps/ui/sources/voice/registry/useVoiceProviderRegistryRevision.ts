import * as React from 'react';

import type { VoiceProviderRegistry } from './providerRegistry';

const subscribeToNothing = () => () => {};
const noRevision = () => 0;

/**
 * Re-renders the caller when the provider registry changes.
 *
 * Plugin activation populates the registry, and on a cold boot that happens *after* the first
 * render. A component that resolved its provider once would keep that first answer forever, so a
 * persisted external selection would stay permanently unresolved — visible neither as runnable nor
 * as remediable — until some unrelated render happened to refresh it.
 *
 * The registry stays the sole authority: this only makes the caller observe the registry's own
 * revision, which is why every consumer reads it through this one hook instead of re-deriving a
 * subscription of its own.
 */
export function useVoiceProviderRegistryRevision(registry: VoiceProviderRegistry): number {
    return React.useSyncExternalStore(
        registry.subscribe ?? subscribeToNothing,
        registry.getRevision ?? noRevision,
        registry.getRevision ?? noRevision,
    );
}
