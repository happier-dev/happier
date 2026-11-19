import { z } from '../zodRuntimePolicy.js';
import type { SessionBotV1, SessionBotFaceV1 } from '../sessions/identity/sessionBotV1.js';
import type { ActionExecutorContext } from './executor/types.js';
import type { AdmittedActionInputById } from './actionSpecs.js';
import { SESSION_STATUS_CLEAR_ACTION_ID_V1, SESSION_STATUS_SET_PROGRESS_ACTION_ID_V1 } from './actionIds.js';
import { SessionIdSchema } from '../sessions/idsV1.js';
import { SessionStatusProgressV1Schema, type SessionStatusProgressV1 } from '../sessions/work/state/sessionWorkStatePrimary.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { SessionContextIntentV1Schema, type SessionContextIntentV1 } from '../sessions/context/sessionContextV1.js';
import { PromptDocArtifactRefV1Schema, type PromptDocArtifactRefV1 } from '../prompts/library/promptArtifactRefsV1.js';
import { SessionVoicePreferenceV1Schema, type SessionVoicePreferenceV1 } from '../sessions/instructions/sessionVoicePreferenceV1.js';
import { ApprovalProfileIdV1Schema } from './approvalProfiles.js';

export const SessionTitleSetInputSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.optional(z.string().check(z.minLength(1))),
  title: z.string().check(z.trim(), z.minLength(1)),
}));

/** Source identity is host context, never a caller-selected publication target. */
export const SessionStatusReasonSetInputSchema = lazyZodSchema(() => z.strictObject({
  reason: z.nullable(z.string()),
}));

export const SessionStatusReasonSetResultSchema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true), sessionId: z.string().check(z.minLength(1)), reason: z.nullable(z.string()),
  version: z.number().check(z.int(), z.nonnegative()),
}));

export const SessionStatusProgressSetInputSchema = lazyZodSchema(() => z.strictObject({
  sessionId: z.optional(asProtocolZod(SessionIdSchema)),
  progress: z.nullable(SessionStatusProgressV1Schema),
}));
export const SessionStatusClearInputSchema = lazyZodSchema(() => z.strictObject({
  sessionId: z.optional(asProtocolZod(SessionIdSchema)),
}));
export const SessionStatusProgressSetResultSchema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true),
  sessionId: asProtocolZod(SessionIdSchema),
  progress: z.nullable(SessionStatusProgressV1Schema),
  version: z.number().check(z.int(), z.nonnegative()),
}));

export const SessionToolCallsSetInputSchema = lazyZodSchema(() => z.strictObject({
  sessionId: asProtocolZod(SessionIdSchema),
  showToolCalls: z.nullable(z.boolean()),
}));

const SessionReviewedContextTargetV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: asProtocolZod(SessionIdSchema),
  serverId: z.string().check(z.minLength(1)),
  expectedMetadataRevision: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)),
}));
export const SessionMemorySetInputV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionReviewedContextTargetV1Schema, { enabled: z.boolean() })));
export const SessionApprovalProfileSetInputV1Schema = lazyZodSchema(() => z.extend(SessionReviewedContextTargetV1Schema, { approvalProfileId: z.nullable(ApprovalProfileIdV1Schema) }));
export const SessionVoicePreferenceSetInputV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionReviewedContextTargetV1Schema, { preference: z.nullable(SessionVoicePreferenceV1Schema) })));
export const SessionContextUpdateInputV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionReviewedContextTargetV1Schema, { intent: SessionContextIntentV1Schema })));
export const SessionInstructionsSetInputV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionReviewedContextTargetV1Schema, { ref: z.nullable(PromptDocArtifactRefV1Schema) })));

/** Each Action selects one registered field; the host metadata engine owns its application. */
export const SESSION_STATE_FIELD_ACTIONS = {
  'session.title.set': { fieldId: 'display.title', inputKey: 'title' },
  'session.status.set_reason': { fieldId: 'display.statusReason', inputKey: 'reason' },
  [SESSION_STATUS_SET_PROGRESS_ACTION_ID_V1]: { fieldId: 'display.statusProgress', inputKey: 'progress' },
  [SESSION_STATUS_CLEAR_ACTION_ID_V1]: { fieldId: 'display.statusProgress' },
  'session.bot.set': { fieldId: 'display.bot', inputKey: 'bot' },
  'session.bot.face.set': { fieldId: 'display.botFace', inputKey: 'face' },
  'session.view.toolCalls.set': { fieldId: 'view.transcriptToolCalls', inputKey: 'showToolCalls' },
  'session.memory.set': { fieldId: 'intent.memoryEnabled', inputKey: 'enabled' },
  'session.approval_profile.set': { fieldId: 'intent.approvalProfileId', inputKey: 'approvalProfileId' },
  'session.voice.preference.set': { fieldId: 'intent.voicePreference', inputKey: 'preference' },
  'session.context.update': { fieldId: 'intent.context', inputKey: 'intent' },
  'session.instructions.set': { fieldId: 'intent.context', inputKey: 'ref' },
} as const;

