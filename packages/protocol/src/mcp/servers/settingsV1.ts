import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { McpRemoteUrlV1Schema } from '../remoteUrlV1.js';

const SERVER_NAME_REGEX = /^[a-z0-9_-]+$/;
const RESERVED_SERVER_NAMES = new Set(['happier', '__proto__', 'prototype', 'constructor']);

const ENV_KEY_REGEX = /^[A-Z_][A-Z0-9_]*$/;
const HEADER_KEY_REGEX = /^[A-Za-z0-9-]+$/;

export const McpValueRefV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.object({ t: z.literal('literal'), v: z.string() }).strict(),
  z.object({ t: z.literal('savedSecret'), secretId: z.string().min(1) }).strict(),
]));

export type McpValueRefV1 = z.infer<typeof McpValueRefV1Schema>;

const McpEnvVarKeyV1Schema = lazyZodSchema(() => z.string().regex(ENV_KEY_REGEX, 'Invalid environment variable name'));
const McpHeaderKeyV1Schema = lazyZodSchema(() => z.string().regex(HEADER_KEY_REGEX, 'Invalid header name'));

export const McpServerCatalogEntryTransportV1Schema = lazyZodSchema(() => z.enum(['stdio', 'http', 'sse']));
export type McpServerCatalogEntryTransportV1 = z.infer<typeof McpServerCatalogEntryTransportV1Schema>;

export const McpServerCatalogEntryV1Schema = lazyZodSchema(() => z
  .object({
    id: z.string().min(1),
    name: z
      .string()
      .min(1)
      .regex(SERVER_NAME_REGEX, 'Invalid MCP server name')
      .refine((value) => !RESERVED_SERVER_NAMES.has(value), 'Reserved MCP server name'),
    title: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    transport: McpServerCatalogEntryTransportV1Schema,
    stdio: z
      .object({
        command: z.string().min(1),
        args: z.array(z.string()),
      }).strict()
      .optional(),
    remote: z
      .object({
        url: McpRemoteUrlV1Schema,
        headers: z.record(McpHeaderKeyV1Schema, McpValueRefV1Schema),
      }).strict()
      .optional(),
    env: z.record(McpEnvVarKeyV1Schema, McpValueRefV1Schema),
    createdAt: z.number(),
    updatedAt: z.number(),
  }).strict()
  .superRefine((value, ctx) => {
    if (value.transport === 'stdio') {
      if (!value.stdio) {
        ctx.addIssue({ code: 'custom', message: 'Missing stdio config', path: ['stdio'] });
      }
      if (value.remote) {
        ctx.addIssue({ code: 'custom', message: 'remote is not allowed for stdio servers', path: ['remote'] });
      }
      return;
    }
    if (value.stdio) {
      ctx.addIssue({ code: 'custom', message: 'stdio is not allowed for remote servers', path: ['stdio'] });
    }
    if (!value.remote) {
      ctx.addIssue({ code: 'custom', message: 'Missing remote config', path: ['remote'] });
    }
  }));

export type McpServerCatalogEntryV1 = z.infer<typeof McpServerCatalogEntryV1Schema>;

function isAbsolutePath(value: string): boolean {
  if (!value) return false;
  if (value.startsWith('/')) return true;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  if (value.startsWith('\\\\')) return true;
  return false;
}

export const McpServerBindingTargetV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.object({ t: z.literal('allMachines') }).strict(),
  z.object({ t: z.literal('machine'), machineId: z.string().min(1) }).strict(),
  z.object({
    t: z.literal('workspace'),
    machineId: z.string().min(1),
    workspaceRoot: z.string().min(1).refine(isAbsolutePath, 'workspaceRoot must be an absolute path'),
  }).strict(),
]));

export type McpServerBindingTargetV1 = z.infer<typeof McpServerBindingTargetV1Schema>;

const McpValueRefOrNullV1Schema = lazyZodSchema(() => z.union([McpValueRefV1Schema, z.null()]));

export const McpServerBindingOverridesV1Schema = lazyZodSchema(() => z.object({
  stdio: z
    .object({
      command: z.string().min(1).optional(),
      args: z.array(z.string()).optional(),
    }).strict()
    .optional(),
  remote: z
    .object({
      url: McpRemoteUrlV1Schema.optional(),
      headersPatch: z.record(McpHeaderKeyV1Schema, McpValueRefOrNullV1Schema).optional(),
    }).strict()
    .optional(),
  envPatch: z.record(McpEnvVarKeyV1Schema, McpValueRefOrNullV1Schema).optional(),
}).strict());

export type McpServerBindingOverridesV1 = z.infer<typeof McpServerBindingOverridesV1Schema>;

export const McpServerBindingV1Schema = lazyZodSchema(() => z.object({
  id: z.string().min(1),
  serverId: z.string().min(1),
  enabled: z.boolean(),
  target: McpServerBindingTargetV1Schema,
  overrides: McpServerBindingOverridesV1Schema.optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
}).strict());

export type McpServerBindingV1 = z.infer<typeof McpServerBindingV1Schema>;

export function refineMcpServerCatalogV1(value: Readonly<{
  servers: readonly McpServerCatalogEntryV1[]; bindings: readonly McpServerBindingV1[];
}>, ctx: z.RefinementCtx): void {
  const serverIds = new Set<string>();
  const serverNames = new Set<string>();
  for (const [i, server] of value.servers.entries()) {
    if (serverIds.has(server.id)) ctx.addIssue({ code: 'custom', message: `Duplicate server id: ${server.id}`, path: ['servers', i, 'id'] });
    if (serverNames.has(server.name)) ctx.addIssue({ code: 'custom', message: `Duplicate server name: ${server.name}`, path: ['servers', i, 'name'] });
    serverIds.add(server.id); serverNames.add(server.name);
  }
  const bindingIds = new Set<string>();
  for (const [i, binding] of value.bindings.entries()) {
    if (bindingIds.has(binding.id)) ctx.addIssue({ code: 'custom', message: `Duplicate binding id: ${binding.id}`, path: ['bindings', i, 'id'] });
    if (!serverIds.has(binding.serverId)) ctx.addIssue({ code: 'custom', message: `Server not found: ${binding.serverId}`, path: ['bindings', i, 'serverId'] });
    bindingIds.add(binding.id);
  }
}

export const McpServersSettingsV1Schema = lazyZodSchema(() => z
  .preprocess(
    (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
      return raw;
    },
    z
      .object({
        v: z.literal(1).default(1),
        strictMode: z.boolean().default(false),
        servers: z.array(McpServerCatalogEntryV1Schema).default([]),
        bindings: z.array(McpServerBindingV1Schema).default([]),
      })
      .superRefine(refineMcpServerCatalogV1),
  ));

export type McpServersSettingsV1 = z.infer<typeof McpServersSettingsV1Schema>;
