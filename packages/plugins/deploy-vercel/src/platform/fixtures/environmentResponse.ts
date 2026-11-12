/** Recorded `created` response example from the primary REST reference,
 * retrieved 2026-11-12. These are documentation example values, not tenant data.
 * https://vercel.com/docs/rest-api/projects/create-one-or-more-environment-variables
 * Tests derive selected-scope and per-key vectors from this provider response.
 */
export const recordedVercelEnvironment = {
  comment: 'string',
  configurationId: 'example_id',
  contentHint: { storeId: 'example_id', type: 'redis-url' },
  createdAt: '123',
  createdBy: 'string',
  customEnvironmentIds: [],
  decrypted: 'false',
  edgeConfigId: 'example_id',
  edgeConfigTokenId: 'example_id',
  gitBranch: 'string',
  id: 'icfg_1234567890',
  internalContentHint: { encryptedValue: 'string', type: 'flags-secret' },
  key: 'string',
  legacyValue: 'string',
  sunsetSecretId: 'example_id',
  target: [],
  type: 'encrypted',
  updatedAt: '123',
  updatedBy: 'string',
  value: 'string',
  visibility: 'config',
  vsmValue: 'string',
  system: 'false',
} as const;
