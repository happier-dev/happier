import { z } from 'zod';
import { VoiceAssistantActionSchema } from './voiceActions.js';

export const VOICE_AGENT_ERROR_CODES = {
  NOT_FOUND: 'VOICE_AGENT_NOT_FOUND',
  BUSY: 'VOICE_AGENT_BUSY',
  UNSUPPORTED: 'VOICE_AGENT_UNSUPPORTED',
  START_FAILED: 'VOICE_AGENT_START_FAILED',
} as const;

export type VoiceAgentErrorCode =
  (typeof VOICE_AGENT_ERROR_CODES)[keyof typeof VOICE_AGENT_ERROR_CODES];

export const VoiceAgentPermissionPolicySchema = z.enum(['no_tools', 'read_only']);
export type VoiceAgentPermissionPolicy = z.infer<typeof VoiceAgentPermissionPolicySchema>;

export const VoiceAgentAgentSourceSchema = z.enum(['session', 'agent']);
export type VoiceAgentAgentSource = z.infer<typeof VoiceAgentAgentSourceSchema>;

export const VoiceAgentVerbositySchema = z.enum(['short', 'balanced']);
export type VoiceAgentVerbosity = z.infer<typeof VoiceAgentVerbositySchema>;

export const VoiceAgentTranscriptPersistenceModeSchema = z.enum(['ephemeral', 'persistent']);
export type VoiceAgentTranscriptPersistenceMode = z.infer<typeof VoiceAgentTranscriptPersistenceModeSchema>;

export const VoiceAgentTranscriptConfigSchema = z.object({
  persistenceMode: VoiceAgentTranscriptPersistenceModeSchema.optional(),
  epoch: z.number().int().min(0).optional(),
});
export type VoiceAgentTranscriptConfig = z.infer<typeof VoiceAgentTranscriptConfigSchema>;

export const VoiceAgentStartRequestSchema = z.object({
  agentSource: VoiceAgentAgentSourceSchema.optional(),
  agentId: z.string().optional(),
  verbosity: VoiceAgentVerbositySchema.optional(),
  chatModelId: z.string(),
  commitModelId: z.string(),
  permissionPolicy: VoiceAgentPermissionPolicySchema,
  idleTtlSeconds: z.number(),
  initialContext: z.string(),
  transcript: VoiceAgentTranscriptConfigSchema.optional(),
});
export type VoiceAgentStartRequest = z.infer<typeof VoiceAgentStartRequestSchema>;

export const VoiceAgentStartResponseSchema = z.object({
  voiceAgentId: z.string(),
  effective: z.object({
    chatModelId: z.string(),
    commitModelId: z.string(),
    permissionPolicy: VoiceAgentPermissionPolicySchema,
  }),
});
export type VoiceAgentStartResponse = z.infer<typeof VoiceAgentStartResponseSchema>;

export const VoiceAgentSendTurnRequestSchema = z.object({
  voiceAgentId: z.string(),
  userText: z.string(),
});
export type VoiceAgentSendTurnRequest = z.infer<typeof VoiceAgentSendTurnRequestSchema>;

export const VoiceAgentSendTurnResponseSchema = z.object({
  assistantText: z.string(),
  actions: z.array(VoiceAssistantActionSchema).optional(),
});
export type VoiceAgentSendTurnResponse = z.infer<typeof VoiceAgentSendTurnResponseSchema>;

export const VoiceAgentTurnStreamStartRequestSchema = z.object({
  voiceAgentId: z.string(),
  userText: z.string(),
});
export type VoiceAgentTurnStreamStartRequest = z.infer<typeof VoiceAgentTurnStreamStartRequestSchema>;

export const VoiceAgentTurnStreamStartResponseSchema = z.object({
  streamId: z.string(),
});
export type VoiceAgentTurnStreamStartResponse = z.infer<typeof VoiceAgentTurnStreamStartResponseSchema>;

