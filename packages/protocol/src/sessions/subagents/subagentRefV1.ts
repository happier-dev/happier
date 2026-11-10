import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import {
  ExecutionRunIdSchema,
  SessionIdSchema,
  SidechainIdSchema,
  SubagentIdSchema,
} from '../idsV1.js';
import { SubagentGroupRefV1Schema } from './subagentGroupRefV1.js';
import { asProtocolZod } from "../../plugins/actions/internalProtocolZodAdapter.js";
import { NonBlankOpaqueIdentifierSchema } from '../../strings/opaqueIdentifier.js';

export const SubagentKindV1Schema = lazyZodSchema(() => z.enum(['execution-run', 'native', 'custom']));
export type SubagentKindV1 = z.infer<typeof SubagentKindV1Schema>;

export const SubagentOriginV1Schema = lazyZodSchema(() => z.enum(['happier', 'agent', 'plugin']));
export type SubagentOriginV1 = z.infer<typeof SubagentOriginV1Schema>;

export const SubagentStatusV1Schema = lazyZodSchema(() => z.enum(['pending', 'running', 'completed', 'failed', 'aborted']));
export type SubagentStatusV1 = z.infer<typeof SubagentStatusV1Schema>;

export const SubagentLifecycleDetailV1Schema = lazyZodSchema(() => z.looseObject({
  agentState: z.optional(z.string()),
  reason: z.optional(z.string()),
}));
export type SubagentLifecycleDetailV1 = z.infer<typeof SubagentLifecycleDetailV1Schema>;

export const SubagentAgentRefV1Schema = lazyZodSchema(() => z.looseObject({
  agentId: z.string().check(z.trim(), z.minLength(1)),
  agentKind: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));
export type SubagentAgentRefV1 = z.infer<typeof SubagentAgentRefV1Schema>;

export const SubagentTranscriptBindingV1Schema = lazyZodSchema(() => z.looseObject({
  parentSessionId: asProtocolZod(SessionIdSchema),
  sidechainId: SidechainIdSchema,
}));
export type SubagentTranscriptBindingV1 = z.infer<typeof SubagentTranscriptBindingV1Schema>;

export const SubagentSpawnRefV1Schema = lazyZodSchema(() => z.looseObject({
  toolCallId: z.optional(z.string().check(z.minLength(1), z.refine((value) => value.trim().length > 0, 'toolCallId must not be blank'))),
}));
export type SubagentSpawnRefV1 = z.infer<typeof SubagentSpawnRefV1Schema>;

export const SubagentDisplayV1Schema = lazyZodSchema(() => z.looseObject({
  label: z.optional(z.string()),
  iconRef: z.optional(z.string()),
  colorToken: z.optional(z.string()),
}));
export type SubagentDisplayV1 = z.infer<typeof SubagentDisplayV1Schema>;

export const VendorSessionRefV1Schema = lazyZodSchema(() => z.looseObject({
  agentSessionId: NonBlankOpaqueIdentifierSchema,
  vendorSource: z.optional(z.string().check(z.trim(), z.minLength(1))),
  resumeMetadata: z.optional(z.record(z.string(), z.unknown())),
}));
export type VendorSessionRefV1 = z.infer<typeof VendorSessionRefV1Schema>;

const SubagentRunRefV1Schema = lazyZodSchema(() => z.looseObject({
  runId: ExecutionRunIdSchema,
}));

const SubagentRefV1BaseSchema = lazyZodSchema(() => z.looseObject({
  id: SubagentIdSchema,
  parentSessionId: asProtocolZod(SessionIdSchema),
  origin: SubagentOriginV1Schema,
  kind: SubagentKindV1Schema,
  agentRef: z.optional(SubagentAgentRefV1Schema),
  status: SubagentStatusV1Schema,
  lifecycleDetail: z.optional(SubagentLifecycleDetailV1Schema),
  createdAt: z.number().check(z.int(), z.nonnegative()),
  completedAt: z.optional(z.number().check(z.int(), z.nonnegative())),
  transcript: z.optional(SubagentTranscriptBindingV1Schema),
  spawnRef: z.optional(SubagentSpawnRefV1Schema),
  runRef: z.optional(SubagentRunRefV1Schema),
  groupRef: z.optional(SubagentGroupRefV1Schema),
  vendorRef: z.optional(VendorSessionRefV1Schema),
  label: z.optional(z.string()),
  display: z.optional(SubagentDisplayV1Schema),
  agentMetadata: z.optional(z.record(z.string(), z.unknown())),
}));

function refineSubagentRefRunInvariant(
  value: { origin?: unknown; kind?: unknown; runRef?: unknown },
  ctx: z.core.$RefinementCtx,
) {
  if (value.origin === 'happier' && value.kind === 'execution-run' && !value.runRef) {
    ctx.addIssue({
      code: "custom",
      path: ['runRef'],
      message: 'runRef is required for happier execution-run subagents',
    });
  }
}

export const SubagentRefV1Schema = lazyZodSchema(() => SubagentRefV1BaseSchema.check(z.superRefine(refineSubagentRefRunInvariant)));
export type SubagentRefV1 = z.infer<typeof SubagentRefV1Schema>;

export const SubagentRefInputV1Schema = lazyZodSchema(() => z.extend(z.omit(SubagentRefV1BaseSchema, { status: true, createdAt: true }), {
    status: z.optional(SubagentStatusV1Schema),
    createdAt: z.optional(z.number().check(z.int(), z.nonnegative())),
  }).check(z.superRefine(refineSubagentRefRunInvariant)));
export type SubagentRefInputV1 = z.infer<typeof SubagentRefInputV1Schema>;
