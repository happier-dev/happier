export type PiAccountUsageAvailability = Readonly<{
  providerId: 'pi';
  status: 'unsupported';
  reason: 'no_verified_usage_source';
  displayGauge: false;
  canonicalRecord: null;
}>;

export function resolvePiAccountUsageAvailability(): PiAccountUsageAvailability {
  return {
    providerId: 'pi',
    status: 'unsupported',
    reason: 'no_verified_usage_source',
    displayGauge: false,
    canonicalRecord: null,
  };
}
