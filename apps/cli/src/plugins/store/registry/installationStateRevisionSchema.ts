import { z } from 'zod/mini';
import { PortableStorageIdSchema } from './commitRecordSchema';
import { PluginIdSchema } from '@happier-dev/protocol/plugins/plugin-id';
import { asHostProtocolZod } from '@/plugins/runtime/protocolComposableZodAdapter';

/** Installation writer and admitted reader share the same persisted framing. */
export const installationStateRevisionEnvelopeShape = {
  t: z.literal('happier_plugin_installations_v1'),
  schemaVersion: z.literal(1),
  revisionId: PortableStorageIdSchema,
  createdAtMs: z.number().check(z.int(), z.nonnegative()),
  bundledPluginEnabledById: z.optional(z.record(asHostProtocolZod(PluginIdSchema), z.boolean())),
};
