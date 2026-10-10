import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import type { PreNormalizedActionSpec } from './actionSpecs.js';
import { SessionVoicePreferenceV1Schema } from '../sessions/instructions/sessionVoicePreferenceV1.js';

export const VOICE_CONVERSATION_ACTION_IDS = [
  'ui.voice_global.get', 'ui.voice_global.start', 'ui.voice_global.end', 'ui.voice_global.set_muted',
  'ui.voice_global.recover', 'ui.voice_global.dismiss', 'ui.voice_global.turn_control',
  'ui.voice_global.hold_begin', 'ui.voice_global.hold_release', 'ui.voice_global.hold_cancel',
  'ui.voice_global.brief.request', 'ui.voice_global.brief.retry', 'ui.voice_global.brief.stop',
  'ui.voice_global.brief.close', 'ui.voice_global.glance.open', 'ui.voice_global.glance.close',
  'ui.voice_global.transcript.set_visible', 'ui.voice_global.companion.reveal', 'ui.voice_global.position.set',
  'ui.voice_global.setup.open', 'ui.voice_global.setup.close', 'ui.voice_global.open_conversation',
] as const;
export type VoiceConversationActionId = typeof VOICE_CONVERSATION_ACTION_IDS[number];
export function isVoiceConversationActionId(value: string): value is VoiceConversationActionId {
  return (VOICE_CONVERSATION_ACTION_IDS as readonly string[]).includes(value);
}

const IdSchema = lazyZodSchema(() => z.string().trim().min(1));
const AddressSchema = lazyZodSchema(() => z.object({ serverId: IdSchema, sessionId: IdSchema }).strict());
export const VoiceConversationTargetSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('global') }).strict(),
  z.object({ kind: z.literal('session'), sessionAddress: AddressSchema.nullable() }).strict(),
  z.object({ kind: z.literal('default') }).strict(),
]));
const AttemptInputSchema = lazyZodSchema(() => z.object({ expectedAttempt: IdSchema }).strict());
const BriefInputSchema = lazyZodSchema(() => z.object({ expectedAttemptId: IdSchema.optional() }).strict());
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
  'ui.voice_global.brief.close': BriefInputSchema,
  'ui.voice_global.glance.open': z.object({}).strict(),
  'ui.voice_global.glance.close': z.object({}).strict(),
  'ui.voice_global.transcript.set_visible': z.object({ visible: z.boolean() }).strict(),
  'ui.voice_global.companion.reveal': z.object({}).strict(),
  'ui.voice_global.position.set': z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict(),
  'ui.voice_global.setup.open': z.object({}).strict(),
  'ui.voice_global.setup.close': z.object({}).strict(),
  'ui.voice_global.open_conversation': AttemptInputSchema,
} as const;

/** The adapter's accepted voice for this attempt, never its saved next-attempt preference. */
export const VoiceConversationInUseVoiceSchema = lazyZodSchema(() => SessionVoicePreferenceV1Schema.extend({
  displayName: z.string().trim().min(1),
}).strict());
export type VoiceConversationInUseVoice = z.infer<typeof VoiceConversationInUseVoiceSchema>;

export const VoiceConversationStatusSchema = lazyZodSchema(() => z.object({
  attemptId: IdSchema.nullable(), adapterId: IdSchema.nullable(), sessionId: IdSchema.nullable(),
  status: z.enum(['disconnected', 'connecting', 'connected', 'error']),
  mode: z.enum(['idle', 'listening', 'transcribing', 'thinking', 'speaking']),
  target: VoiceConversationTargetSchema,
  conversationSessionAddress: AddressSchema.nullable(), targetSessionAddress: AddressSchema.nullable(),
  canStart: z.boolean(), canStop: z.boolean(), canMute: z.boolean(), canCommitInput: z.boolean(),
  canHoldToTalk: z.boolean(), muted: z.boolean(), canDismissFailedAttempt: z.boolean(), canDismissEnded: z.boolean(),
  recoveryAction: IdSchema.nullable(), availability: z.enum(['ready', 'recoverable', 'setup', 'unavailable']),
  inUseVoice: VoiceConversationInUseVoiceSchema.nullable(),
}).strict());
export type VoiceConversationStatus = z.infer<typeof VoiceConversationStatusSchema>;
export const VoiceConversationActionResultSchema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({ status: z.literal('completed'), voice: VoiceConversationStatusSchema }).strict(),
  z.object({ status: z.literal('unavailable'), code: IdSchema, voice: VoiceConversationStatusSchema }).strict(),
]));
const BriefResultSchema = lazyZodSchema(() => z.object({
  status: z.enum(['waiting', 'sent', 'refused', 'stopped', 'closed']), attemptId: IdSchema.nullable(),
}).strict());
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
  'ui.voice_global.brief.close': BriefResultSchema,
  'ui.voice_global.glance.open': VoiceConversationActionResultSchema,
  'ui.voice_global.glance.close': VoiceConversationActionResultSchema,
  'ui.voice_global.transcript.set_visible': VoiceConversationActionResultSchema,
  'ui.voice_global.companion.reveal': VoiceConversationActionResultSchema,
  'ui.voice_global.position.set': VoiceConversationActionResultSchema,
  'ui.voice_global.setup.open': VoiceConversationActionResultSchema,
  'ui.voice_global.setup.close': VoiceConversationActionResultSchema,
  'ui.voice_global.open_conversation': VoiceConversationActionResultSchema,
} as const;

