import { z } from 'zod';

import { PluginOptionalStringSchema } from '../_shared.js';
import { PluginDescriptorBaseV1Schema } from './_descriptors.js';

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

function rejectCredentialBearingMcpUrl(url: string, ctx: z.RefinementCtx): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['url'],
      message: 'Plugin MCP descriptor URLs must not embed credentials.',
    });
    return;
  }
  for (const [key, value] of parsed.searchParams.entries()) {
    if (isSensitiveMcpDescriptorKey(key) || MCP_BEARER_VALUE_PATTERN.test(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: 'Plugin MCP descriptor URLs must reference host-owned credential material instead of embedding raw query credentials.',
      });
      return;
    }
  }
  const fragment = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash;
  if (fragment.length > 0) {
    for (const [key, value] of new URLSearchParams(fragment).entries()) {
      if (isSensitiveMcpDescriptorKey(key) || MCP_BEARER_VALUE_PATTERN.test(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['url'],
          message: 'Plugin MCP descriptor URLs must not embed credential fragments.',
        });
        return;
      }
    }
  }
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
  } else if ((value.transport === 'http' || value.transport === 'sse') && typeof value.url === 'string') {
    rejectCredentialBearingMcpUrl(value.url, ctx);
  }
});
export type PluginMcpServerContributionV1 = z.infer<typeof PluginMcpServerContributionV1Schema>;

export const PluginMcpDiscoveryProviderContributionV1Schema = PluginDescriptorBaseV1Schema.safeExtend({
  kind: z.literal('mcp.discoveryProvider'),
  providerId: PluginOptionalStringSchema,
}).passthrough().superRefine((value, ctx) => {
  rejectRawMcpSecretMaterial(value, ctx);
});
export type PluginMcpDiscoveryProviderContributionV1 = z.infer<typeof PluginMcpDiscoveryProviderContributionV1Schema>;

export const PluginMcpContributesV1Schema = z.object({
  servers: z.array(PluginMcpServerContributionV1Schema).default([]),
  discoveryProviders: z.array(PluginMcpDiscoveryProviderContributionV1Schema).default([]),
}).strict().default({
  servers: [],
  discoveryProviders: [],
});
export type PluginMcpContributesV1 = z.infer<typeof PluginMcpContributesV1Schema>;
