import { z } from 'zod';

import {
  ExecutionRunIdSchema,
  SessionIdSchema,
  SidechainIdSchema,
  SubagentIdSchema,
} from '../idsV1.js';
import { SubagentGroupRefV1Schema } from './subagentGroupRefV1.js';

export const SubagentKindV1Schema = z.enum(['execution-run', 'native', 'custom']);
export type SubagentKindV1 = z.infer<typeof SubagentKindV1Schema>;

export const SubagentOriginV1Schema = z.enum(['happier', 'provider', 'plugin']);
export type SubagentOriginV1 = z.infer<typeof SubagentOriginV1Schema>;

export const SubagentStatusV1Schema = z.enum(['pending', 'running', 'completed', 'failed', 'aborted']);
export type SubagentStatusV1 = z.infer<typeof SubagentStatusV1Schema>;

export const SubagentLifecycleDetailV1Schema = z.object({
  providerState: z.string().optional(),
  reason: z.string().optional(),
}).passthrough();
export type SubagentLifecycleDetailV1 = z.infer<typeof SubagentLifecycleDetailV1Schema>;

export const SubagentProviderRefV1Schema = z.object({
  providerId: z.string().trim().min(1),
  providerKind: z.string().trim().min(1).optional(),
}).passthrough();
export type SubagentProviderRefV1 = z.infer<typeof SubagentProviderRefV1Schema>;

export const SubagentTranscriptBindingV1Schema = z.object({
  parentSessionId: SessionIdSchema,
  sidechainId: SidechainIdSchema,
}).passthrough();
export type SubagentTranscriptBindingV1 = z.infer<typeof SubagentTranscriptBindingV1Schema>;

export const SubagentSpawnRefV1Schema = z.object({
  toolCallId: z.string().trim().min(1).optional(),
}).passthrough();
export type SubagentSpawnRefV1 = z.infer<typeof SubagentSpawnRefV1Schema>;

export const SubagentDisplayV1Schema = z.object({
  label: z.string().optional(),
  iconRef: z.string().optional(),
  colorToken: z.string().optional(),
}).passthrough();
export type SubagentDisplayV1 = z.infer<typeof SubagentDisplayV1Schema>;

export const VendorSessionRefV1Schema = z.object({
  providerSessionId: z.string().trim().min(1),
  vendorSource: z.string().trim().min(1).optional(),
  resumeMetadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();
export type VendorSessionRefV1 = z.infer<typeof VendorSessionRefV1Schema>;

const SubagentRunRefV1Schema = z.object({
  runId: ExecutionRunIdSchema,
}).passthrough();

const SubagentRefV1BaseSchema = z.object({
  id: SubagentIdSchema,
  parentSessionId: SessionIdSchema,
  origin: SubagentOriginV1Schema,
  kind: SubagentKindV1Schema,
  providerRef: SubagentProviderRefV1Schema.optional(),
  status: SubagentStatusV1Schema,
  lifecycleDetail: SubagentLifecycleDetailV1Schema.optional(),
  createdAt: z.number().int().nonnegative(),
  completedAt: z.number().int().nonnegative().optional(),
  transcript: SubagentTranscriptBindingV1Schema.optional(),
  spawnRef: SubagentSpawnRefV1Schema.optional(),
  runRef: SubagentRunRefV1Schema.optional(),
  groupRef: SubagentGroupRefV1Schema.optional(),
  vendorRef: VendorSessionRefV1Schema.optional(),
  label: z.string().optional(),
  display: SubagentDisplayV1Schema.optional(),
  providerMetadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

function refineSubagentRefRunInvariant(
  value: { origin?: unknown; kind?: unknown; runRef?: unknown },
  ctx: z.RefinementCtx,
) {
  if (value.origin === 'happier' && value.kind === 'execution-run' && !value.runRef) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['runRef'],
      message: 'runRef is required for happier execution-run subagents',
    });
  }
}

export const SubagentRefV1Schema = SubagentRefV1BaseSchema.superRefine(refineSubagentRefRunInvariant);
export type SubagentRefV1 = z.infer<typeof SubagentRefV1Schema>;

export const SubagentRefInputV1Schema = SubagentRefV1BaseSchema
  .omit({ status: true, createdAt: true })
  .extend({
    status: SubagentStatusV1Schema.optional(),
    createdAt: z.number().int().nonnegative().optional(),
  })
  .superRefine(refineSubagentRefRunInvariant);
export type SubagentRefInputV1 = z.infer<typeof SubagentRefInputV1Schema>;
