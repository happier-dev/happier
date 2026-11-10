import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import { normalizePluginJsonSchema } from '../actions/protocolComposableSchema.js';
import { PluginContributionIdentityV1Schema, PluginContributionLocalIdSchema, type PluginContributionIdentityV1 } from '../contributionIdentity.js';
import { PluginJsonSchemaV2Schema, PluginLocalizedStringV2Schema } from './publicTypes.js';
import { isRecursivelyClosedPluginJsonSchemaV2 } from './jsonSchema.js';
import { DEPLOYMENT_BACKUP_TEST_ACTION_ID_V1 } from '../../deployments/deploymentActionIdsV1.js';
import { InputHintsSchema } from '../../inputs/inputFields.js';

/** The bundled receiver setup composes this exact destination configuration. */
export const SFTP_BACKUP_DESTINATION_REF_V1 = Object.freeze({
  pluginId: 'happier.backup.destinations', localId: 'sftp',
} as const) satisfies PluginContributionIdentityV1;

/** Storage declarations only. Probe/open execution remains with ordinary qualified Actions. */
export const BackupDestinationContributionV1Schema = lazyZodSchema(() => z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: PluginLocalizedStringV2Schema,
  fieldHints: z.optional(InputHintsSchema),
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
  credentialRoles: z.array(z.strictObject({
    role: z.enum(['accessKeyId', 'secretAccessKey', 'sessionToken', 'repositoryPassword', 'sshPrivateKey']),
    /** Omitted means required; optional roles may be left unbound. */
    optional: z.optional(z.boolean()),
  })).check(z.refine(roles => roles.some(entry => entry.role === 'repositoryPassword')
    && new Set(roles.map(entry => entry.role)).size === roles.length)),
  resticTransport: z.enum(['s3', 'sftp', 'local']),
  locality: z.enum(['local', 'offHost', 'unknown']),
  actions: z.strictObject({
    test: z.union([asProtocolZod(PluginContributionIdentityV1Schema),
      z.strictObject({ kind: z.literal('hostAction'), actionId: z.literal(DEPLOYMENT_BACKUP_TEST_ACTION_ID_V1) })]),
    open: asProtocolZod(PluginContributionIdentityV1Schema),
  }),
}).check(z.superRefine((descriptor, context) => {
  if (descriptor.resticTransport === 'local' && descriptor.locality !== 'local') {
    context.addIssue({ code: 'custom', path: ['locality'], message: 'Local repositories are local recovery, not off-host storage.' });
  }
  const roles = descriptor.resticTransport === 'local' ? ['repositoryPassword']
    : descriptor.resticTransport === 'sftp' ? ['repositoryPassword', 'sshPrivateKey']
      : ['repositoryPassword', 'accessKeyId', 'secretAccessKey', 'sessionToken'];
  if (descriptor.credentialRoles.some(entry => !roles.includes(entry.role))) {
    context.addIssue({ code: 'custom', path: ['credentialRoles'], message: 'Credential role is not supported by this restic transport.' });
  }
})));
export type BackupDestinationContributionV1 = z.infer<typeof BackupDestinationContributionV1Schema>;
