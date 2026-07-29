export type ProviderMetadataIpDestination = Readonly<{
  address: string;
  version: 4 | 6;
  provider: string;
}>;

/**
 * Cloud metadata and workload-credential destinations are unconditionally
 * unsafe. They are evaluated before the otherwise confirmable private/local
 * ranges that contain them.
 */
export const PROVIDER_METADATA_IP_DESTINATIONS: readonly ProviderMetadataIpDestination[] = Object.freeze([
  { address: '100.100.100.200', version: 4, provider: 'alibaba' },
  { address: '169.254.169.254', version: 4, provider: 'cloud-metadata' },
  { address: '169.254.170.2', version: 4, provider: 'aws-ecs-credentials' },
  { address: '169.254.170.23', version: 4, provider: 'aws-eks-credentials' },
  { address: 'fd00:ec2::254', version: 6, provider: 'aws-imds' },
  { address: 'fd20:ce::254', version: 6, provider: 'google-compute-metadata' },
]);

const PROVIDER_METADATA_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.goog',
]);

export function isProviderMetadataHostname(hostname: string): boolean {
  return PROVIDER_METADATA_HOSTNAMES.has(hostname.toLowerCase().replace(/\.$/u, ''));
}
