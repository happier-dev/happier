import { z } from 'zod';

import { AgentProviderIdV1Schema } from '../providers/agentProviderIdsV1.js';
import { McpServerBindingV1Schema, McpServerCatalogEntryTransportV1Schema, McpServerCatalogEntryV1Schema } from './settingsV1.js';

export const McpDetectedProviderV1Schema = AgentProviderIdV1Schema;
export type McpDetectedProviderV1 = z.infer<typeof McpDetectedProviderV1Schema>;

export const DetectedMcpServerV1Schema = z
  .object({
    provider: McpDetectedProviderV1Schema,
    name: z.string().min(1),
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
        headers: z.array(z.string()),
      })
      .optional(),
    envKeys: z.array(z.string()),
    enabled: z.union([z.boolean(), z.null()]),
    source: z.object({
      kind: z.enum(['user', 'project']),
      path: z.string().min(1),
    }).passthrough(),
  })
  .passthrough()
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

export type DetectedMcpServerV1 = z.infer<typeof DetectedMcpServerV1Schema>;

export const DaemonMcpServersDetectWarningV1Schema = z.object({
  provider: McpDetectedProviderV1Schema,
  code: z.enum(['read_failed', 'parse_failed', 'unsupported']),
  path: z.string().min(1).optional(),
  detail: z.string().min(1).optional(),
}).passthrough();
export type DaemonMcpServersDetectWarningV1 = z.infer<typeof DaemonMcpServersDetectWarningV1Schema>;

export const DaemonMcpServersDetectRequestSchema = z
  .object({
    machineId: z.string().min(1),
    directory: z.string().min(1).max(10_000).optional(),
    providers: z.array(McpDetectedProviderV1Schema).optional(),
  })
  .passthrough();

export type DaemonMcpServersDetectRequest = z.infer<typeof DaemonMcpServersDetectRequestSchema>;

export const DaemonMcpServersDetectResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    servers: z.array(DetectedMcpServerV1Schema),
    warnings: z.array(DaemonMcpServersDetectWarningV1Schema).optional(),
  }).passthrough(),
  z.object({
    ok: z.literal(false),
    errorCode: z.enum(['invalid_request', 'internal_error']),
    error: z.string().min(1),
  }).passthrough(),
]);
export type DaemonMcpServersDetectResponse = z.infer<typeof DaemonMcpServersDetectResponseSchema>;

export const DaemonMcpServersTestErrorCodeSchema = z.enum([
  'invalid_request',
  'missing_credentials',
  'server_not_found',
  'binding_not_found',
  'server_disabled',
  'materialization_failed',
  'mcp_connect_failed',
  'mcp_list_tools_failed',
]);
export type DaemonMcpServersTestErrorCode = z.infer<typeof DaemonMcpServersTestErrorCodeSchema>;

export const DaemonMcpServersTestRequestSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('draft'),
    machineId: z.string().min(1),
    directory: z.string().min(1).max(10_000),
    server: McpServerCatalogEntryV1Schema,
    binding: McpServerBindingV1Schema.nullish(),
  }).passthrough(),
  z.object({
    t: z.literal('byId'),
    machineId: z.string().min(1),
    directory: z.string().min(1).max(10_000),
    serverId: z.string().min(1),
    bindingId: z.string().min(1).optional(),
  }).passthrough(),
]);
export type DaemonMcpServersTestRequest = z.infer<typeof DaemonMcpServersTestRequestSchema>;

export const DaemonMcpServersTestResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    toolCount: z.number().int().min(0),
    toolNamesSample: z.array(z.string()).optional(),
    durationMs: z.number().int().min(0),
  }).passthrough(),
  z.object({
    ok: z.literal(false),
    errorCode: DaemonMcpServersTestErrorCodeSchema,
    error: z.string().min(1),
    durationMs: z.number().int().min(0),
  }).passthrough(),
]);
export type DaemonMcpServersTestResponse = z.infer<typeof DaemonMcpServersTestResponseSchema>;
