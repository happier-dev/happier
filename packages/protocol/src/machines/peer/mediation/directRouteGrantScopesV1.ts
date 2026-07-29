import { z } from 'zod';

import { VoiceMediaApplicationKindV1Schema } from './voiceMediaV1.js';

const PositiveIntSchema = z.number().int().positive();

export const BoundedTransferSingleGrantScopeV1Schema = z.object({
  kind: z.literal('bounded_transfer'),
  mode: z.literal('single'),
  transferId: z.string().min(1),
  maxBytes: PositiveIntSchema,
});

export const BoundedTransferScopedGrantScopeV1Schema = z.object({
  kind: z.literal('bounded_transfer'),
  mode: z.literal('scope'),
  transferScopeId: z.string().min(1),
  allowedTransferIdPrefix: z.string().min(1).optional(),
  maxTransfers: PositiveIntSchema,
  maxBytesPerTransfer: PositiveIntSchema,
  maxTotalBytes: PositiveIntSchema,
  maxIdleMs: PositiveIntSchema,
});

export const TcpTunnelGrantScopeV1Schema = z.object({
  kind: z.literal('tcp_tunnel'),
  tunnelId: z.string().min(1),
  allowedPorts: z.array(z.number().int().min(1).max(65_535)).min(1),
  maxIdleMs: PositiveIntSchema,
  maxDurationMs: PositiveIntSchema,
  maxTotalBytes: PositiveIntSchema.optional(),
});

export const VoiceMediaGrantScopeV1Schema = z.object({
  kind: z.literal('voice_media'),
  tunnelId: z.string().min(1),
  applicationKind: VoiceMediaApplicationKindV1Schema,
  applicationAttemptId: z.string().min(1).max(256),
  applicationAuthorityDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  maxIdleMs: PositiveIntSchema,
  maxDurationMs: PositiveIntSchema,
  maxTotalBytes: PositiveIntSchema.optional(),
}).strict();

export const LiveStreamGrantScopeV1Schema = z.object({
  kind: z.literal('live_stream'),
  streamId: z.string().min(1),
  streamFamily: z.string().min(1),
  maxBitrateBps: PositiveIntSchema,
  maxDurationMs: PositiveIntSchema,
  maxTotalBytes: PositiveIntSchema.optional(),
});

export const MachineRpcGrantScopeV1Schema = z.object({
  kind: z.literal('machine_rpc'),
  rpcScopeId: z.string().min(1),
  allowedMethods: z.array(z.string().min(1)).min(1),
  sessionId: z.string().min(1).optional(),
  maxCalls: PositiveIntSchema,
  maxIdleMs: PositiveIntSchema,
  highRiskSingleUseMethods: z.array(z.string().min(1)).optional(),
});

export const DirectRouteGrantScopeV1Schema = z.union([
  BoundedTransferSingleGrantScopeV1Schema,
  BoundedTransferScopedGrantScopeV1Schema,
  TcpTunnelGrantScopeV1Schema,
  VoiceMediaGrantScopeV1Schema,
  LiveStreamGrantScopeV1Schema,
  MachineRpcGrantScopeV1Schema,
]);

export type DirectRouteGrantScopeV1 = z.infer<typeof DirectRouteGrantScopeV1Schema>;
export type BoundedTransferSingleGrantScopeV1 = z.infer<typeof BoundedTransferSingleGrantScopeV1Schema>;
export type BoundedTransferScopedGrantScopeV1 = z.infer<typeof BoundedTransferScopedGrantScopeV1Schema>;
export type TcpTunnelGrantScopeV1 = z.infer<typeof TcpTunnelGrantScopeV1Schema>;
export type VoiceMediaGrantScopeV1 = z.infer<typeof VoiceMediaGrantScopeV1Schema>;
export type LiveStreamGrantScopeV1 = z.infer<typeof LiveStreamGrantScopeV1Schema>;
export type MachineRpcGrantScopeV1 = z.infer<typeof MachineRpcGrantScopeV1Schema>;
