import { z } from 'zod';

import { PluginContributionReferenceV2Schema } from './publicTypes.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';

type DeepReadonly<T> = T extends readonly (infer TItem)[]
  ? readonly DeepReadonly<TItem>[]
  : T extends object
    ? { readonly [TKey in keyof T]: DeepReadonly<T[TKey]> }
    : T;

const ProcessStringSchema = z.string()
  .refine((value) => !value.includes('\0'), 'Process values cannot contain null bytes');

export const PluginDeclaredExecutableRefSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('managedDependency'),
    id: asProtocolZod(PluginContributionReferenceV2Schema),
  }).strict(),
  z.object({
    kind: z.literal('systemTool'),
    id: asProtocolZod(PluginContributionReferenceV2Schema),
  }).strict(),
]);

const PackagedRuntimePathSegmentSchema = z.string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);

export const PackagedRuntimeBinaryExecutableRefSchema = z.object({
  kind: z.literal('packaged-runtime-binary'),
  directorySegments: z.array(PackagedRuntimePathSegmentSchema).min(1).max(8).readonly(),
  executableBaseName: PackagedRuntimePathSegmentSchema,
}).strict();

export const ManagedExecutableRefSchema = z.discriminatedUnion('kind', [
  ...PluginDeclaredExecutableRefSchema.options,
  PackagedRuntimeBinaryExecutableRefSchema,
]);
export type ManagedExecutableRef = DeepReadonly<z.infer<typeof ManagedExecutableRefSchema>>;

const PluginAgentAcpTimeoutMsSchema = z.number()
  .int()
  .min(1)
  .max(2_147_483_647);

export const PluginAgentAcpTimeoutsSchema = z.object({
  initializeMs: PluginAgentAcpTimeoutMsSchema.optional(),
  idleMs: PluginAgentAcpTimeoutMsSchema.optional(),
  toolCallMs: PluginAgentAcpTimeoutMsSchema.optional(),
}).strict();
export type PluginAgentAcpTimeouts = DeepReadonly<z.infer<typeof PluginAgentAcpTimeoutsSchema>>;

const PluginAgentAcpEnvironmentSchema = z.record(
  ProcessStringSchema
    .min(1)
    .refine((value) => value === value.trim(), 'Environment keys cannot have surrounding whitespace'),
  ProcessStringSchema,
);

const HttpHeaderNameSchema = z.string()
  .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/, 'Invalid HTTP header name');
const HttpHeaderValueSchema = z.string()
  .refine((value) => !/[\0\r\n]/u.test(value), 'Invalid HTTP header value');
const PluginAgentAcpHeadersSchema = z.record(HttpHeaderNameSchema, HttpHeaderValueSchema);

const PluginAgentAcpWebSocketUrlSchema = z.string()
  .trim()
  .min(1)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'ws:' || url.protocol === 'wss:';
    } catch {
      return false;
    }
  }, 'ACP WebSocket transport URL must use ws:// or wss://');

export const PluginAgentAcpTransportSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('stdio'),
    executable: PluginDeclaredExecutableRefSchema,
    preferredPath: ProcessStringSchema.trim().min(1).optional(),
    args: z.array(ProcessStringSchema).optional(),
    env: PluginAgentAcpEnvironmentSchema.optional(),
    timeouts: PluginAgentAcpTimeoutsSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('webSocket'),
    url: PluginAgentAcpWebSocketUrlSchema,
    headers: PluginAgentAcpHeadersSchema.optional(),
    timeouts: PluginAgentAcpTimeoutsSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('tcp'),
    host: ProcessStringSchema.trim().min(1),
    port: z.number().int().min(1).max(65_535),
    timeouts: PluginAgentAcpTimeoutsSchema.optional(),
  }).strict(),
]);
export type PluginAgentAcpTransport = DeepReadonly<z.infer<typeof PluginAgentAcpTransportSchema>>;
