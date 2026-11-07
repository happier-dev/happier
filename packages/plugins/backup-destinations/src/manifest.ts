import { BackupDestinationOpenV1ProtocolSchema, definePlugin } from '@happier-dev/plugin-sdk';
import { defineProtocolObject, defineProtocolUniqueArray } from '@happier-dev/plugin-sdk/protocol';
import { prepareS3Destination, S3DestinationConfigSchema, S3DestinationCredentialRoleSchema, S3_DESTINATION_CREDENTIAL_ROLES } from './s3.js';

const pluginId = 'happier.backup.destinations';
const inputSchema = defineProtocolObject({
  config: S3DestinationConfigSchema,
  credentialRoles: defineProtocolUniqueArray(S3DestinationCredentialRoleSchema).optional(),
}, { policy: 'closed' });

export const plugin = definePlugin({
  id: pluginId,
  version: '0.0.0',
  displayName: 'Backup destinations',
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  activation: { events: [] },
  hostAccess: { required: [], optional: [] },
  backupDestinations: {
    s3: {
      title: 'S3 object storage', configSchema: S3DestinationConfigSchema.jsonSchema,
      credentialRoles: S3_DESTINATION_CREDENTIAL_ROLES,
      resticTransport: 's3', locality: 'unknown',
      actions: {
        test: { kind: 'hostAction', actionId: 'deployments.backups.test' },
        open: { pluginId, localId: 's3/open' },
      },
    },
  },
  actions: {
    's3/open': {
      title: 'Open S3 backup destination', execution: { target: 'daemon' },
      surfaces: ['plugin'], dangerLevel: 'safe', readOnly: true, inputSchema,
      resultSchema: BackupDestinationOpenV1ProtocolSchema,
      run: ({ config, credentialRoles }) => {
        const prepared = prepareS3Destination(config, credentialRoles);
        return {
          repository: prepared.repository, credentialBindings: prepared.credentialBindings,
          ...((prepared.config.region || prepared.config.addressing) ? {
            s3: {
              ...(prepared.config.region ? { region: prepared.config.region } : {}),
              ...(prepared.config.addressing ? { addressing: prepared.config.addressing } : {}),
            },
          } : {}),
        };
      },
    },
  },
});

export const PLUGIN_MANIFEST = plugin.manifest;
export const manifest = PLUGIN_MANIFEST;
