import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { PromptInvocationAvailabilityV1Schema, PromptInvocationBehaviorV1Schema, PromptInvocationTargetV1Schema } from '../prompts/library/promptInvocationsV1.js';
import type { PreNormalizedActionSpec } from './actionSpecs.js';

export const PromptInvocationCreateInputSchema = lazyZodSchema(() => z.object({
  token: z.string().trim().min(1), title: z.string().trim().min(1), target: PromptInvocationTargetV1Schema,
  behavior: PromptInvocationBehaviorV1Schema.optional(), allowArgs: z.boolean().optional(), availableIn: PromptInvocationAvailabilityV1Schema.optional(),
}).strict());
export const PromptInvocationCreateOutputSchema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({ status: z.literal('updated'), invocationId: z.string().min(1), token: z.string().min(1), revision: z.number().int().nonnegative() }).strict(),
  z.object({ status: z.literal('invalid'), reason: z.enum(['invalid', 'reserved', 'actionCollision', 'duplicate']) }).strict(),
  z.object({ status: z.literal('conflict'), revision: z.number().int() }).strict(),
  z.object({ status: z.literal('unavailable'), reason: z.string().min(1) }).strict(),
]));
export const PROMPT_INVOCATION_CREATE_ACTION_SPECS = [{
  id: 'prompts.invocation.create', title: 'Create a prompt shortcut',
  description: 'Add a slash shortcut to an existing prompt document in the admitted Account. Uses the current invocations catalog, canonical token validation and revision CAS; conflicts are not retried.',
  safety: 'danger', sideEffectClass: 'write', executionPlacement: 'client', placements: [],
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: false, rpc: false },
  bindings: { mcpToolName: 'prompts_invocation_create' },
  inputSchema: PromptInvocationCreateInputSchema, outputSchema: PromptInvocationCreateOutputSchema,
  inputHints: { fields: [
    { path: 'token', title: 'Slash shortcut', widget: 'text', required: true },
    { path: 'title', title: 'Title', widget: 'text', required: true },
    { path: 'target', title: 'Prompt document reference', widget: 'json', required: true },
    { path: 'behavior', title: 'Insertion behavior', widget: 'text' },
    { path: 'allowArgs', title: 'Allow arguments', widget: 'boolean' },
    { path: 'availableIn', title: 'Availability', widget: 'text' },
  ] },
}] as const satisfies readonly PreNormalizedActionSpec[];
