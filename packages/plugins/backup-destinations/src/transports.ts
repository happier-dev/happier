import { type BackupDestinationContributionV1, type BackupDestinationOpenV1 } from '@happier-dev/plugin-sdk';
import { defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString,
  defineProtocolUnion, defineProtocolUniqueArray } from '@happier-dev/plugin-sdk/protocol';

const text = () => defineProtocolString({ minLength: 1, pattern: '^[^\\u0000-\\u001F\\u007F]+$' });
export const LocalDestinationConfigSchema = defineProtocolObject({ path: text() }, { policy: 'closed' });
export const SftpDestinationConfigSchema = defineProtocolObject({
  host: defineProtocolString({ minLength: 1, pattern: '^[A-Za-z0-9][A-Za-z0-9.:%_-]*$' }),
  port: defineProtocolNumber({ integer: true, minimum: 1, maximum: 65535 }).optional(),
  username: text(),
  path: text(),
  hostKey: text(),
}, { policy: 'closed' });

const localRoles = ['repositoryPassword'] as const;
const sftpRoles = [...localRoles, 'sshPrivateKey'] as const;
export const LOCAL_DESTINATION_CREDENTIAL_ROLES: BackupDestinationContributionV1['credentialRoles'] = localRoles.map(role => ({ role }));
export const SFTP_DESTINATION_CREDENTIAL_ROLES: BackupDestinationContributionV1['credentialRoles'] = sftpRoles.map(role => ({ role }));
export const LocalDestinationRolesSchema = defineProtocolUniqueArray(defineProtocolLiteral(localRoles[0]),
  { minItems: localRoles.length, maxItems: localRoles.length });
export const SftpDestinationRolesSchema = defineProtocolUniqueArray(defineProtocolUnion([
  defineProtocolLiteral(sftpRoles[0]), defineProtocolLiteral(sftpRoles[1]),
]), { minItems: sftpRoles.length, maxItems: sftpRoles.length });

const binding = (role: BackupDestinationOpenV1['credentialBindings'][number]['role']) =>
  ({ purpose: 'backupDestination' as const, configKey: 'destination' as const, role });

export function prepareLocalDestination(input: unknown, roles: readonly string[] = localRoles): BackupDestinationOpenV1 {
  const config = LocalDestinationConfigSchema.parse(input);
  LocalDestinationRolesSchema.parse(roles);
  // Host expansion/canonicalization and mount admission belong to the executing daemon.
  return { repository: '/run/happier/backup/repository', local: config, credentialBindings: localRoles.map(binding) };
}

export function prepareSftpDestination(input: unknown, roles: readonly string[] = sftpRoles): BackupDestinationOpenV1 {
  const config = SftpDestinationConfigSchema.parse(input);
  SftpDestinationRolesSchema.parse(roles);
  // restic 0.19.1 sftp/config.go strips one URL slash before interpreting the
  // remote path. A home-relative path never expands against the sender's home.
  const path = config.path.startsWith('~/') ? config.path.slice(2) : config.path;
  const host = config.host.includes(':') ? `[${config.host}]` : config.host;
  return { repository: `sftp://${encodeURIComponent(config.username)}@${host}${config.port === undefined ? '' : `:${config.port}`}/${path.split('/').map(encodeURIComponent).join('/')}`,
    credentialBindings: sftpRoles.map(binding),
    sftp: { host: config.host, ...(config.port === undefined ? {} : { port: config.port }), username: config.username, hostKey: config.hostKey } };
}
