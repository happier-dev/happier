import { z } from 'zod';

export const VOICE_MEDIATOR_ERROR_CODES = {
  NOT_FOUND: 'VOICE_MEDIATOR_NOT_FOUND',
  BUSY: 'VOICE_MEDIATOR_BUSY',
  UNSUPPORTED: 'VOICE_MEDIATOR_UNSUPPORTED',
  START_FAILED: 'VOICE_MEDIATOR_START_FAILED',
} as const;

export type VoiceMediatorErrorCode =
  (typeof VOICE_MEDIATOR_ERROR_CODES)[keyof typeof VOICE_MEDIATOR_ERROR_CODES];

export const VoiceMediatorPermissionPolicySchema = z.enum(['no_tools', 'read_only']);
export type VoiceMediatorPermissionPolicy = z.infer<typeof VoiceMediatorPermissionPolicySchema>;

export const VoiceMediatorAgentSourceSchema = z.enum(['session', 'agent']);
export type VoiceMediatorAgentSource = z.infer<typeof VoiceMediatorAgentSourceSchema>;

export const VoiceMediatorVerbositySchema = z.enum(['short', 'balanced']);
export type VoiceMediatorVerbosity = z.infer<typeof VoiceMediatorVerbositySchema>;

export const VoiceMediatorStartRequestSchema = z.object({
  agentSource: VoiceMediatorAgentSourceSchema.optional(),
  agentId: z.string().optional(),
  verbosity: VoiceMediatorVerbositySchema.optional(),
  chatModelId: z.string(),
  commitModelId: z.string(),
  permissionPolicy: VoiceMediatorPermissionPolicySchema,
  idleTtlSeconds: z.number(),
  initialContext: z.string(),
});
export type VoiceMediatorStartRequest = z.infer<typeof VoiceMediatorStartRequestSchema>;

export const VoiceMediatorStartResponseSchema = z.object({
  mediatorId: z.string(),
  effective: z.object({
    chatModelId: z.string(),
    commitModelId: z.string(),
    permissionPolicy: VoiceMediatorPermissionPolicySchema,
  }),
});
export type VoiceMediatorStartResponse = z.infer<typeof VoiceMediatorStartResponseSchema>;

export const VoiceMediatorSendTurnRequestSchema = z.object({
  mediatorId: z.string(),
  userText: z.string(),
});
export type VoiceMediatorSendTurnRequest = z.infer<typeof VoiceMediatorSendTurnRequestSchema>;

export const VoiceMediatorSendTurnResponseSchema = z.object({
  assistantText: z.string(),
});
export type VoiceMediatorSendTurnResponse = z.infer<typeof VoiceMediatorSendTurnResponseSchema>;

export const VoiceMediatorCommitRequestSchema = z.object({
  mediatorId: z.string(),
  kind: z.literal('session_instruction'),
  constraints: z
    .object({
      maxChars: z.number().optional(),
    })
    .optional(),
});
export type VoiceMediatorCommitRequest = z.infer<typeof VoiceMediatorCommitRequestSchema>;

export const VoiceMediatorCommitResponseSchema = z.object({
  commitText: z.string(),
});
export type VoiceMediatorCommitResponse = z.infer<typeof VoiceMediatorCommitResponseSchema>;

export const VoiceMediatorStopRequestSchema = z.object({
  mediatorId: z.string(),
});
export type VoiceMediatorStopRequest = z.infer<typeof VoiceMediatorStopRequestSchema>;

export const VoiceMediatorStopResponseSchema = z.object({
  ok: z.literal(true),
});
export type VoiceMediatorStopResponse = z.infer<typeof VoiceMediatorStopResponseSchema>;

export const VoiceMediatorGetModelsRequestSchema = z.object({});
export type VoiceMediatorGetModelsRequest = z.infer<typeof VoiceMediatorGetModelsRequestSchema>;

export const VoiceMediatorModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
});
export type VoiceMediatorModel = z.infer<typeof VoiceMediatorModelSchema>;

export const VoiceMediatorGetModelsResponseSchema = z.object({
  provider: z.string().optional(),
  availableModels: z.array(VoiceMediatorModelSchema),
  supportsFreeform: z.boolean(),
});
export type VoiceMediatorGetModelsResponse = z.infer<typeof VoiceMediatorGetModelsResponseSchema>;