export type SessionStateFieldActionId = keyof typeof SESSION_STATE_FIELD_ACTIONS;
export type SessionStateFieldActionValue =
  | Readonly<{ fieldId: 'display.title'; value: string }>
  | Readonly<{ fieldId: 'display.statusReason'; value: string | null }>
  | Readonly<{ fieldId: 'display.statusProgress'; value: SessionStatusProgressV1 | null | 'clear' }>
  | Readonly<{ fieldId: 'display.bot'; value: SessionBotV1 | null; expectedValue?: SessionBotV1 | null }>
  | Readonly<{ fieldId: 'display.botFace'; value: SessionBotFaceV1 | null }>
  | Readonly<{ fieldId: 'view.transcriptToolCalls'; value: boolean | null }>
  | Readonly<{ fieldId: 'intent.memoryEnabled'; value: boolean; expectedMetadataRevision: number }>
  | Readonly<{ fieldId: 'intent.approvalProfileId'; value: string | null; expectedMetadataRevision: number }>
  | Readonly<{ fieldId: 'intent.voicePreference'; value: SessionVoicePreferenceV1 | null; expectedMetadataRevision: number }>
  | Readonly<{ fieldId: 'intent.context'; value: SessionContextIntentV1; expectedMetadataRevision: number }>;
export type SessionStateFieldActionWrite = Readonly<{
  context: ActionExecutorContext;
  actionId: SessionStateFieldActionId;
  sessionId: string;
  serverId?: string | null;
}> & SessionStateFieldActionValue;

export function isSessionStateFieldActionId(value: string): value is SessionStateFieldActionId {
  return Object.prototype.hasOwnProperty.call(SESSION_STATE_FIELD_ACTIONS, value);
}

/** Existing Instructions Actions and fresh authoring use the same reserved Session entry. */
export function buildSessionInstructionsContextIntentV1(ref: PromptDocArtifactRefV1 | null): SessionContextIntentV1 {
  return ref === null
    ? { kind: 'detach', entryId: 'session.instructions' }
    : SessionContextIntentV1Schema.parse({ kind: 'set', entry: { id: 'session.instructions',
      ref: PromptDocArtifactRefV1Schema.parse(ref), enabled: true, required: true, placement: 'system_append' } });
}

export function resolveSessionStateFieldActionWrite(
  actionId: SessionStateFieldActionId,
  input: AdmittedActionInputById[SessionStateFieldActionId],
): SessionStateFieldActionValue {
  if (actionId === 'session.approval_profile.set') {
    const request = input as AdmittedActionInputById['session.approval_profile.set'];
    return { fieldId: 'intent.approvalProfileId', value: request.approvalProfileId, expectedMetadataRevision: request.expectedMetadataRevision };
  }
  if (actionId === 'session.status.set_reason') {
    return { fieldId: 'display.statusReason', value: (input as AdmittedActionInputById['session.status.set_reason']).reason };
  }
  if (actionId === SESSION_STATUS_SET_PROGRESS_ACTION_ID_V1) {
    return { fieldId: 'display.statusProgress', value: (input as AdmittedActionInputById[typeof SESSION_STATUS_SET_PROGRESS_ACTION_ID_V1]).progress };
  }
  if (actionId === SESSION_STATUS_CLEAR_ACTION_ID_V1) {
    return { fieldId: 'display.statusProgress', value: 'clear' };
  }
  if (actionId === 'session.voice.preference.set') {
    const request = input as AdmittedActionInputById['session.voice.preference.set'];
    return { fieldId: 'intent.voicePreference', value: request.preference, expectedMetadataRevision: request.expectedMetadataRevision };
  }
  if (actionId === 'session.memory.set') {
    const request = input as AdmittedActionInputById['session.memory.set'];
    return { fieldId: 'intent.memoryEnabled', value: request.enabled, expectedMetadataRevision: request.expectedMetadataRevision };
  }
  if (actionId === 'session.context.update') {
    const request = input as AdmittedActionInputById['session.context.update'];
    return { fieldId: 'intent.context', value: request.intent, expectedMetadataRevision: request.expectedMetadataRevision };
  }
  if (actionId === 'session.instructions.set') {
    const request = input as AdmittedActionInputById['session.instructions.set'];
    return { fieldId: 'intent.context', expectedMetadataRevision: request.expectedMetadataRevision,
      value: buildSessionInstructionsContextIntentV1(request.ref) };
  }
  if (actionId === 'session.bot.set') {
    const request = input as AdmittedActionInputById['session.bot.set'];
    return { fieldId: SESSION_STATE_FIELD_ACTIONS[actionId].fieldId, value: request.bot,
      ...(request.expectedBot !== undefined ? { expectedValue: request.expectedBot } : {}) };
  }
  if (actionId === 'session.bot.face.set') {
    return { fieldId: 'display.botFace', value: (input as AdmittedActionInputById['session.bot.face.set']).face };
  }
  if (actionId === 'session.view.toolCalls.set') {
    return { fieldId: SESSION_STATE_FIELD_ACTIONS[actionId].fieldId, value: (input as AdmittedActionInputById['session.view.toolCalls.set']).showToolCalls };
  }
  const title = (input as AdmittedActionInputById['session.title.set']).title;
  return { fieldId: SESSION_STATE_FIELD_ACTIONS[actionId].fieldId, value: title };
}
