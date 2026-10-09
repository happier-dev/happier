import { z } from 'zod';
import { BotSetInputSchema, type SessionBotV1 } from '../sessions/identity/sessionBotV1.js';
import type { ActionExecutorContext } from './executor/types.js';
import { SessionIdSchema } from '../sessions/idsV1.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { SessionContextIntentV1Schema, type SessionContextIntentV1 } from '../sessions/context/sessionContextV1.js';
import { PromptDocArtifactRefV1Schema, type PromptDocArtifactRefV1 } from '../prompts/library/promptArtifactRefsV1.js';
import { SessionVoicePreferenceV1Schema, type SessionVoicePreferenceV1 } from '../sessions/instructions/sessionVoicePreferenceV1.js';

export const SessionTitleSetInputSchema = lazyZodSchema(() => z.object({
  sessionId: z.string().min(1).optional(),
  title: z.string().trim().min(1),
}).passthrough());

export const SessionToolCallsSetInputSchema = lazyZodSchema(() => z.object({
  sessionId: asProtocolZod(SessionIdSchema),
  showToolCalls: z.boolean().nullable(),
}).strict());

const SessionReviewedContextTargetV1Schema = lazyZodSchema(() => z.object({
  sessionId: asProtocolZod(SessionIdSchema),
  serverId: z.string().min(1),
  expectedMetadataRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict());
export const SessionMemorySetInputV1Schema = lazyZodSchema(() => SessionReviewedContextTargetV1Schema.extend({ enabled: z.boolean() }).strict());
export const SessionVoicePreferenceSetInputV1Schema = lazyZodSchema(() => SessionReviewedContextTargetV1Schema.extend({ preference: SessionVoicePreferenceV1Schema.nullable() }).strict());
export const SessionContextUpdateInputV1Schema = lazyZodSchema(() => SessionReviewedContextTargetV1Schema.extend({ intent: SessionContextIntentV1Schema }).strict());
export const SessionInstructionsSetInputV1Schema = lazyZodSchema(() => SessionReviewedContextTargetV1Schema.extend({ ref: PromptDocArtifactRefV1Schema.strict().nullable() }).strict());

/** Each Action selects one registered field; the host metadata engine owns its application. */
export const SESSION_STATE_FIELD_ACTIONS = {
  'session.title.set': { fieldId: 'display.title', inputKey: 'title' },
  'session.bot.set': { fieldId: 'display.bot', inputKey: 'bot' },
  'session.view.toolCalls.set': { fieldId: 'view.transcriptToolCalls', inputKey: 'showToolCalls' },
  'session.memory.set': { fieldId: 'intent.memoryEnabled', inputKey: 'enabled' },
  'session.voice.preference.set': { fieldId: 'intent.voicePreference', inputKey: 'preference' },
  'session.context.update': { fieldId: 'intent.context', inputKey: 'intent' },
  'session.instructions.set': { fieldId: 'intent.context', inputKey: 'ref' },
} as const;

export type SessionStateFieldActionId = keyof typeof SESSION_STATE_FIELD_ACTIONS;
export type SessionStateFieldActionValue =
  | Readonly<{ fieldId: 'display.title'; value: string }>
  | Readonly<{ fieldId: 'display.bot'; value: SessionBotV1 | null }>
  | Readonly<{ fieldId: 'view.transcriptToolCalls'; value: boolean | null }>
  | Readonly<{ fieldId: 'intent.memoryEnabled'; value: boolean; expectedMetadataRevision: number }>
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
      ref: PromptDocArtifactRefV1Schema.strict().parse(ref), enabled: true, required: true, placement: 'system_append' } });
}

export function resolveSessionStateFieldActionWrite(
  actionId: SessionStateFieldActionId,
  input: unknown,
): SessionStateFieldActionValue {
  if (actionId === 'session.voice.preference.set') {
    const request = SessionVoicePreferenceSetInputV1Schema.parse(input);
    return { fieldId: 'intent.voicePreference', value: request.preference, expectedMetadataRevision: request.expectedMetadataRevision };
  }
  if (actionId === 'session.memory.set') {
    const request = SessionMemorySetInputV1Schema.parse(input);
    return { fieldId: 'intent.memoryEnabled', value: request.enabled, expectedMetadataRevision: request.expectedMetadataRevision };
  }
  if (actionId === 'session.context.update') {
    const request = SessionContextUpdateInputV1Schema.parse(input);
    return { fieldId: 'intent.context', value: request.intent, expectedMetadataRevision: request.expectedMetadataRevision };
  }
  if (actionId === 'session.instructions.set') {
    const request = SessionInstructionsSetInputV1Schema.parse(input);
    return { fieldId: 'intent.context', expectedMetadataRevision: request.expectedMetadataRevision,
      value: buildSessionInstructionsContextIntentV1(request.ref) };
  }
  if (actionId === 'session.bot.set') {
    return { fieldId: SESSION_STATE_FIELD_ACTIONS[actionId].fieldId, value: BotSetInputSchema.parse(input).bot };
  }
  if (actionId === 'session.view.toolCalls.set') {
    return { fieldId: SESSION_STATE_FIELD_ACTIONS[actionId].fieldId, value: SessionToolCallsSetInputSchema.parse(input).showToolCalls };
  }
  const title = SessionTitleSetInputSchema.parse(input).title;
  return { fieldId: SESSION_STATE_FIELD_ACTIONS[actionId].fieldId, value: title };
}
