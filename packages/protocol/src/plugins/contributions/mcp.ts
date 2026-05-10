import { z } from 'zod';

import { PluginOptionalStringSchema } from '../_shared.js';
import { PluginDescriptorBaseV1Schema } from './_descriptors.js';

const MCP_SEGMENT_PATTERN = /^[a-z0-9_-]+$/;
const MCP_SERVER_NAME_PATTERN = /^[a-z0-9_-]+$/;
const MCP_SENSITIVE_HEADER_KEYS = new Set([
  'authorization',
  'proxyauthorization',
]);
const MCP_SENSITIVE_DESCRIPTOR_KEYS = new Set([
  'authorization',
  'proxyauthorization',
  'apikey',
  'token',
  'accesstoken',
  'refreshtoken',
  'githubtoken',
  'clientsecret',
  'pat',
  'password',
  'secret',
]);
const MCP_BEARER_VALUE_PATTERN = /\bbearer\s+\S+/i;

function isCanonicalMcpToolName(value: string): boolean {
  const parts = value.split('.');
  if (parts.length < 2 || parts.some((part) => !MCP_SEGMENT_PATTERN.test(part))) {
    return false;
  }
  if (parts[0] === 'happier') {
    return parts.length >= 3;
  }
  if (parts[0] === 'ext') {
    return parts.length >= 3;
  }
  return parts.length >= 3;
}

function isCanonicalMcpToolNamespace(value: string): boolean {
  const parts = value.split('.');
  if (parts.length < 2 || parts.some((part) => !MCP_SEGMENT_PATTERN.test(part))) {
    return false;
  }
  if (parts[0] === 'happier') {
    return parts.length === 2;
  }
  if (parts[0] === 'ext') {
    return parts.length >= 2;
  }
  return parts.length === 2;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeMcpDescriptorKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function isMcpValueReference(value: unknown): boolean {
  return isRecord(value)
    && value.t === 'valueRef'
    && typeof value.ref === 'string'
    && value.ref.trim().length > 0;
}

function isSensitiveMcpDescriptorKey(key: string): boolean {
  const normalized = normalizeMcpDescriptorKey(key);
  return MCP_SENSITIVE_DESCRIPTOR_KEYS.has(normalized)
    || normalized.endsWith('token')
    || normalized.endsWith('apikey')
    || normalized.endsWith('secret');
}

function rejectRawMcpSecretMaterial(value: unknown, ctx: z.RefinementCtx, path: readonly (string | number)[] = []): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectRawMcpSecretMaterial(entry, ctx, [...path, index]));
    return;
  }
  if (!isRecord(value)) {
    if (typeof value === 'string' && MCP_BEARER_VALUE_PATTERN.test(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path],
        message: 'Plugin MCP descriptors must reference host-owned credential material instead of embedding raw authorization values.',
      });
    }
    return;
  }
  if (isMcpValueReference(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    if (MCP_SENSITIVE_HEADER_KEYS.has(normalizeMcpDescriptorKey(key)) || isSensitiveMcpDescriptorKey(key)) {
      if (!isMcpValueReference(child)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: childPath,
          message: `Plugin MCP descriptor field '${key}' must use a valueRef descriptor.`,
        });
        continue;
      }
      continue;
    }
    rejectRawMcpSecretMaterial(child, ctx, childPath);
  }
}

export const PluginMcpToolNameV1Schema = z
  .string()
  .trim()
  .min(1)
  .refine(isCanonicalMcpToolName, 'MCP tool names must use happier.*, ext.<pluginId>.*, or <providerId>.<server>.* prefixes');
export type PluginMcpToolNameV1 = z.infer<typeof PluginMcpToolNameV1Schema>;

export const PluginMcpToolNamespaceV1Schema = z
  .string()
  .trim()
  .min(1)
  .refine(isCanonicalMcpToolNamespace, 'MCP tool namespaces must use happier.*, ext.<pluginId>, or <providerId>.<server> prefixes');
export type PluginMcpToolNamespaceV1 = z.infer<typeof PluginMcpToolNamespaceV1Schema>;

export const PluginMcpServerTransportV1Schema = z.enum(['hosted', 'stdio', 'http', 'sse']);
export type PluginMcpServerTransportV1 = z.infer<typeof PluginMcpServerTransportV1Schema>;

export const PluginMcpServerContributionV1Schema = PluginDescriptorBaseV1Schema.safeExtend({
  kind: z.literal('mcp.server'),
  name: z.string().trim().min(1).regex(MCP_SERVER_NAME_PATTERN, 'Invalid MCP server name'),
  transport: PluginMcpServerTransportV1Schema,
  title: PluginOptionalStringSchema,
  description: PluginOptionalStringSchema,
  command: PluginOptionalStringSchema,
  args: z.array(z.string()).default([]),
  url: PluginOptionalStringSchema,
}).passthrough().superRefine((value, ctx) => {
  rejectRawMcpSecretMaterial(value, ctx);
  if (value.transport === 'stdio' && typeof value.command !== 'string') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['command'],
      message: 'stdio MCP descriptors require command.',
    });
  }
  if ((value.transport === 'http' || value.transport === 'sse') && typeof value.url !== 'string') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['url'],
      message: 'remote MCP descriptors require url.',
    });
  }
});
export type PluginMcpServerContributionV1 = z.infer<typeof PluginMcpServerContributionV1Schema>;

export const PluginMcpBackendClientContributionV1Schema = PluginDescriptorBaseV1Schema.safeExtend({
  kind: z.literal('mcp.backendClient'),
  serverName: z.string().trim().min(1).regex(MCP_SERVER_NAME_PATTERN, 'Invalid MCP server name'),
  toolNamespace: PluginMcpToolNamespaceV1Schema,
}).passthrough().superRefine((value, ctx) => {
  rejectRawMcpSecretMaterial(value, ctx);
});
export type PluginMcpBackendClientContributionV1 = z.infer<typeof PluginMcpBackendClientContributionV1Schema>;

export const PluginMcpToolContributionV1Schema = PluginDescriptorBaseV1Schema.safeExtend({
  kind: z.literal('mcp.tool'),
  name: PluginMcpToolNameV1Schema,
  title: PluginOptionalStringSchema,
  description: PluginOptionalStringSchema,
  inputSchema: z.unknown().optional(),
  outputSchema: z.unknown().optional(),
}).passthrough().superRefine((value, ctx) => {
  rejectRawMcpSecretMaterial(value, ctx);
});
export type PluginMcpToolContributionV1 = z.infer<typeof PluginMcpToolContributionV1Schema>;

export const PluginMcpDiscoveryProviderContributionV1Schema = PluginDescriptorBaseV1Schema.safeExtend({
  kind: z.literal('mcp.discoveryProvider'),
  providerId: PluginOptionalStringSchema,
}).passthrough().superRefine((value, ctx) => {
  rejectRawMcpSecretMaterial(value, ctx);
});
export type PluginMcpDiscoveryProviderContributionV1 = z.infer<typeof PluginMcpDiscoveryProviderContributionV1Schema>;

export const PluginMcpContributesV1Schema = z.object({
  servers: z.array(PluginMcpServerContributionV1Schema).default([]),
  backendClients: z.array(PluginMcpBackendClientContributionV1Schema).default([]),
  tools: z.array(PluginMcpToolContributionV1Schema).default([]),
  discoveryProviders: z.array(PluginMcpDiscoveryProviderContributionV1Schema).default([]),
}).strict().default({
  servers: [],
  backendClients: [],
  tools: [],
  discoveryProviders: [],
});
export type PluginMcpContributesV1 = z.infer<typeof PluginMcpContributesV1Schema>;
