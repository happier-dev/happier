export type GeminiAccountUsageAvailability = Readonly<{
  providerId: 'gemini';
  status: 'unsupported';
  reason: 'no_verified_usage_source';
  displayGauge: false;
  canonicalRecord: null;
}>;

export function resolveGeminiAccountUsageAvailability(): GeminiAccountUsageAvailability {
  return {
    providerId: 'gemini',
    status: 'unsupported',
    reason: 'no_verified_usage_source',
    displayGauge: false,
    canonicalRecord: null,
  };
}
