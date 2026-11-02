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

/** Display intent only; the mounted composer owns prompt selection, edits and submission. */
export const PROMPT_PICKER_ACTION_SPECS = [{
  id: 'ui.prompts.picker.open', approval: {result: 'required'},
  title: 'Open the prompt picker',
  description: 'Open Prompts on an addressed mounted composer, the invoking Session composer, or the focused composer. Returns its address or noEligibleComposer, never draft or prompt text.',
  safety: 'safe', sideEffectClass: 'external', executionPlacement: 'client', placements: [],
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: false, rpc: false },
  bindings: { mcpToolName: 'ui_prompts_picker_open' },
  inputSchema: UiPromptPickerOpenInputSchema,
  outputSchema: UiPromptPickerOpenOutputSchema,
  inputHints: { fields: [{ path: 'composerRef', title: 'Mounted composer address', widget: 'json' }] },
}] as const satisfies readonly PreNormalizedActionSpec[];

export const UiPromptPickerSelectInputSchema = lazyZodSchema(() => z.strictObject({
  composerRef: z.optional(ComposerRefSchema),
  selection: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('doc'), artifactId: z.string().check(z.minLength(1)) }),
    z.strictObject({ kind: z.literal('builtIn'), token: z.string().check(z.minLength(1)) }),
    z.strictObject({ kind: z.literal('history'), serverId: z.string().check(z.minLength(1)), sessionId: z.string().check(z.minLength(1)), messageId: z.string().check(z.minLength(1)) }),
  ]),
}));

export const UiPromptPickerApplyInputSchema = lazyZodSchema(() => z.strictObject({
  composerRef: z.optional(ComposerRefSchema), mode: z.enum(['insert', 'send']),
}));

export const UiPromptHistoryInputSchema = lazyZodSchema(() => z.strictObject({
  composerRef: z.optional(ComposerRefSchema), op: z.enum(['read', 'page', 'stop', 'retry']),
}));
