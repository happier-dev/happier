import { BackupDestinationOpenV1ProtocolSchema, definePlugin, SFTP_BACKUP_DESTINATION_REF_V1 } from '@happier-dev/plugin-sdk';
import { defineProtocolObject, defineProtocolString, defineProtocolUniqueArray } from '@happier-dev/plugin-sdk/protocol';
import { prepareS3Destination, S3DestinationConfigSchema, S3DestinationCredentialRoleSchema,
  S3_DESTINATION_ADDRESSING_OPTIONS, S3_DESTINATION_CREDENTIAL_ROLES } from './s3.js';
import { LOCAL_DESTINATION_CREDENTIAL_ROLES, LocalDestinationConfigSchema, LocalDestinationRolesSchema, prepareLocalDestination,
  SFTP_DESTINATION_CREDENTIAL_ROLES, SftpDestinationConfigSchema, SftpDestinationRolesSchema, prepareSftpDestination } from './transports.js';

type S3Addressing = NonNullable<ReturnType<typeof prepareS3Destination>['config']['addressing']>;

function s3Destination(title: string, endpoint?: string, region?: string, addressing?: S3Addressing, description?: string) {
  return {
    title, configSchema: S3DestinationConfigSchema.jsonSchema,
    fieldHints: { fields: [
      ...(endpoint ? [{ path: 'endpoint', title: 'Endpoint', widget: 'text' as const, defaultValue: endpoint, description }] : []),
      ...(region ? [{ path: 'region', title: 'Region', widget: 'text' as const, defaultValue: region }] : []),
      { path: 'addressing', title: 'Addressing style', widget: 'select' as const, options: S3_DESTINATION_ADDRESSING_OPTIONS,
        ...(addressing ? { defaultValue: addressing } : {}) },
    ] },
    credentialRoles: S3_DESTINATION_CREDENTIAL_ROLES, resticTransport: 's3' as const, locality: 'unknown' as const,
    actions: { test: { kind: 'hostAction' as const, actionId: 'deployments.backups.test' as const },
      open: { pluginId, localId: 's3/open' } },
  };
}

const pluginId = SFTP_BACKUP_DESTINATION_REF_V1.pluginId;
const sftpOpenLocalId = `${SFTP_BACKUP_DESTINATION_REF_V1.localId}/open` as const;
const inputSchema = defineProtocolObject({
  config: S3DestinationConfigSchema,
  ownershipPrefix: defineProtocolString().optional(),
  credentialRoles: defineProtocolUniqueArray(S3DestinationCredentialRoleSchema).optional(),
}, { policy: 'closed' });

export const plugin = definePlugin({
  id: pluginId,
  version: '0.0.0',
  displayName: 'Backup destinations',
  entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
  activation: { events: [] },
  hostAccess: { required: [], optional: [] },
  backupDestinations: {
    s3: s3Destination('S3 object storage'),
    // Account/jurisdiction endpoint and auto region: https://developers.cloudflare.com/r2/api/s3/api/
    // Path addressing: https://developers.cloudflare.com/basin-catalog/config-examples/trino/
    'cloudflare-r2': s3Destination('Cloudflare R2', 'https://<account-id>.r2.cloudflarestorage.com', 'auto', 'path',
      'Replace <account-id> with your Cloudflare Account ID. Use the jurisdiction endpoint for a restricted bucket.'),
    // HTTPS regional endpoint; both addressing styles: https://www.backblaze.com/docs/en/cloud-storage-call-the-s3-compatible-api
    'backblaze-b2': s3Destination('Backblaze B2', 'https://s3.us-east-005.backblazeb2.com', 'us-east-005', 'path',
      'Use the endpoint and region shown for your bucket. This example uses us-east-005.'),
    // https://docs.wasabi.com/docs/service-urls-for-wasabis-storage-regions
    // Path-style recommendation: https://docs.wasabi.com/apidocs/rest-api-introduction
    wasabi: s3Destination('Wasabi', 'https://s3.wasabisys.com', 'us-east-1', 'path',
      'Use the endpoint and region for your bucket. This example uses us-east-1.'),
    // Location region and --path off: https://docs.hetzner.com/storage/object-storage/getting-started/using-s3-api-tools/
    hetzner: s3Destination('Hetzner Object Storage', 'https://fsn1.your-objectstorage.com', 'fsn1', 'dns',
      'Use your bucket location for both endpoint and region. This example uses Falkenstein (fsn1).'),
    [SFTP_BACKUP_DESTINATION_REF_V1.localId]: {
      title: 'SFTP server', configSchema: SftpDestinationConfigSchema.jsonSchema,
      fieldHints: { fields: [{ path: 'hostKey', title: 'Server host key', widget: 'text',
        description: 'The verified OpenSSH known-host entry for this server and port.' },
        { path: 'path', title: 'Repository directory', widget: 'text', description: 'An absolute path on the server, or a path relative to the remote login’s home.' }] },
      credentialRoles: SFTP_DESTINATION_CREDENTIAL_ROLES,
      resticTransport: 'sftp', locality: 'unknown',
      actions: { test: { kind: 'hostAction', actionId: 'deployments.backups.test' }, open: { pluginId, localId: sftpOpenLocalId } },
    },
    local: {
      title: 'Local directory', configSchema: LocalDestinationConfigSchema.jsonSchema,
      fieldHints: { fields: [{ path: 'path', title: 'Repository directory', widget: 'text',
        description: 'A directory on the executing Machine.' }] },
      credentialRoles: LOCAL_DESTINATION_CREDENTIAL_ROLES, resticTransport: 'local', locality: 'local',
      actions: { test: { kind: 'hostAction', actionId: 'deployments.backups.test' }, open: { pluginId, localId: 'local/open' } },
    },
  },
  actions: {
    'local/open': {
      title: 'Open local backup destination', execution: { target: 'daemon' },
      surfaces: ['plugin'], dangerLevel: 'safe', readOnly: true,
      inputSchema: defineProtocolObject({ config: LocalDestinationConfigSchema,
        ownershipPrefix: defineProtocolString().optional(),
        credentialRoles: LocalDestinationRolesSchema.optional() }, { policy: 'closed' }),
      resultSchema: BackupDestinationOpenV1ProtocolSchema,
      run: ({ config, credentialRoles, ownershipPrefix }) => prepareLocalDestination(config, credentialRoles, ownershipPrefix),
    },
    [sftpOpenLocalId]: {
      title: 'Open SFTP backup destination', execution: { target: 'daemon' },
      surfaces: ['plugin'], dangerLevel: 'safe', readOnly: true,
      inputSchema: defineProtocolObject({ config: SftpDestinationConfigSchema,
        ownershipPrefix: defineProtocolString().optional(),
        credentialRoles: SftpDestinationRolesSchema.optional() }, { policy: 'closed' }),
      resultSchema: BackupDestinationOpenV1ProtocolSchema,
      run: ({ config, credentialRoles, ownershipPrefix }) => prepareSftpDestination(config, credentialRoles, ownershipPrefix),
    },
    's3/open': {
      title: 'Open S3 backup destination', execution: { target: 'daemon' },
      surfaces: ['plugin'], dangerLevel: 'safe', readOnly: true, inputSchema,
      resultSchema: BackupDestinationOpenV1ProtocolSchema,
      run: ({ config, credentialRoles, ownershipPrefix }) => {
        const prepared = prepareS3Destination(config, credentialRoles, ownershipPrefix);
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
