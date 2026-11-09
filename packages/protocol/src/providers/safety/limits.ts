export type ProviderEndpointSafetyLimits = Readonly<{
  maxHostnameChars: number;
}>;

export const PROVIDER_ENDPOINT_SAFETY_LIMITS: ProviderEndpointSafetyLimits = Object.freeze({
  // RFC 1035 §2.3.4: 255 wire octets minus the root and label-length overhead
  // gives 253 characters for the normalized hostname without its trailing dot.
  maxHostnameChars: 253,
});
