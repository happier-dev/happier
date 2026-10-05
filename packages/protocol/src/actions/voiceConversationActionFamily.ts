import { z } from 'zod';
import type { PreNormalizedActionSpec } from './actionSpecs.js';

export const VOICE_CONVERSATION_ACTION_IDS = [
  'ui.voice_global.get', 'ui.voice_global.start', 'ui.voice_global.end', 'ui.voice_global.set_muted',
  'ui.voice_global.recover', 'ui.voice_global.dismiss', 'ui.voice_global.turn_control',
  'ui.voice_global.hold_begin', 'ui.voice_global.hold_release', 'ui.voice_global.hold_cancel',
  'ui.voice_global.brief.request', 'ui.voice_global.brief.retry', 'ui.voice_global.brief.stop',
] as const;
export type VoiceConversationActionId = typeof VOICE_CONVERSATION_ACTION_IDS[number];
export function isVoiceConversationActionId(value: string): value is VoiceConversationActionId {
  return (VOICE_CONVERSATION_ACTION_IDS as readonly string[]).includes(value);
}

const IdSchema = z.string().trim().min(1);
const AddressSchema = z.object({ serverId: IdSchema, sessionId: IdSchema }).strict();
export const VoiceConversationTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('global') }).strict(),
  z.object({ kind: z.literal('session'), sessionAddress: AddressSchema.nullable() }).strict(),
  z.object({ kind: z.literal('default') }).strict(),
]);
const AttemptInputSchema = z.object({ expectedAttempt: IdSchema }).strict();
const BriefInputSchema = z.object({ expectedAttemptId: IdSchema.optional() }).strict();
export const VoiceConversationActionInputSchemas = {
  'ui.voice_global.get': z.object({ target: VoiceConversationTargetSchema.optional() }).strict(),
  'ui.voice_global.start': z.object({ target: VoiceConversationTargetSchema, expectedAttempt: z.null() }).strict(),
  'ui.voice_global.end': AttemptInputSchema,
  'ui.voice_global.set_muted': AttemptInputSchema.extend({ muted: z.boolean() }).strict(),
  'ui.voice_global.recover': AttemptInputSchema,
  'ui.voice_global.dismiss': AttemptInputSchema.extend({ kind: z.enum(['failed', 'ended']) }).strict(),
  'ui.voice_global.turn_control': AttemptInputSchema.extend({ control: z.enum(['commit_input', 'interrupt', 'cancel']) }).strict(),
  'ui.voice_global.hold_begin': AttemptInputSchema,
  'ui.voice_global.hold_release': AttemptInputSchema,
  'ui.voice_global.hold_cancel': AttemptInputSchema,
  'ui.voice_global.brief.request': BriefInputSchema,
  'ui.voice_global.brief.retry': BriefInputSchema,
  'ui.voice_global.brief.stop': BriefInputSchema,
} as const;

export const VoiceConversationStatusSchema = z.object({
  attemptId: IdSchema.nullable(), adapterId: IdSchema.nullable(), sessionId: IdSchema.nullable(),
  status: z.enum(['disconnected', 'connecting', 'connected', 'error']),
  mode: z.enum(['idle', 'listening', 'transcribing', 'thinking', 'speaking']),
  target: VoiceConversationTargetSchema,
  conversationSessionAddress: AddressSchema.nullable(), targetSessionAddress: AddressSchema.nullable(),
  canStart: z.boolean(), canStop: z.boolean(), canMute: z.boolean(), canCommitInput: z.boolean(),
  canHoldToTalk: z.boolean(), muted: z.boolean(), canDismissFailedAttempt: z.boolean(), canDismissEnded: z.boolean(),
  recoveryAction: IdSchema.nullable(), availability: z.enum(['ready', 'recoverable', 'setup', 'unavailable']),
}).strict();
export type VoiceConversationStatus = z.infer<typeof VoiceConversationStatusSchema>;
export const VoiceConversationActionResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('completed'), voice: VoiceConversationStatusSchema }).strict(),
  z.object({ status: z.literal('unavailable'), code: IdSchema, voice: VoiceConversationStatusSchema }).strict(),
]);
const BriefResultSchema = z.object({
  status: z.enum(['waiting', 'sent', 'refused', 'stopped']), attemptId: IdSchema.nullable(),
}).strict();
export const VoiceConversationActionOutputSchemas = {
  'ui.voice_global.get': VoiceConversationActionResultSchema,
  'ui.voice_global.start': VoiceConversationActionResultSchema,
  'ui.voice_global.end': VoiceConversationActionResultSchema,
  'ui.voice_global.set_muted': VoiceConversationActionResultSchema,
  'ui.voice_global.recover': VoiceConversationActionResultSchema,
  'ui.voice_global.dismiss': VoiceConversationActionResultSchema,
  'ui.voice_global.turn_control': VoiceConversationActionResultSchema,
  'ui.voice_global.hold_begin': VoiceConversationActionResultSchema,
  'ui.voice_global.hold_release': VoiceConversationActionResultSchema,
  'ui.voice_global.hold_cancel': VoiceConversationActionResultSchema,
  'ui.voice_global.brief.request': BriefResultSchema,
  'ui.voice_global.brief.retry': BriefResultSchema,
  'ui.voice_global.brief.stop': BriefResultSchema,
} as const;

