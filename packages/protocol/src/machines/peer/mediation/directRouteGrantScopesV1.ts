import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { VoiceMediaApplicationKindV1Schema } from './voiceMediaV1.js';
import { LocalServicePreviewDirectBindingV1Schema } from '../../../local/services/preview/v1.js';
import { MachineDeploymentServiceIdentityV1Schema } from '../../../local/services/serviceIdentityV1.js';
import { LocalServiceLoopbackHostV1Schema } from '../../../local/services/hosts.js';
import { computeSha256HexDigest } from '../../../crypto/canonicalDigest.js';
import { createCanonicalJsonSigningInput } from '../../../crypto/canonicalJson.js';

const PositiveIntSchema = lazyZodSchema(() => z.number().check(z.int(), z.positive()));

export const BoundedTransferSingleGrantScopeV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('bounded_transfer'),
  mode: z.literal('single'),
  transferId: z.string().check(z.minLength(1)),
  maxBytes: PositiveIntSchema,
}));

export const BoundedTransferScopedGrantScopeV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('bounded_transfer'),
  mode: z.literal('scope'),
  transferScopeId: z.string().check(z.minLength(1)),
  allowedTransferIdPrefix: z.optional(z.string().check(z.minLength(1))),
  maxTransfers: PositiveIntSchema,
  maxBytesPerTransfer: PositiveIntSchema,
  maxTotalBytes: PositiveIntSchema,
  maxIdleMs: PositiveIntSchema,
}));

/** Exact export selected by the managed-service owner, verified by B at open. */
export const TcpTunnelServiceExportBindingV1Schema = lazyZodSchema(() => z.strictObject({
  exportKey: z.string().check(z.minLength(1)),
  service: MachineDeploymentServiceIdentityV1Schema,
  installationId: z.string().check(z.minLength(1)),
  deploymentId: z.string().check(z.minLength(1)),
  generation: z.string().check(z.minLength(1)),
  destination: z.strictObject({
    host: LocalServiceLoopbackHostV1Schema,
    port: z.number().check(z.int(), z.minimum(1), z.maximum(65_535)),
  }),
}));
export type TcpTunnelServiceExportBindingV1 = z.infer<typeof TcpTunnelServiceExportBindingV1Schema>;

/** A's 256-bit random nonce travels only inside the encrypted Iroh open. */
export const TcpTunnelServiceExportOpeningV1Schema = lazyZodSchema(() => z.strictObject({
  binding: TcpTunnelServiceExportBindingV1Schema,
  nonce: z.string().check(z.regex(/^[0-9a-f]{64}$/u)),
}));

/** Commit to the exact occurrence without revealing guessable service names to Home. */
export function createTcpTunnelServiceExportCommitmentV1(binding: TcpTunnelServiceExportBindingV1, nonce: string): string {
  return `sha256:${computeSha256HexDigest(nonce + createCanonicalJsonSigningInput(binding))}`;
}

export const TcpTunnelGrantScopeV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('tcp_tunnel'),
  tunnelId: z.string().check(z.minLength(1)),
  allowedPorts: z.array(z.number().check(z.int(), z.minimum(1), z.maximum(65_535))).check(z.minLength(1)),
  preview: z.optional(LocalServicePreviewDirectBindingV1Schema),
  serviceExport: z.optional(z.strictObject({
    commitment: z.string().check(z.regex(/^sha256:[0-9a-f]{64}$/u)),
  })),
}).check(z.superRefine((scope, ctx) => {
  if (scope.serviceExport && (scope.preview || scope.allowedPorts.length !== 1)) {
    ctx.addIssue({ code: 'custom', path: ['serviceExport'], message: 'A service export grants only its exact destination and cannot carry preview authority.' });
  }
})));

export const VoiceMediaGrantScopeV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('voice_media'),
  tunnelId: z.string().check(z.minLength(1)),
  applicationKind: VoiceMediaApplicationKindV1Schema,
  applicationAttemptId: z.string().check(z.minLength(1), z.maxLength(256)),
  applicationAuthorityDigest: z.string().check(z.regex(/^sha256:[0-9a-f]{64}$/u)),
  maxIdleMs: z.optional(PositiveIntSchema),
  maxDurationMs: z.optional(PositiveIntSchema),
  maxTotalBytes: z.optional(PositiveIntSchema),
}));

export const LiveStreamGrantScopeV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('live_stream'),
  streamId: z.string().check(z.minLength(1)),
  streamFamily: z.string().check(z.minLength(1)),
  sourceId: z.optional(z.string().check(z.minLength(1))),
  maxBitrateBps: z.optional(PositiveIntSchema),
  maxDurationMs: z.optional(PositiveIntSchema),
  maxTotalBytes: z.optional(PositiveIntSchema),
}));

export const MachineRpcGrantScopeV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('machine_rpc'),
  rpcScopeId: z.string().check(z.minLength(1)),
  allowedMethods: z.array(z.string().check(z.minLength(1))).check(z.minLength(1)),
  sessionId: z.optional(z.string().check(z.minLength(1))),
  maxCalls: PositiveIntSchema,
  maxIdleMs: PositiveIntSchema,
  highRiskSingleUseMethods: z.optional(z.array(z.string().check(z.minLength(1)))),
}));

export const DirectRouteGrantScopeV1Schema = lazyZodSchema(() => z.union([
  BoundedTransferSingleGrantScopeV1Schema,
  BoundedTransferScopedGrantScopeV1Schema,
  TcpTunnelGrantScopeV1Schema,
  VoiceMediaGrantScopeV1Schema,
  LiveStreamGrantScopeV1Schema,
  MachineRpcGrantScopeV1Schema,
]));

export type DirectRouteGrantScopeV1 = z.infer<typeof DirectRouteGrantScopeV1Schema>;
export type BoundedTransferSingleGrantScopeV1 = z.infer<typeof BoundedTransferSingleGrantScopeV1Schema>;
export type BoundedTransferScopedGrantScopeV1 = z.infer<typeof BoundedTransferScopedGrantScopeV1Schema>;
export type TcpTunnelGrantScopeV1 = z.infer<typeof TcpTunnelGrantScopeV1Schema>;
export type VoiceMediaGrantScopeV1 = z.infer<typeof VoiceMediaGrantScopeV1Schema>;
export type LiveStreamGrantScopeV1 = z.infer<typeof LiveStreamGrantScopeV1Schema>;
export type MachineRpcGrantScopeV1 = z.infer<typeof MachineRpcGrantScopeV1Schema>;
