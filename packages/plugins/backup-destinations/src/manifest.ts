import { BackupDestinationOpenV1ProtocolSchema, definePlugin, SFTP_BACKUP_DESTINATION_REF_V1 } from '@happier-dev/plugin-sdk';
import { defineProtocolObject, defineProtocolString, defineProtocolUniqueArray } from '@happier-dev/plugin-sdk/protocol';
import { prepareS3Destination, S3DestinationConfigSchema, S3DestinationCredentialRoleSchema,
  S3_DESTINATION_ADDRESSING_OPTIONS, S3_DESTINATION_CREDENTIAL_ROLES } from './s3.js';
import { LOCAL_DESTINATION_CREDENTIAL_ROLES, LocalDestinationConfigSchema, LocalDestinationRolesSchema, prepareLocalDestination,
  SFTP_DESTINATION_CREDENTIAL_ROLES, SftpDestinationConfigSchema, SftpDestinationRolesSchema, prepareSftpDestination } from './transports.js';

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
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  activation: { events: [] },
  hostAccess: { required: [], optional: [] },
  backupDestinations: {
    s3: {
      title: 'S3 object storage', configSchema: S3DestinationConfigSchema.jsonSchema,
      fieldHints: { fields: [{ path: 'addressing', title: 'Addressing style', widget: 'select', options: S3_DESTINATION_ADDRESSING_OPTIONS }] },
      credentialRoles: S3_DESTINATION_CREDENTIAL_ROLES,
      resticTransport: 's3', locality: 'unknown',
      actions: {
        test: { kind: 'hostAction', actionId: 'deployments.backups.test' },
        open: { pluginId, localId: 's3/open' },
      },
    },
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
        description: 'A directory on the executing Machine. Same disk, not off-site: repository growth can fill this disk.' }] },
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
