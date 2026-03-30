import { z } from 'zod';

const SERVER_NAME_REGEX = /^[a-z0-9_-]+$/;
const RESERVED_SERVER_NAMES = new Set(['happier', '__proto__', 'prototype', 'constructor']);

const ENV_KEY_REGEX = /^[A-Z_][A-Z0-9_]*$/;
const HEADER_KEY_REGEX = /^[A-Za-z0-9-]+$/;

export const McpValueRefV1Schema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('literal'), v: z.string() }),
  z.object({ t: z.literal('savedSecret'), secretId: z.string().min(1) }),
]);

export type McpValueRefV1 = z.infer<typeof McpValueRefV1Schema>;

const McpEnvVarKeyV1Schema = z.string().regex(ENV_KEY_REGEX, 'Invalid environment variable name');
const McpHeaderKeyV1Schema = z.string().regex(HEADER_KEY_REGEX, 'Invalid header name');

export const McpServerCatalogEntryTransportV1Schema = z.enum(['stdio', 'http', 'sse']);
export type McpServerCatalogEntryTransportV1 = z.infer<typeof McpServerCatalogEntryTransportV1Schema>;

export const McpServerCatalogEntryV1Schema = z
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
      })
      .optional(),
    remote: z
      .object({
        url: z.string().min(1),
        headers: z.record(McpHeaderKeyV1Schema, McpValueRefV1Schema),
      })
      .optional(),
    env: z.record(McpEnvVarKeyV1Schema, McpValueRefV1Schema),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
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
  });

export type McpServerCatalogEntryV1 = z.infer<typeof McpServerCatalogEntryV1Schema>;

function isAbsolutePath(value: string): boolean {
  if (!value) return false;
  if (value.startsWith('/')) return true;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  if (value.startsWith('\\\\')) return true;
  return false;
}

export const McpServerBindingTargetV1Schema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('allMachines') }),
  z.object({ t: z.literal('machine'), machineId: z.string().min(1) }),
  z.object({
    t: z.literal('workspace'),
    machineId: z.string().min(1),
    workspaceRoot: z.string().min(1).refine(isAbsolutePath, 'workspaceRoot must be an absolute path'),
  }),
]);

export type McpServerBindingTargetV1 = z.infer<typeof McpServerBindingTargetV1Schema>;

const McpValueRefOrNullV1Schema = z.union([McpValueRefV1Schema, z.null()]);

export const McpServerBindingOverridesV1Schema = z.object({
  stdio: z
    .object({
      command: z.string().min(1).optional(),
      args: z.array(z.string()).optional(),
    })
    .optional(),
  remote: z
    .object({
      url: z.string().min(1).optional(),
      headersPatch: z.record(McpHeaderKeyV1Schema, McpValueRefOrNullV1Schema).optional(),
    })
    .optional(),
  envPatch: z.record(McpEnvVarKeyV1Schema, McpValueRefOrNullV1Schema).optional(),
});

export type McpServerBindingOverridesV1 = z.infer<typeof McpServerBindingOverridesV1Schema>;

export const McpServerBindingV1Schema = z.object({
  id: z.string().min(1),
  serverId: z.string().min(1),
  enabled: z.boolean(),
  target: McpServerBindingTargetV1Schema,
  overrides: McpServerBindingOverridesV1Schema.optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type McpServerBindingV1 = z.infer<typeof McpServerBindingV1Schema>;

export const McpServersSettingsV1Schema = z
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
      .superRefine((value, ctx) => {
        const serverIds = new Set<string>();
        const serverNames = new Set<string>();

        for (let i = 0; i < value.servers.length; i++) {
          const server = value.servers[i];
          if (serverIds.has(server.id)) {
            ctx.addIssue({ code: 'custom', message: `Duplicate server id: ${server.id}`, path: ['servers', i, 'id'] });
          } else {
            serverIds.add(server.id);
          }

          if (serverNames.has(server.name)) {
            ctx.addIssue({ code: 'custom', message: `Duplicate server name: ${server.name}`, path: ['servers', i, 'name'] });
          } else {
            serverNames.add(server.name);
          }
        }

        const bindingIds = new Set<string>();
        for (let i = 0; i < value.bindings.length; i++) {
          const binding = value.bindings[i];
          if (bindingIds.has(binding.id)) {
            ctx.addIssue({ code: 'custom', message: `Duplicate binding id: ${binding.id}`, path: ['bindings', i, 'id'] });
          } else {
            bindingIds.add(binding.id);
          }
        }
      }),
  );

export type McpServersSettingsV1 = z.infer<typeof McpServersSettingsV1Schema>;
