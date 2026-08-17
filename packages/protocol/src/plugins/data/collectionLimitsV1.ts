/**
 * Protocol-owned physical ceilings for Account Collection data. Deployment
 * policy can lower these values, but neither a manifest nor an operator can
 * raise a wire or persisted-data shape beyond this compatibility boundary.
 */
export const PLUGIN_COLLECTION_LIMITS_V1 = Object.freeze({
  maximumStoredRowEncodedBytes: 2 * 1024 * 1024,
  maximumPrivateEnvelopeEncodedBytes: 512 * 1024,
  maximumProjectionEncodedBytes: 64 * 1024,
  maximumMutationBatchEncodedBytes: 64 * 1024 * 1024,
  maximumMutationBatchRows: 100,
  maximumAccountEncodedBytes: 1024 * 1024 * 1024,
  maximumAccountRows: 100_000,
});
