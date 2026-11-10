import type { PluginJsonSchema, PluginContributionRef } from './identity.js';
import type { PluginLocalizedStringV2 } from './manifest.js';
import type { ReadonlyAuthorDeclaration } from './definePlugin.js';
import type { BackupDestinationContributionV1 as CanonicalBackupDestinationContributionV1 } from '@happier-dev/protocol/plugins/contributions/backupDestinations';
import { DeploymentBackupDestinationBindingIdentityV1ProtocolSchema } from '@happier-dev/protocol/deployments/storedAppInputV1';
import {
  defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, defineProtocolUnion,
  defineProtocolUniqueArray, type ProtocolSchemaOutput,
} from './protocol/protocolFacade.js';

/** Binding identities select existing Environment custody; they never contain credential values. */
export const BackupDestinationCredentialBindingV1ProtocolSchema = DeploymentBackupDestinationBindingIdentityV1ProtocolSchema;

/** Nonsecret storage operands consumed by the host's single restic request builder. */
export const BackupDestinationOpenV1ProtocolSchema = defineProtocolObject({
  repository: defineProtocolString({ minLength: 1 }),
  credentialBindings: defineProtocolUniqueArray(BackupDestinationCredentialBindingV1ProtocolSchema),
  local: defineProtocolObject({ path: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' }).optional(),
  sftp: defineProtocolObject({
    host: defineProtocolString({ minLength: 1 }),
    port: defineProtocolNumber({ integer: true, minimum: 1, maximum: 65535 }).optional(),
    username: defineProtocolString({ minLength: 1 }),
    hostKey: defineProtocolString({ minLength: 1 }),
  }, { policy: 'closed' }).optional(),
  s3: defineProtocolObject({
    region: defineProtocolString({ minLength: 1 }).optional(),
    addressing: defineProtocolUnion([
      defineProtocolLiteral('auto'), defineProtocolLiteral('dns'), defineProtocolLiteral('path'),
    ]).optional(),
  }, { policy: 'closed' }).optional(),
}, { policy: 'closed' });
export type BackupDestinationOpenV1 = ProtocolSchemaOutput<typeof BackupDestinationOpenV1ProtocolSchema>;

/** Declarative restic storage access; no backup engine or scheduler registration. */
export type BackupDestinationContributionV1 = Readonly<{
  id: string;
  title: PluginLocalizedStringV2;
  fieldHints?: CanonicalBackupDestinationContributionV1['fieldHints'];
  configSchema: ReadonlyAuthorDeclaration<PluginJsonSchema>;
  credentialRoles: readonly Readonly<CanonicalBackupDestinationContributionV1['credentialRoles'][number]>[];
  resticTransport: 's3' | 'sftp' | 'local';
  /** offHost requires proof from admitted configuration; it is not a durability guarantee. */
  locality: 'local' | 'offHost' | 'unknown';
  actions: Readonly<{ test: CanonicalBackupDestinationContributionV1['actions']['test']; open: PluginContributionRef }>;
}>;
