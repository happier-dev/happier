import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { PluginDeclaredExecutableRefSchema } from './agentAcpTransport.js';
import { PluginAvailabilityDescriptorV2Schema, PluginJsonSchemaV2Schema, PluginJsonValueV2Schema, PluginLocalizedStringV2Schema } from './publicTypes.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { McpRemoteUrlV1Schema } from '../../mcp/remoteUrlV1.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

export const PluginMcpServerTransportV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('stdio'), executable: PluginDeclaredExecutableRefSchema, args: z.optional(z.array(z.string())) }),
  z.strictObject({ kind: z.literal('http'), url: McpRemoteUrlV1Schema }),
]));
export type PluginMcpServerTransportV1 = z.infer<typeof PluginMcpServerTransportV1Schema>;

const McpDisplaySchema = lazyZodSchema(() => z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: PluginLocalizedStringV2Schema,
  description: z.optional(PluginLocalizedStringV2Schema),
  availability: z.optional(PluginAvailabilityDescriptorV2Schema),
  metadata: z.optional(z.record(z.string(), PluginJsonValueV2Schema)),
}));
export const PluginMcpServerContributionV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(McpDisplaySchema, { kind: z.literal('static'), transport: PluginMcpServerTransportV1Schema, sessionScope: z.optional(z.enum(['global', 'session'])) })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(McpDisplaySchema, { kind: z.literal('dynamic'), sessionScope: z.optional(z.enum(['global', 'session'])) })),
]));
export type PluginMcpServerContributionV1 = z.infer<typeof PluginMcpServerContributionV1Schema>;

export const PluginMcpDiscoverySourceContributionV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(McpDisplaySchema, {
  loadedInHappierSessions: z.boolean(),
  resultSchema: z.optional(PluginJsonSchemaV2Schema),
})));
export type PluginMcpDiscoverySourceContributionV1 = z.infer<typeof PluginMcpDiscoverySourceContributionV1Schema>;

export const PluginMcpContributesV1Schema = lazyZodSchema(() => z._default(z.strictObject({
  servers: z._default(z.array(PluginMcpServerContributionV1Schema), []),
  discoverySources: z._default(z.array(PluginMcpDiscoverySourceContributionV1Schema), []),
}), {
  servers: [],
  discoverySources: [],
}));
export type PluginMcpContributesV1 = z.infer<typeof PluginMcpContributesV1Schema>;
