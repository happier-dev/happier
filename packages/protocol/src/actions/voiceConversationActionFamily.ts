import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import type { PreNormalizedActionSpec } from './actionSpecs.js';
import { SessionVoicePreferenceV1Schema } from '../sessions/instructions/sessionVoicePreferenceV1.js';
import { VoiceAttemptPresentationSchema } from '../voice/attemptPresentation.js';

export const VOICE_CONVERSATION_ACTION_IDS = [
  'ui.voice_global.get', 'ui.voice_global.start', 'ui.voice_global.end', 'ui.voice_global.set_muted',
  'ui.voice_global.recover', 'ui.voice_global.dismiss', 'ui.voice_global.turn_control',
  'ui.voice_global.hold_begin', 'ui.voice_global.hold_release', 'ui.voice_global.hold_cancel',
  'ui.voice_global.brief.request', 'ui.voice_global.brief.retry', 'ui.voice_global.brief.stop',
  'ui.voice_global.brief.close', 'ui.voice_global.glance.open', 'ui.voice_global.glance.close',
  'ui.voice_global.transcript.set_visible', 'ui.voice_global.companion.reveal', 'ui.voice_global.position.set',
  'ui.voice_global.setup.open', 'ui.voice_global.setup.close', 'ui.voice_global.open_conversation',
  'ui.voice_global.setup.microphone.permission.request', 'ui.voice_global.setup.system_settings.open',
  'ui.voice_global.dictation.start', 'ui.voice_global.dictation.finish',
  'ui.voice_global.dictation.cancel', 'ui.voice_global.dictation.dismiss',
  'ui.voice_global.conversations.list',
  'ui.voice_global.history.search', 'ui.voice_global.history.load_older',
  'ui.voice_global.history.export', 'ui.voice_global.history.clear',
] as const;
export type VoiceConversationActionId = typeof VOICE_CONVERSATION_ACTION_IDS[number];
export function isVoiceConversationActionId(value: string): value is VoiceConversationActionId {
  return (VOICE_CONVERSATION_ACTION_IDS as readonly string[]).includes(value);
}

export type VoiceDictationOperation = 'start' | 'finish' | 'cancel' | 'dismiss';
export type VoiceDictationActionId = Extract<VoiceConversationActionId, `ui.voice_global.dictation.${string}`>;
export function isVoiceDictationActionId(value: string): value is VoiceDictationActionId {
  return value.startsWith('ui.voice_global.dictation.') && isVoiceConversationActionId(value);
}
export function voiceDictationOperation(actionId: VoiceDictationActionId): VoiceDictationOperation {
  return actionId.slice('ui.voice_global.dictation.'.length) as VoiceDictationOperation;
}

export type VoiceHistoryActionId = Extract<VoiceConversationActionId, `ui.voice_global.history.${string}`>;
export function isVoiceHistoryActionId(value: string): value is VoiceHistoryActionId {
  return value.startsWith('ui.voice_global.history.') && isVoiceConversationActionId(value);
}

const HistorySearchInputSchema = lazyZodSchema(() => z.strictObject({ query: z.optional(z.string()), refresh: z.optional(z.boolean()) }));
const HistoryPageInputSchema = lazyZodSchema(() => z.strictObject({ query: z.optional(z.string()) }));
const HistoryExportInputSchema = lazyZodSchema(() => z.strictObject({ range: z.enum(['loaded', 'all']), query: z.optional(z.string()) }));
export const VoiceHistorySnapshotSchema = lazyZodSchema(() => z.strictObject({
  sessionId: z.nullable(z.string()), loadedRowCount: z.number().check(z.int(), z.minimum(0)), hasMore: z.nullable(z.boolean()),
  rows: z.array(z.strictObject({ id: z.string(), role: z.enum(['user', 'assistant']), text: z.string(), createdAt: z.number(),
    providerLabel: z.string(), source: z.nullable(z.strictObject({ pluginId: z.string(), contributionId: z.string() })) })),
}));

const IdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
const AddressSchema = lazyZodSchema(() => z.strictObject({ serverId: IdSchema, sessionId: IdSchema }));
const ConversationHistoryCursorSchema = lazyZodSchema(() => z.strictObject({
  active: z.nullable(IdSchema), archived: z.nullable(IdSchema),
}));
export const VoiceConversationTargetSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('global') }),
  z.strictObject({ kind: z.literal('session'), sessionAddress: z.nullable(AddressSchema) }),
  z.strictObject({ kind: z.literal('default') }),
]));
const AttemptInputSchema = lazyZodSchema(() => z.strictObject({ expectedAttempt: IdSchema }));
const BriefInputSchema = lazyZodSchema(() => z.strictObject({ expectedAttemptId: z.optional(IdSchema) }));
const DictationInputSchema = lazyZodSchema(() => z.strictObject({ commandId: IdSchema }));
export const VoiceConversationHistoryListSchema = lazyZodSchema(() => z.strictObject({
  coverage: z.literal('loaded'),
  coverageComplete: z.optional(z.boolean()),
  nextCursor: z.optional(z.nullable(ConversationHistoryCursorSchema)),
  conversations: z.array(z.strictObject({ address: AddressSchema, title: z.string(), lastActivityAt: z.number(),
    canContinue: z.nullable(z.boolean()), hasBlockedInputs: z.boolean(),
    pendingInputs: z.array(z.strictObject({ localId: z.string(), reason: z.nullable(z.string()) })) })),
}));
export const VoiceDictationActionResultSchema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('completed'), dictationStatus: z.enum(['idle', 'starting', 'listening', 'transcribing']), inserted: z.boolean() }),
  z.strictObject({ status: z.literal('unavailable'), code: z.enum(['dictation_field_unmounted', 'dictation_field_unavailable',
    'dictation_consent_required', 'dictation_microphone_unavailable', 'dictation_capture_unavailable', 'dictation_state_changed',
    'dictation_cancelled', 'dictation_failed']) }),
]));
export type VoiceDictationActionResult = z.infer<typeof VoiceDictationActionResultSchema>;
export const VoiceConversationActionInputSchemas = {
  'ui.voice_global.conversations.list': z.strictObject({ conversationSessionAddress: z.optional(AddressSchema), cursor: z.optional(ConversationHistoryCursorSchema) }),
  'ui.voice_global.get': z.strictObject({ target: z.optional(VoiceConversationTargetSchema) }),
  'ui.voice_global.start': z.strictObject({ target: VoiceConversationTargetSchema, expectedAttempt: z.null() }),
  'ui.voice_global.end': AttemptInputSchema,
  'ui.voice_global.set_muted': lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AttemptInputSchema, { muted: z.boolean() }))),
  'ui.voice_global.recover': AttemptInputSchema,
  'ui.voice_global.dismiss': lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AttemptInputSchema, { kind: z.enum(['failed', 'ended']) }))),
  'ui.voice_global.turn_control': lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AttemptInputSchema, { control: z.enum(['commit_input', 'interrupt', 'cancel']) }))),
  'ui.voice_global.hold_begin': AttemptInputSchema,
  'ui.voice_global.hold_release': AttemptInputSchema,
  'ui.voice_global.hold_cancel': AttemptInputSchema,
  'ui.voice_global.brief.request': BriefInputSchema,
  'ui.voice_global.brief.retry': BriefInputSchema,
  'ui.voice_global.brief.stop': BriefInputSchema,
  'ui.voice_global.brief.close': BriefInputSchema,
  'ui.voice_global.glance.open': z.strictObject({}),
  'ui.voice_global.glance.close': z.strictObject({}),
  'ui.voice_global.transcript.set_visible': z.strictObject({ visible: z.boolean() }),
  'ui.voice_global.companion.reveal': z.strictObject({}),
  'ui.voice_global.position.set': z.strictObject({ x: z.number().check(z.minimum(0), z.maximum(1)), y: z.number().check(z.minimum(0), z.maximum(1)) }),
  'ui.voice_global.setup.open': z.strictObject({}),
  'ui.voice_global.setup.close': z.strictObject({}),
  'ui.voice_global.setup.microphone.permission.request': z.strictObject({}),
  'ui.voice_global.setup.system_settings.open': z.strictObject({}),
  'ui.voice_global.open_conversation': AttemptInputSchema,
  'ui.voice_global.dictation.start': DictationInputSchema,
  'ui.voice_global.dictation.finish': DictationInputSchema,
  'ui.voice_global.dictation.cancel': DictationInputSchema,
  'ui.voice_global.dictation.dismiss': DictationInputSchema,
  'ui.voice_global.history.search': HistorySearchInputSchema,
  'ui.voice_global.history.load_older': HistoryPageInputSchema,
  'ui.voice_global.history.export': HistoryExportInputSchema,
  'ui.voice_global.history.clear': z.strictObject({}),
} as const;

/** The adapter's accepted voice for this attempt, never its saved next-attempt preference. */
export const VoiceConversationInUseVoiceSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionVoicePreferenceV1Schema, {
  displayName: z.string().check(z.trim(), z.minLength(1)),
})));
export type VoiceConversationInUseVoice = z.infer<typeof VoiceConversationInUseVoiceSchema>;

