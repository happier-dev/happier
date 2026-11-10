import { BackupDestinationCredentialBindingV1ProtocolSchema, type BackupDestinationContributionV1, type BackupDestinationOpenV1 } from '@happier-dev/plugin-sdk';
import {
  defineProtocolArray,
  defineProtocolLiteral,
  defineProtocolObject,
  defineProtocolString,
  defineProtocolUnion,
  defineProtocolUniqueArray,
  ProtocolValidationError,
} from '@happier-dev/plugin-sdk/protocol';

export const S3_DESTINATION_ADDRESSING_OPTIONS = [
  { value: 'auto', label: 'Automatic' }, { value: 'dns', label: 'Virtual hosted' }, { value: 'path', label: 'Path style' },
] as const;
export type S3DestinationConfig = {
  endpoint: string; bucket: string; prefix: string;
  region?: string; addressing?: typeof S3_DESTINATION_ADDRESSING_OPTIONS[number]['value'];
};
/** Nonsecret restic 0.19.1 S3 settings; credentials belong to Environment bindings. */
export const S3DestinationConfigSchema = defineProtocolObject({
  endpoint: defineProtocolString({ minLength: 1, pattern: '^https?://[^\\s/?#@\\\\]+/?$' }),
  bucket: defineProtocolString({ minLength: 1, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' }),
  prefix: defineProtocolString(),
  region: defineProtocolString({ minLength: 1 }).optional(),
  addressing: defineProtocolUnion([
    defineProtocolLiteral(S3_DESTINATION_ADDRESSING_OPTIONS[0].value),
    defineProtocolLiteral(S3_DESTINATION_ADDRESSING_OPTIONS[1].value),
    defineProtocolLiteral(S3_DESTINATION_ADDRESSING_OPTIONS[2].value),
  ]).optional(),
}, { policy: 'closed' });

export type S3DestinationCredentialRole = Exclude<BackupDestinationOpenV1['credentialBindings'][number]['role'], 'sshPrivateKey'>;
export const S3DestinationCredentialRoleSchema = defineProtocolUnion([
  defineProtocolLiteral('repositoryPassword'), defineProtocolLiteral('accessKeyId'),
  defineProtocolLiteral('secretAccessKey'), defineProtocolLiteral('sessionToken'),
]);

const requiredRoles = ['repositoryPassword', 'accessKeyId', 'secretAccessKey'] as const;
/** Publish the same required roles that the S3 open owner enforces. */
export const S3_DESTINATION_CREDENTIAL_ROLES: BackupDestinationContributionV1['credentialRoles'] = [
  ...requiredRoles.map(role => ({ role })), { role: 'sessionToken', optional: true },
];
const selectedRolesSchema = defineProtocolUniqueArray(S3DestinationCredentialRoleSchema, { minItems: 3, maxItems: 4 });

/** Requested role identities select existing custody; they do not prove or grant access. */
export type S3DestinationOpen = {
  kind: 's3'; repository: string; config: S3DestinationConfig;
  credentialBindings: BackupDestinationOpenV1['credentialBindings'];
};
export const S3DestinationOpenSchema = defineProtocolObject({
  kind: defineProtocolLiteral('s3'),
  repository: defineProtocolString({ minLength: 1, pattern: '^s3:https?://' }),
  config: S3DestinationConfigSchema,
  credentialBindings: defineProtocolArray(BackupDestinationCredentialBindingV1ProtocolSchema, { minItems: 3, maxItems: 4 }),
}, { policy: 'closed' });

function invalid(path: string, message: string): never {
  throw new ProtocolValidationError([{ path: [path], code: 'invalid_value', message }]);
}

/**
 * Prepare storage access without opening the network or materializing a secret.
 * Native options are interpreted by the sole pinned restic request builder.
 */
export function prepareS3Destination(
  input: unknown,
  selectedCredentialRoles: readonly S3DestinationCredentialRole[] = requiredRoles,
): S3DestinationOpen {
  const config = S3DestinationConfigSchema.parse(input);
  const roles = selectedRolesSchema.parse(selectedCredentialRoles);
  if (requiredRoles.some(role => !roles.includes(role))) {
    invalid('credentialRoles', 'S3 requires repository password and access-key role identities.');
  }
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'string' && /[\u0000-\u001F\u007F]/.test(value)) {
      invalid(key, 'Storage configuration cannot contain control characters.');
    }
  }

  let endpoint: URL;
  try { endpoint = new URL(config.endpoint); }
  catch { invalid('endpoint', 'A valid HTTP or HTTPS storage endpoint is required.'); }
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
    invalid('endpoint', 'The storage endpoint must contain only its protocol, host and port.');
  }
  // restic v0.19.1 internal/backend/s3/config.go uses path.Clean(prefix).
  // Reject identity-changing inputs rather than silently select another prefix.
  if (config.prefix && config.prefix.split('/').some(part => !part || part === '.' || part === '..')) {
    invalid('prefix', 'Use an exact repository prefix without empty or dot path segments.');
  }
  const prefix = config.prefix.split('/').map(encodeURIComponent).join('/');
  const normalizedConfig = { ...config, endpoint: endpoint.origin };
  const credentialRoles: readonly S3DestinationCredentialRole[] = roles.includes('sessionToken')
    ? [...requiredRoles, 'sessionToken'] : requiredRoles;
  return S3DestinationOpenSchema.parse({
    kind: 's3',
    repository: `s3:${endpoint.origin}/${config.bucket}${prefix ? `/${prefix}` : ''}`,
    config: normalizedConfig,
    credentialBindings: credentialRoles.map(role => ({
      purpose: 'backupDestination', configKey: 'destination', role,
    })),
  });
}
