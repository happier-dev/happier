import { z } from 'zod';

import { PluginDeclaredExecutableRefSchema } from './agentAcpTransport.js';
import { PluginAvailabilityDescriptorV2Schema, PluginJsonSchemaV2Schema, PluginJsonValueV2Schema, PluginLocalizedStringV2Schema } from './publicTypes.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { McpRemoteUrlV1Schema } from '../../mcp/remoteUrlV1.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

export const PluginMcpServerTransportV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('stdio'), executable: PluginDeclaredExecutableRefSchema, args: z.array(z.string()).optional() }).strict(),
  z.object({ kind: z.literal('http'), url: McpRemoteUrlV1Schema }).strict(),
]);
export type PluginMcpServerTransportV1 = z.infer<typeof PluginMcpServerTransportV1Schema>;

const McpDisplaySchema = z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: PluginLocalizedStringV2Schema,
  description: PluginLocalizedStringV2Schema.optional(),
  availability: PluginAvailabilityDescriptorV2Schema.optional(),
  metadata: z.record(z.string(), PluginJsonValueV2Schema).optional(),
});
export const PluginMcpServerContributionV1Schema = z.discriminatedUnion('kind', [
  McpDisplaySchema.extend({ kind: z.literal('static'), transport: PluginMcpServerTransportV1Schema, sessionScope: z.enum(['global', 'session']).optional() }).strict(),
  McpDisplaySchema.extend({ kind: z.literal('dynamic'), sessionScope: z.enum(['global', 'session']).optional() }).strict(),
]);
export type PluginMcpServerContributionV1 = z.infer<typeof PluginMcpServerContributionV1Schema>;

export const PluginMcpDiscoverySourceContributionV1Schema = McpDisplaySchema.extend({
  resultSchema: PluginJsonSchemaV2Schema.optional(),
}).strict();
export type PluginMcpDiscoverySourceContributionV1 = z.infer<typeof PluginMcpDiscoverySourceContributionV1Schema>;

export const PluginMcpContributesV1Schema = z.object({
  servers: z.array(PluginMcpServerContributionV1Schema).default([]),
  discoverySources: z.array(PluginMcpDiscoverySourceContributionV1Schema).default([]),
}).strict().default({
  servers: [],
  discoverySources: [],
});
export type PluginMcpContributesV1 = z.infer<typeof PluginMcpContributesV1Schema>;