export const VoiceAgentTurnStreamReadRequestSchema = z.object({
  voiceAgentId: z.string(),
  streamId: z.string(),
  cursor: z.number().int().min(0),
  maxEvents: z.number().int().min(1).max(128).optional(),
});
export type VoiceAgentTurnStreamReadRequest = z.infer<typeof VoiceAgentTurnStreamReadRequestSchema>;

export const VoiceAgentTurnStreamEventDeltaSchema = z.object({
  t: z.literal('delta'),
  textDelta: z.string(),
});
export type VoiceAgentTurnStreamEventDelta = z.infer<typeof VoiceAgentTurnStreamEventDeltaSchema>;

export const VoiceAgentTurnStreamEventDoneSchema = z.object({
  t: z.literal('done'),
  assistantText: z.string(),
  actions: z.array(VoiceAssistantActionSchema).optional(),
});
export type VoiceAgentTurnStreamEventDone = z.infer<typeof VoiceAgentTurnStreamEventDoneSchema>;

export const VoiceAgentTurnStreamEventErrorSchema = z.object({
  t: z.literal('error'),
  error: z.string(),
  errorCode: z.string().optional(),
});
export type VoiceAgentTurnStreamEventError = z.infer<typeof VoiceAgentTurnStreamEventErrorSchema>;

export const VoiceAgentTurnStreamEventSchema = z.discriminatedUnion('t', [
  VoiceAgentTurnStreamEventDeltaSchema,
  VoiceAgentTurnStreamEventDoneSchema,
  VoiceAgentTurnStreamEventErrorSchema,
]);
export type VoiceAgentTurnStreamEvent = z.infer<typeof VoiceAgentTurnStreamEventSchema>;

export const VoiceAgentTurnStreamReadResponseSchema = z.object({
  streamId: z.string(),
  events: z.array(VoiceAgentTurnStreamEventSchema),
  nextCursor: z.number().int().min(0),
  done: z.boolean(),
});
export type VoiceAgentTurnStreamReadResponse = z.infer<typeof VoiceAgentTurnStreamReadResponseSchema>;

export const VoiceAgentTurnStreamCancelRequestSchema = z.object({
  voiceAgentId: z.string(),
  streamId: z.string(),
});
export type VoiceAgentTurnStreamCancelRequest = z.infer<typeof VoiceAgentTurnStreamCancelRequestSchema>;

export const VoiceAgentTurnStreamCancelResponseSchema = z.object({
  ok: z.literal(true),
});
export type VoiceAgentTurnStreamCancelResponse = z.infer<typeof VoiceAgentTurnStreamCancelResponseSchema>;

export const VoiceAgentCommitRequestSchema = z.object({
  voiceAgentId: z.string(),
  kind: z.literal('session_instruction'),
  constraints: z
    .object({
      maxChars: z.number().optional(),
    })
    .optional(),
});
export type VoiceAgentCommitRequest = z.infer<typeof VoiceAgentCommitRequestSchema>;

export const VoiceAgentCommitResponseSchema = z.object({
  commitText: z.string(),
});
export type VoiceAgentCommitResponse = z.infer<typeof VoiceAgentCommitResponseSchema>;

export const VoiceAgentStopRequestSchema = z.object({
  voiceAgentId: z.string(),
});
export type VoiceAgentStopRequest = z.infer<typeof VoiceAgentStopRequestSchema>;

export const VoiceAgentStopResponseSchema = z.object({
  ok: z.literal(true),
});
export type VoiceAgentStopResponse = z.infer<typeof VoiceAgentStopResponseSchema>;

export const VoiceAgentGetModelsRequestSchema = z.object({});
export type VoiceAgentGetModelsRequest = z.infer<typeof VoiceAgentGetModelsRequestSchema>;

export const VoiceAgentModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
});
export type VoiceAgentModel = z.infer<typeof VoiceAgentModelSchema>;

export const VoiceAgentGetModelsResponseSchema = z.object({
  provider: z.string().optional(),
  availableModels: z.array(VoiceAgentModelSchema),
  supportsFreeform: z.boolean(),
});
export type VoiceAgentGetModelsResponse = z.infer<typeof VoiceAgentGetModelsResponseSchema>;

