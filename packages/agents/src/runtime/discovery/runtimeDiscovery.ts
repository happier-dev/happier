/**
 * Discovery family names are canonical, but the payloads inside each bucket remain provider-owned
 * until a concrete shared discovery contract is justified. These buckets are not evidence that a
 * richer shared discovery family or bridge-local discovery catalog already exists.
 */
export type RuntimeDiscoveryBucket = Readonly<Record<string, unknown>>;

export type RuntimeDiscovery = Readonly<{
  preflight?: RuntimeDiscoveryBucket;
  authStatus?: RuntimeDiscoveryBucket;
  listModels?: RuntimeDiscoveryBucket;
  listModes?: RuntimeDiscoveryBucket;
  listConfigOptions?: RuntimeDiscoveryBucket;
}>;
