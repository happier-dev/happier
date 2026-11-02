import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import { normalizePluginJsonSchema } from '../actions/protocolComposableSchema.js';
import { PluginContributionIdentityV1Schema, PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginJsonSchemaV2Schema, PluginLocalizedStringV2Schema } from './publicTypes.js';
import { isRecursivelyClosedPluginJsonSchemaV2 } from './jsonSchema.js';

/** Storage declarations only. Probe/open execution remains with ordinary qualified Actions. */
export const BackupDestinationContributionV1Schema = lazyZodSchema(() => z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: PluginLocalizedStringV2Schema,
  configSchema: PluginJsonSchemaV2Schema.check(z.superRefine((schema, context) => {
    try {
      normalizePluginJsonSchema(schema);
      if (schema.type !== 'object' || !isRecursivelyClosedPluginJsonSchemaV2(schema)) {
        context.addIssue({ code: 'custom', message: 'Destination configuration requires recursively closed object schemas.' });
      }
    } catch {
      context.addIssue({ code: 'custom', message: 'Invalid portable destination configuration schema.' });
    }
  })),
  credentialRoles: z.array(z.enum(['accessKeyId', 'secretAccessKey', 'sessionToken', 'repositoryPassword', 'sshPrivateKey']))
    .check(z.refine(roles => roles.includes('repositoryPassword') && new Set(roles).size === roles.length)),
  resticTransport: z.enum(['s3', 'sftp', 'local']),
  locality: z.enum(['local', 'offHost', 'unknown']),
  actions: z.strictObject({
    test: asProtocolZod(PluginContributionIdentityV1Schema),
    open: asProtocolZod(PluginContributionIdentityV1Schema),
  }),
}).check(z.superRefine((descriptor, context) => {
  if (descriptor.resticTransport === 'local' && descriptor.locality !== 'local') {
    context.addIssue({ code: 'custom', path: ['locality'], message: 'Local repositories are local recovery, not off-host storage.' });
  }
  const roles = descriptor.resticTransport === 'local' ? ['repositoryPassword']
    : descriptor.resticTransport === 'sftp' ? ['repositoryPassword', 'sshPrivateKey']
      : ['repositoryPassword', 'accessKeyId', 'secretAccessKey', 'sessionToken'];
  if (descriptor.credentialRoles.some(role => !roles.includes(role))) {
    context.addIssue({ code: 'custom', path: ['credentialRoles'], message: 'Credential role is not supported by this restic transport.' });
  }
})));
export type BackupDestinationContributionV1 = z.infer<typeof BackupDestinationContributionV1Schema>;
