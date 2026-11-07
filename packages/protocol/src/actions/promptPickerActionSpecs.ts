import { lazyActionSpecArray } from './lazyActionSpecValue.js';
import * as zMini from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

import { ComposerRefV1Schema } from '../plugins/ui/composerRef.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import type { PreNormalizedActionSpec } from './actionSpecs.js';

const ComposerRefSchema = asProtocolZod(ComposerRefV1Schema);
export const UiPromptPickerOpenInputSchema = lazyZodSchema(() => z.strictObject({
  composerRef: zMini.optional(ComposerRefSchema),
}));

export const UiPromptPickerOpenOutputSchema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('opened'), composerRef: ComposerRefSchema }),
  z.strictObject({ status: z.literal('noEligibleComposer') }),
  z.strictObject({ status: z.literal('unavailable'), reason: z.literal('noClient') }),
]));

export const UiPromptPickerSelectInputSchema = lazyZodSchema(() => z.strictObject({
  composerRef: z.optional(ComposerRefSchema),
  selection: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('doc'), artifactId: z.string().check(z.minLength(1)) }),
    z.strictObject({ kind: z.literal('builtIn'), token: z.string().check(z.minLength(1)) }),
    z.strictObject({ kind: z.literal('history'), serverId: z.string().check(z.minLength(1)), sessionId: z.string().check(z.minLength(1)), messageId: z.string().check(z.minLength(1)) }),
  ]),
}));
export const UiPromptPickerSelectOutputSchema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('selected'), composerRef: ComposerRefSchema }),
  z.strictObject({ status: z.enum(['notFound', 'notReady', 'notOpen', 'noEligibleComposer']) }),
  z.strictObject({ status: z.literal('unavailable'), reason: z.literal('noClient') }),
]));
export const UiPromptPickerApplyInputSchema = lazyZodSchema(() => z.strictObject({
  composerRef: z.optional(ComposerRefSchema), mode: z.enum(['insert', 'send']),
}));
export const UiPromptPickerApplyOutputSchema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('applied'), composerRef: ComposerRefSchema }),
  z.strictObject({ status: z.enum(['refused', 'notOpen', 'noEligibleComposer']) }),
  z.strictObject({ status: z.literal('unavailable'), reason: z.literal('noClient') }),
]));
export const UiPromptHistoryInputSchema = lazyZodSchema(() => z.strictObject({
  composerRef: z.optional(ComposerRefSchema), op: z.enum(['read', 'page', 'stop', 'retry']),
}));
export const UiPromptHistoryOutputSchema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ready'), composerRef: ComposerRefSchema,
    entries: z.array(z.strictObject({ serverId: z.string().check(z.minLength(1)), sessionId: z.string().check(z.minLength(1)), messageId: z.string().check(z.minLength(1)), seq: z.nullable(z.number().check(z.int(), z.gte(0))), createdAtMs: z.number().check(z.gte(0)), text: z.string() })),
    coverage: z.enum(['loaded', 'partial', 'complete']), hasMore: z.boolean(), isLoading: z.boolean(), error: z.boolean(),
    progress: z.strictObject({ pagesLoaded: z.number().check(z.int(), z.gte(0)), sessionsSearched: z.number().check(z.int(), z.gte(0)), totalSessions: z.number().check(z.int(), z.gte(0)) }),
  }),
  z.strictObject({ status: z.enum(['notOpen', 'noEligibleComposer']) }),
  z.strictObject({ status: z.literal('unavailable'), reason: z.literal('noClient') }),
]));

/** The mounted composer remains the sole owner of prompt selection, edits and submission. */
function createPromptPickerActionSpecs() {
  return [{
  id: 'ui.prompts.picker.open', approval: {result: 'required'},
  clientPresenter: 'session',
  title: 'Open the prompt picker',
  description: 'Open Prompts on an addressed mounted composer, the invoking Session composer, or the focused composer. Returns its address or noEligibleComposer, never draft or prompt text.',
  safety: 'safe', sideEffectClass: 'external', executionPlacement: 'client', placements: [],
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: false, rpc: false },
  bindings: { mcpToolName: 'ui_prompts_picker_open' },
  inputSchema: UiPromptPickerOpenInputSchema,
  outputSchema: UiPromptPickerOpenOutputSchema,
  inputHints: { fields: [{ path: 'composerRef', title: 'Mounted composer address', widget: 'json' }] },
}, {
  id: 'ui.prompts.picker.select', approval: { result: 'required' },
  clientPresenter: 'session',
  cli: { commands: [] },
  title: 'Select a prompt',
  description: 'Select a document, built-in prompt or exact Sent-before entry in the open mounted prompt picker. Does not edit or submit the draft.',
  safety: 'safe', sideEffectClass: 'external', executionPlacement: 'client', placements: [],
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
  bindings: { mcpToolName: 'ui_prompts_picker_select' },
  inputSchema: UiPromptPickerSelectInputSchema, outputSchema: UiPromptPickerSelectOutputSchema,
}, {
  id: 'ui.prompts.picker.apply', approval: { result: 'required' },
  clientPresenter: 'session',
  cli: { commands: [] },
  approvalPolicy: { uiConfirmation: 'direct' },
  title: 'Apply the selected prompt',
  description: 'Insert the selected prompt at the mounted composer selection, preserving argument selection, or send it through the existing composer submission owner. A stale draft is refused.',
  safety: 'danger', sideEffectClass: 'external', executionPlacement: 'client', placements: [],
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
  bindings: { mcpToolName: 'ui_prompts_picker_apply' },
  inputSchema: UiPromptPickerApplyInputSchema, outputSchema: UiPromptPickerApplyOutputSchema,
}, {
  id: 'ui.prompts.history', approval: { result: 'required' },
  clientPresenter: 'session',
  cli: { commands: [] },
  title: 'Read Sent-before history',
  description: 'Read, page, stop or retry the open prompt picker’s existing Account-scoped global Sent-before projection on the answering client. Coverage reflects its device-decrypted corpus; no server plaintext search is performed.',
  safety: 'safe', sideEffectClass: 'read', executionPlacement: 'client', placements: [],
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
  bindings: { mcpToolName: 'ui_prompts_history' },
  inputSchema: UiPromptHistoryInputSchema, outputSchema: UiPromptHistoryOutputSchema,
}] as const satisfies readonly PreNormalizedActionSpec[];
}

export const PROMPT_PICKER_ACTION_SPECS: ReturnType<typeof createPromptPickerActionSpecs> = lazyActionSpecArray(createPromptPickerActionSpecs);