export const VoiceConversationStatusSchema = lazyZodSchema(() => z.strictObject({
  attemptId: z.nullable(IdSchema), adapterId: z.nullable(IdSchema), sessionId: z.nullable(IdSchema),
  status: z.enum(['disconnected', 'connecting', 'connected', 'error']),
  mode: z.enum(['idle', 'listening', 'transcribing', 'thinking', 'speaking']),
  target: VoiceConversationTargetSchema,
  conversationSessionAddress: z.nullable(AddressSchema), targetSessionAddress: z.nullable(AddressSchema),
  canStart: z.boolean(), canStop: z.boolean(), canMute: z.boolean(), canCommitInput: z.boolean(),
  canHoldToTalk: z.boolean(), muted: z.boolean(), canDismissFailedAttempt: z.boolean(), canDismissEnded: z.boolean(),
  recoveryAction: z.nullable(IdSchema), availability: z.enum(['ready', 'recoverable', 'setup', 'unavailable']),
  inUseVoice: z.nullable(VoiceConversationInUseVoiceSchema),
  /** Read projection; older callers may omit it. No control input or authority is carried here. */
  presentation: z.optional(VoiceAttemptPresentationSchema),
}));
export type VoiceConversationStatus = z.infer<typeof VoiceConversationStatusSchema>;
export const VoiceConversationActionResultSchema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('completed'), voice: VoiceConversationStatusSchema }),
  z.strictObject({ status: z.literal('unavailable'), code: IdSchema, voice: VoiceConversationStatusSchema }),
]));
export const VoiceSetupMicrophonePermissionActionResultSchema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('completed'), permission: z.literal('granted'), voice: VoiceConversationStatusSchema }),
  z.strictObject({ status: z.literal('unavailable'), code: IdSchema,
    permission: z.enum(['denied', 'unavailable', 'unknown']), voice: VoiceConversationStatusSchema }),
]));
const BriefResultSchema = lazyZodSchema(() => z.strictObject({
  status: z.enum(['waiting', 'sent', 'refused', 'stopped', 'closed']), attemptId: z.nullable(IdSchema),
}));
export const VoiceConversationActionOutputSchemas = {
  'ui.voice_global.conversations.list': VoiceConversationHistoryListSchema,
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
  'ui.voice_global.setup.microphone.permission.request': VoiceSetupMicrophonePermissionActionResultSchema,
  'ui.voice_global.setup.system_settings.open': VoiceConversationActionResultSchema,
  'ui.voice_global.open_conversation': VoiceConversationActionResultSchema,
  'ui.voice_global.dictation.start': VoiceDictationActionResultSchema,
  'ui.voice_global.dictation.finish': VoiceDictationActionResultSchema,
  'ui.voice_global.dictation.cancel': VoiceDictationActionResultSchema,
  'ui.voice_global.dictation.dismiss': VoiceDictationActionResultSchema,
  'ui.voice_global.history.search': VoiceHistorySnapshotSchema,
  'ui.voice_global.history.load_older': VoiceHistorySnapshotSchema,
  'ui.voice_global.history.export': z.strictObject({ fileName: z.string(), mimeType: z.literal('application/json'),
    rowCount: z.number().check(z.int(), z.minimum(0)), range: z.enum(['loaded', 'all']) }),
  'ui.voice_global.history.clear': z.strictObject({ cleared: z.boolean() }),
} as const;

/** What a person reads in Settings, approvals and the form. Agents read `description`. */
const VOICE_CONVERSATION_ACTION_SUMMARIES = {
  'ui.voice_global.conversations.list': 'Read a page of the person’s own active and archived Voice conversations at this Home, including retained and retired custody, with exact addresses, Session titles, meaningful activity and blocked-input flags. Return nextCursor unchanged to read another page; null cursor components are exhausted. Coverage remains loaded; coverageComplete is false while pages or unreadable owner displays remain. canContinue:null means the compact display has not established eligibility; Continue resolves that exact conversation. Supply conversationSessionAddress to read only that conversation’s canonical Pending recovery identities and reasons. Offer cleanup through approval-governed session.pending.markHandled, session.pending.dismiss, session.pending.sendAsNew or session.pending.withdraw with that Home, Session and exact localId; never automatically replay or discard inputs. Send as new may duplicate an effect.',
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
  'ui.voice_global.setup.microphone.permission.request': 'Ask this device for microphone permission without starting a Voice conversation. The operating system or browser retains consent.',
  'ui.voice_global.setup.system_settings.open': 'Open this device’s application settings so the person can change microphone permission.',
  'ui.voice_global.open_conversation': 'Open the captured conversation destination, including Voice History for an unsaved attempt.',
  'ui.voice_global.dictation.start': 'Dictate into the exact focused editable field. Requires microphone consent and never submits the field.',
  'ui.voice_global.dictation.finish': 'Finish Dictation and insert recognized words into the same editable field without sending.',
  'ui.voice_global.dictation.cancel': 'Cancel Dictation for the exact mounted field without inserting words.',
  'ui.voice_global.dictation.dismiss': 'Dismiss the exact mounted field’s Dictation failure.',
  'ui.voice_global.history.search': 'Search ordinary text in the person’s owned Voice conversations, including archived conversations, at this Home. Discovers conversations on first use; refresh explicitly reloads them. Warm search filters loaded rows.',
  'ui.voice_global.history.load_older': 'Load older transcript pages from owned Voice conversations, optionally filtering the loaded rows.',
  'ui.voice_global.history.export': 'Export loaded or all owned Voice conversation text to this client’s download or share target, optionally filtered. Uses the canonical streaming JSON serializer.',
  'ui.voice_global.history.clear': 'Delete the discovered owned Voice conversations at this Home and retire their local rows. Requires confirmation.',
} as const satisfies Record<(typeof VOICE_CONVERSATION_ACTION_IDS)[number], string>;

