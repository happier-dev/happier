import { z } from 'zod';

import { ComposerRefV1Schema } from '../plugins/ui/composerRef.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import type { PreNormalizedActionSpec } from './actionSpecs.js';

const ComposerRefSchema = asProtocolZod(ComposerRefV1Schema);
export const UiPromptPickerOpenInputSchema = z.object({
  composerRef: ComposerRefSchema.optional(),
}).strict();

export const UiPromptPickerOpenOutputSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('opened'), composerRef: ComposerRefSchema }).strict(),
  z.object({ status: z.literal('noEligibleComposer') }).strict(),
  z.object({ status: z.literal('unavailable'), reason: z.literal('noClient') }).strict(),
]);

/** Display intent only; the mounted composer owns prompt selection, edits and submission. */
export const PROMPT_PICKER_ACTION_SPECS = [{
  id: 'ui.prompts.picker.open',
  title: 'Open the prompt picker',
  description: 'Open Prompts on an addressed mounted composer, the invoking Session composer, or the focused composer. Returns its address or noEligibleComposer, never draft or prompt text.',
  safety: 'safe', sideEffectClass: 'external', executionPlacement: 'client', placements: [],
  surfaces: { ui: true, voice: false, agent: true, mcp: false, cli: false, rpc: false },
  inputSchema: UiPromptPickerOpenInputSchema,
  outputSchema: UiPromptPickerOpenOutputSchema,
  inputHints: { fields: [{ path: 'composerRef', title: 'Mounted composer address', widget: 'json' }] },
}] as const satisfies readonly PreNormalizedActionSpec[];