/** What a person reads in Settings, approvals and the form. Agents read `description`. */
const VOICE_CONVERSATION_ACTION_SUMMARIES = {
  'ui.voice_global.get': 'See whether a voice conversation is going on, and what it is attached to.',
  'ui.voice_global.start': 'Start talking with Happier, about everything or about one session.',
  'ui.voice_global.end': 'End the voice conversation that is going on.',
  'ui.voice_global.set_muted': 'Mute or unmute your microphone during a voice conversation.',
  'ui.voice_global.recover': 'Try again when a voice conversation dropped or could not start.',
  'ui.voice_global.dismiss': 'Clear a voice conversation that ended or failed from the screen.',
  'ui.voice_global.turn_control': 'Interrupt the voice, send what you said, or cancel your turn.',
  'ui.voice_global.hold_begin': 'Start speaking in hold-to-talk.',
  'ui.voice_global.hold_release': 'Finish speaking in hold-to-talk and send what you said.',
  'ui.voice_global.hold_cancel': 'Stop speaking in hold-to-talk without sending anything.',
  'ui.voice_global.brief.request': 'Hear a spoken summary of what needs you in your Inbox.',
  'ui.voice_global.brief.retry': 'Ask for the spoken summary again when it failed.',
  'ui.voice_global.brief.stop': 'Stop the spoken summary.',
  'ui.voice_global.brief.close': 'Close the Brief list without ending the conversation.',
  'ui.voice_global.glance.open': 'Open the mounted Voice glance controls.',
  'ui.voice_global.glance.close': 'Close the mounted Voice glance controls.',
  'ui.voice_global.transcript.set_visible': 'Show or hide the current Voice transcript.',
  'ui.voice_global.companion.reveal': 'Reveal the Voice section in the mounted Companion.',
  'ui.voice_global.position.set': 'Place the mounted Island or Orb within its measured bounds using normalized coordinates.',
  'ui.voice_global.setup.open': 'Expand the mounted Voice setup steps without starting audio.',
  'ui.voice_global.setup.close': 'Close the mounted Voice setup steps.',
  'ui.voice_global.open_conversation': 'Open the captured conversation destination, including Voice History for an unsaved attempt.',
} as const satisfies Record<(typeof VOICE_CONVERSATION_ACTION_IDS)[number], string>;

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
    'ui.voice_global.brief.close': 'Close Voice brief',
    'ui.voice_global.glance.open': 'Open Voice glance', 'ui.voice_global.glance.close': 'Close Voice glance',
    'ui.voice_global.transcript.set_visible': 'Show or hide Voice transcript',
    'ui.voice_global.companion.reveal': 'Reveal Companion Voice section',
    'ui.voice_global.position.set': 'Position Voice Island or Orb',
    'ui.voice_global.setup.open': 'Expand Voice setup', 'ui.voice_global.setup.close': 'Close Voice setup',
    'ui.voice_global.open_conversation': 'Open Voice conversation',
  }[id],
  description: 'Use the answering client’s existing Voice lifecycle, input, recovery and Inbox Brief owners. Mutations require the captured attempt identity; navigation cannot retarget them. Spoken requests cannot decide approvals.',
  safety: id === 'ui.voice_global.start' || id === 'ui.voice_global.recover' || id === 'ui.voice_global.hold_begin'
    || id === 'ui.voice_global.brief.request' || id === 'ui.voice_global.brief.retry' ? 'danger' : 'safe',
  sideEffectClass: id === 'ui.voice_global.get' ? 'read' : 'write',
  requiredAuthority: 'account_automation', executionPlacement: 'client', placements: ['command_palette'],
  bindings: { mcpToolName: id.replaceAll('.', '_') },
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: false, rpc: false },
  inputSchema: VoiceConversationActionInputSchemas[id], outputSchema: VoiceConversationActionOutputSchemas[id],
  inputHints: { description: VOICE_CONVERSATION_ACTION_SUMMARIES[id], fields: id === 'ui.voice_global.get' ? [{ path: 'target', title: 'Where Voice would start', widget: 'json' }]
    : id === 'ui.voice_global.start' ? [
      { path: 'target', title: 'Where Voice starts', description: 'Everywhere in the app, or one session.', widget: 'json', required: true },
      { path: 'expectedAttempt', title: 'Current Voice conversation', description: 'Empty when none is running.', widget: 'json', required: true },
    ] : id.startsWith('ui.voice_global.brief.') ? [{ path: 'expectedAttemptId', title: 'Voice conversation', widget: 'text' }]
    : id === 'ui.voice_global.position.set' ? [
      { path: 'x', title: 'Horizontal position', widget: 'number', required: true },
      { path: 'y', title: 'Vertical position', widget: 'number', required: true },
    ] : id === 'ui.voice_global.transcript.set_visible' ? [{ path: 'visible', title: 'Transcript visible', widget: 'boolean', required: true }]
    : id.includes('.glance.') || id.includes('.setup.') || id === 'ui.voice_global.companion.reveal' ? []
    : [
      { path: 'expectedAttempt', title: 'Voice conversation', widget: 'text', required: true },
      ...(id === 'ui.voice_global.set_muted' ? [{ path: 'muted', title: 'Muted', widget: 'boolean' as const, required: true }] : []),
      ...(id === 'ui.voice_global.dismiss' ? [{ path: 'kind', title: 'What to dismiss', widget: 'text' as const, required: true }] : []),
      ...(id === 'ui.voice_global.turn_control' ? [{ path: 'control', title: 'Turn control', widget: 'text' as const, required: true }] : []),
    ] },
}));