export const VOICE_CONVERSATION_ACTION_SPECS = VOICE_CONVERSATION_ACTION_IDS.map((id): PreNormalizedActionSpec => ({
  id, approval: { result: 'required' },
  approvalPolicy: { uiConfirmation: 'direct' },
  ...(id === 'ui.voice_global.set_muted' ? { safetyForInput: (input: unknown) => {
    const parsed = VoiceConversationActionInputSchemas['ui.voice_global.set_muted'].safeParse(input);
    return parsed.success && parsed.data.muted === true ? 'safe' as const : undefined;
  } } : {}),
  title: {
    'ui.voice_global.conversations.list': 'List Voice conversations',
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
    'ui.voice_global.setup.microphone.permission.request': 'Allow Voice microphone access',
    'ui.voice_global.setup.system_settings.open': 'Open Voice system settings',
    'ui.voice_global.open_conversation': 'Open Voice conversation',
    'ui.voice_global.dictation.start': 'Start field Dictation', 'ui.voice_global.dictation.finish': 'Finish field Dictation',
    'ui.voice_global.dictation.cancel': 'Cancel field Dictation', 'ui.voice_global.dictation.dismiss': 'Dismiss field Dictation failure',
    'ui.voice_global.history.search': 'Search Voice History', 'ui.voice_global.history.load_older': 'Load older Voice History',
    'ui.voice_global.history.export': 'Export Voice History', 'ui.voice_global.history.clear': 'Clear Voice History',
  }[id],
  description: isVoiceHistoryActionId(id) ? VOICE_CONVERSATION_ACTION_SUMMARIES[id]
    : 'Use the answering client’s existing Voice lifecycle, input, recovery and Inbox Brief owners. Mutations require the captured attempt identity; navigation cannot retarget them. Local Voice and host-tool realtime may decide pending requests when Voice agent can approve requests is enabled (the default); when off, a tap is required. Native Codex Realtime cannot decide: tap the request or switch to Local Voice. Confirm outcomes only from canonical request state.',
  safety: id === 'ui.voice_global.start' || id === 'ui.voice_global.recover' || id === 'ui.voice_global.hold_begin'
    || id === 'ui.voice_global.set_muted' || id === 'ui.voice_global.dictation.start'
    || id === 'ui.voice_global.setup.microphone.permission.request'
    || id === 'ui.voice_global.history.clear'
    || id === 'ui.voice_global.brief.request' || id === 'ui.voice_global.brief.retry' ? 'danger' : 'safe',
  sideEffectClass: id === 'ui.voice_global.get' || id === 'ui.voice_global.conversations.list' || (isVoiceHistoryActionId(id) && id !== 'ui.voice_global.history.clear') ? 'read' : 'write',
  requiredAuthority: 'account_automation', executionPlacement: 'client', placements: ['command_palette'],
  bindings: { mcpToolName: id.replaceAll('.', '_') },
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: false, rpc: false },
  inputSchema: VoiceConversationActionInputSchemas[id], outputSchema: VoiceConversationActionOutputSchemas[id],
  inputHints: { description: VOICE_CONVERSATION_ACTION_SUMMARIES[id], fields: isVoiceHistoryActionId(id)
    ? id === 'ui.voice_global.history.clear' ? [] : [
      { path: 'query', title: 'Search text or provider', widget: 'text' },
      ...(id === 'ui.voice_global.history.search' ? [{ path: 'refresh', title: 'Refresh history', widget: 'boolean' as const }] : []),
      ...(id === 'ui.voice_global.history.export' ? [{ path: 'range', title: 'Export range', widget: 'select' as const, required: true,
        options: [{ value: 'loaded', label: 'Loaded history' }, { value: 'all', label: 'All history' }] }] : []),
    ] : isVoiceDictationActionId(id)
    ? [{ path: 'commandId', title: 'Mounted field command', widget: 'text', required: true }]
    : id === 'ui.voice_global.get' ? [{ path: 'target', title: 'Where Voice would start', widget: 'json' }]
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
