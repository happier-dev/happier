import type { ProviderObservationV1, SupportedNativeIntent } from '@happier-dev/protocol/machines/managed/providerFactsV1';

/** Fresh native truth settles custody, without claiming the old intent succeeded. */
export function doesManagedNativeObservationSettleIntent(intent: SupportedNativeIntent,
    observation: ProviderObservationV1 | undefined, previousObservation?: ProviderObservationV1,
    retryDelete = false): boolean {
    if (!observation || intent === 'rebuild'
        || previousObservation && observation.observedAt <= previousObservation.observedAt) return false;
    if (observation.availability === 'absent') return true;
    // A newer explicit Delete may retry this still-present exact resource.
    // Ordinary inspection retains uncertainty; native operation handles keep
    // their own cleanup custody at the reporting owner.
    if (intent === 'delete') return retryDelete && observation.availability === 'present';
    return observation.availability === 'present'
        && (observation.power === 'running' || observation.power === 'stopped' || observation.power === 'suspended');
}