export const VOICE_CONVERSATION_ACTION_SPECS = VOICE_CONVERSATION_ACTION_IDS.map((id): PreNormalizedActionSpec => ({
  id,
  title: {
    'ui.voice_global.get': 'Read current Voice attempt', 'ui.voice_global.start': 'Start Voice conversation',
    'ui.voice_global.end': 'End Voice conversation', 'ui.voice_global.set_muted': 'Set Voice microphone mute',
    'ui.voice_global.recover': 'Recover Voice conversation', 'ui.voice_global.dismiss': 'Dismiss ended or failed Voice attempt',
    'ui.voice_global.turn_control': 'Control current Voice turn', 'ui.voice_global.hold_begin': 'Begin Voice hold-to-talk',
    'ui.voice_global.hold_release': 'Release Voice hold-to-talk', 'ui.voice_global.hold_cancel': 'Cancel Voice hold-to-talk',
    'ui.voice_global.brief.request': 'Brief me', 'ui.voice_global.brief.retry': 'Retry Voice brief',
    'ui.voice_global.brief.stop': 'Stop Voice brief',
  }[id],
  description: 'Use the answering client’s existing Voice lifecycle, input, recovery and Inbox Brief owners. Mutations require the captured attempt identity; navigation cannot retarget them. Spoken requests cannot decide approvals.',
  safety: id === 'ui.voice_global.start' || id === 'ui.voice_global.recover' || id === 'ui.voice_global.hold_begin'
    || id === 'ui.voice_global.brief.request' || id === 'ui.voice_global.brief.retry' ? 'danger' : 'safe',
  sideEffectClass: id === 'ui.voice_global.get' ? 'read' : 'write',
  requiredAuthority: 'account_automation', executionPlacement: 'client', placements: ['command_palette'],
  bindings: { mcpToolName: id.replaceAll('.', '_') },
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: false, rpc: false },
  inputSchema: VoiceConversationActionInputSchemas[id], outputSchema: VoiceConversationActionOutputSchemas[id],
  inputHints: { fields: id === 'ui.voice_global.get' ? [{ path: 'target', title: 'Idle target', widget: 'json' }]
    : id === 'ui.voice_global.start' ? [
      { path: 'target', title: 'Global or exact Session target', widget: 'json', required: true },
      { path: 'expectedAttempt', title: 'No current attempt (null)', widget: 'json', required: true },
    ] : id.startsWith('ui.voice_global.brief.') ? [{ path: 'expectedAttemptId', title: 'Captured attempt identity', widget: 'text' }]
    : [
      { path: 'expectedAttempt', title: 'Captured attempt identity', widget: 'text', required: true },
      ...(id === 'ui.voice_global.set_muted' ? [{ path: 'muted', title: 'Muted', widget: 'boolean' as const, required: true }] : []),
      ...(id === 'ui.voice_global.dismiss' ? [{ path: 'kind', title: 'Failed or ended', widget: 'text' as const, required: true }] : []),
      ...(id === 'ui.voice_global.turn_control' ? [{ path: 'control', title: 'Commit input, interrupt or cancel', widget: 'text' as const, required: true }] : []),
    ] },
}));
