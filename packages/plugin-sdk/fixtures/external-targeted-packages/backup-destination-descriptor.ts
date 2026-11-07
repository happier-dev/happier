import type { BackupDestinationContributionV1 } from '@happier-dev/plugin-sdk';

/**
 * Declaration-only author reference. The package separately declares/registers
 * its qualified test/open Actions; this fixture makes no native backup claim.
 */
export const backupDestinationAuthorDeclaration = {
  id: 'repository',
  title: 'Object storage',
  configSchema: {
    type: 'object', properties: { endpoint: { type: 'string' }, bucket: { type: 'string' }, prefix: { type: 'string' } },
    required: ['endpoint', 'bucket', 'prefix'], additionalProperties: false,
  },
  credentialRoles: [{ role: 'repositoryPassword' }, { role: 'accessKeyId' }, { role: 'secretAccessKey' }],
  resticTransport: 's3',
  locality: 'unknown',
  actions: {
    test: { pluginId: 'examples.backup-destination', localId: 'destination/test' },
    open: { pluginId: 'examples.backup-destination', localId: 'destination/open' },
  },
} as const satisfies BackupDestinationContributionV1;
