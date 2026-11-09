import type { QualifiedConnectedAccountServiceRef } from '@happier-dev/protocol';

/** Facts delivered by the existing Account change feed to retained broker custody. */
export type ProviderBrokerRetainedCurrentnessInvalidation = Readonly<{
  facts: readonly ('all' | 'teams' | 'team-credential-material' | 'connected-services' | 'connected-catalog' | 'saved-secrets' | 'provider-connections')[];
  /** Absent means every Connected Service; a present list retains the feed's exact scope. */
  connectedServiceRefs?: readonly QualifiedConnectedAccountServiceRef[];
}>;

/** Source adapters declare their consumed facts; the existing feed supplies changed facts. */
export function providerBrokerRetainedCurrentnessAffected(
  invalidation: ProviderBrokerRetainedCurrentnessInvalidation,
  scope: ProviderBrokerRetainedCurrentnessInvalidation,
): boolean {
  const changedServices = invalidation.connectedServiceRefs;
  const consumedServices = scope.connectedServiceRefs;
  return invalidation.facts.some(fact => {
    if (fact === 'all') return true;
    if (!scope.facts.includes(fact)) return false;
    if (fact !== 'connected-services') return true;
    if (consumedServices === undefined) return changedServices === undefined || changedServices.length > 0;
    return consumedServices.some(service => changedServices === undefined || changedServices.some(changed => (
      changed.pluginId === service.pluginId && changed.localId === service.localId
    )));
  });
}
