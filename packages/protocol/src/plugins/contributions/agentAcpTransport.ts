import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { PluginContributionReferenceV2Schema } from './publicTypes.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';

type DeepReadonly<T> = T extends readonly (infer TItem)[]
  ? readonly DeepReadonly<TItem>[]
  : T extends object
    ? { readonly [TKey in keyof T]: DeepReadonly<T[TKey]> }
    : T;

const ProcessStringSchema = lazyZodSchema(() => z.string().check(z.refine((value) => !value.includes('\0'), 'Process values cannot contain null bytes')));

export const PluginDeclaredExecutableRefSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('managedDependency'),
    id: asProtocolZod(PluginContributionReferenceV2Schema),
  }),
  z.strictObject({
    kind: z.literal('systemTool'),
    id: asProtocolZod(PluginContributionReferenceV2Schema),
  }),
]));

const PackagedRuntimePathSegmentSchema = lazyZodSchema(() => z.string().check(z.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)));

export const PackagedRuntimeBinaryExecutableRefSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('packaged-runtime-binary'),
  directorySegments: z.readonly(z.array(PackagedRuntimePathSegmentSchema).check(z.minLength(1), z.maxLength(8))),
  executableBaseName: PackagedRuntimePathSegmentSchema,
}));

export const ManagedExecutableRefSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  ...PluginDeclaredExecutableRefSchema._zod.def.options,
  PackagedRuntimeBinaryExecutableRefSchema,
]));
export type ManagedExecutableRef = DeepReadonly<z.infer<typeof ManagedExecutableRefSchema>>;

const PluginAgentAcpTimeoutMsSchema = lazyZodSchema(() => z.number().check(z.int(), z.minimum(1), z.maximum(2_147_483_647)));

export const PluginAgentAcpTimeoutsSchema = lazyZodSchema(() => z.strictObject({
  initializeMs: z.optional(PluginAgentAcpTimeoutMsSchema),
  idleMs: z.optional(PluginAgentAcpTimeoutMsSchema),
}));
export type PluginAgentAcpTimeouts = DeepReadonly<z.infer<typeof PluginAgentAcpTimeoutsSchema>>;

const PluginAgentAcpEnvironmentSchema = lazyZodSchema(() => z.record(
  ProcessStringSchema.check(z.minLength(1), z.refine((value) => value === value.trim(), 'Environment keys cannot have surrounding whitespace')),
  ProcessStringSchema,
));

const HttpHeaderNameSchema = lazyZodSchema(() => z.string().check(z.regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/, 'Invalid HTTP header name')));
const HttpHeaderValueSchema = lazyZodSchema(() => z.string().check(z.refine((value) => !/[\0\r\n]/u.test(value), 'Invalid HTTP header value')));
const PluginAgentAcpHeadersSchema = lazyZodSchema(() => z.record(HttpHeaderNameSchema, HttpHeaderValueSchema));

const PluginAgentAcpWebSocketUrlSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'ws:' || url.protocol === 'wss:';
    } catch {
      return false;
    }
  }, 'ACP WebSocket transport URL must use ws:// or wss://')));

export const PluginAgentAcpTransportSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('stdio'),
    executable: PluginDeclaredExecutableRefSchema,
    preferredPath: z.optional(ProcessStringSchema.check(z.trim(), z.minLength(1))),
    args: z.optional(z.array(ProcessStringSchema)),
    env: z.optional(PluginAgentAcpEnvironmentSchema),
    timeouts: z.optional(PluginAgentAcpTimeoutsSchema),
  }),
  z.strictObject({
    kind: z.literal('webSocket'),
    url: PluginAgentAcpWebSocketUrlSchema,
    headers: z.optional(PluginAgentAcpHeadersSchema),
    timeouts: z.optional(PluginAgentAcpTimeoutsSchema),
  }),
  z.strictObject({
    kind: z.literal('tcp'),
    host: ProcessStringSchema.check(z.trim(), z.minLength(1)),
    port: z.number().check(z.int(), z.minimum(1), z.maximum(65_535)),
    timeouts: z.optional(PluginAgentAcpTimeoutsSchema),
  }),
]));
export type PluginAgentAcpTransport = DeepReadonly<z.infer<typeof PluginAgentAcpTransportSchema>>;
