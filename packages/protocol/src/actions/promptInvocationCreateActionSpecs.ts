import { lazyActionSpecArray } from './lazyActionSpecValue.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { PromptInvocationAvailabilityV1Schema, PromptInvocationBehaviorV1Schema, PromptInvocationTargetV1Schema } from '../prompts/library/promptInvocationsV1.js';
import type { PreNormalizedActionSpec } from './actionSpecs.js';
import { PromptLibraryRowMutationV1Schema } from '../prompts/library/promptLibrarySchemasV1.js';

export { PROMPT_INVOCATION_ACTION_IDS, isPromptInvocationActionId, type PromptInvocationActionId } from './promptInvocationActionIds.js';

export const PromptInvocationCreateInputSchema = lazyZodSchema(() => z.strictObject({
  token: z.string().check(z.trim(), z.minLength(1)), title: z.string().check(z.trim(), z.minLength(1)), target: PromptInvocationTargetV1Schema,
  behavior: z.optional(PromptInvocationBehaviorV1Schema), allowArgs: z.optional(z.boolean()), availableIn: z.optional(PromptInvocationAvailabilityV1Schema),
}));
export const PromptInvocationCreateOutputSchema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('updated'), invocationId: z.string().check(z.minLength(1)), token: z.string().check(z.minLength(1)), revision: z.number().check(z.int(), z.nonnegative()) }),
  z.strictObject({ status: z.literal('invalid'), reason: z.enum(['invalid', 'reserved', 'actionCollision', 'duplicate']) }),
  z.strictObject({ status: z.literal('conflict'), revision: z.number().check(z.int()) }),
  z.strictObject({ status: z.literal('unavailable'), reason: z.string().check(z.minLength(1)) }),
]));
export const PromptInvocationUpdateInputSchema = lazyZodSchema(() => z.extend(PromptInvocationCreateInputSchema, {
  invocationId: z.string().check(z.trim(), z.minLength(1)),
  expectedRevision: PromptLibraryRowMutationV1Schema.shape.expectedRevision,
}));
export const PromptInvocationUpdateOutputSchema = lazyZodSchema(() => z.union([
  PromptInvocationCreateOutputSchema,
  z.strictObject({ status: z.literal('invalid'), reason: z.literal('not_found') }),
]));
export const PromptInvocationDeleteInputSchema = lazyZodSchema(() => z.strictObject({
  invocationId: z.string().check(z.trim(), z.minLength(1)),
  expectedRevision: PromptLibraryRowMutationV1Schema.shape.expectedRevision,
}));
export const PromptInvocationDeleteOutputSchema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('updated'), invocationId: z.string().check(z.minLength(1)), revision: z.number().check(z.int(), z.nonnegative()) }),
  z.strictObject({ status: z.literal('invalid'), reason: z.literal('not_found') }),
  z.strictObject({ status: z.literal('conflict'), revision: z.number().check(z.int()) }),
  z.strictObject({ status: z.literal('unavailable'), reason: z.string().check(z.minLength(1)) }),
]));
// Shortcuts live in the Account catalog. Mounted composers only consume them;
// authoring and approval replay use the same catalog port on every host.
function createPromptInvocationCreateActionSpecs() {
  return [{
  id: 'prompts.invocation.create', approval: {result: 'required'}, title: 'Create a prompt shortcut',
  description: 'Add a slash shortcut to an existing prompt document in the admitted Account. Uses the current invocations catalog, canonical token validation and revision CAS; conflicts are not retried.',
  safety: 'danger', sideEffectClass: 'write', executionPlacement: 'account', placements: [],
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
  cli: { acceptsServerId: true, commands: [] },
  approvalPolicy: { uiConfirmation: 'direct' },
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
}, {
  id: 'prompts.invocation.update', approval: { result: 'required' }, title: 'Edit a prompt shortcut',
  description: 'Update an existing slash shortcut at its observed catalog revision. Read prompts.invocations.list for its target and revision; conflicts are not retried.',
  safety: 'danger', sideEffectClass: 'write', executionPlacement: 'account', placements: [],
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
  cli: { acceptsServerId: true, commands: [] },
  approvalPolicy: { uiConfirmation: 'direct' },
  bindings: { mcpToolName: 'prompts_invocation_update' },
  inputSchema: PromptInvocationUpdateInputSchema, outputSchema: PromptInvocationUpdateOutputSchema,
  inputHints: { fields: [
    { path: 'invocationId', title: 'Shortcut id', widget: 'text', required: true },
    { path: 'expectedRevision', title: 'Catalog revision', widget: 'number', required: true },
    { path: 'token', title: 'Slash shortcut', widget: 'text', required: true },
    { path: 'title', title: 'Title', widget: 'text', required: true },
    { path: 'target', title: 'Prompt document reference', widget: 'json', required: true },
    { path: 'behavior', title: 'Insertion behavior', widget: 'text' },
    { path: 'allowArgs', title: 'Allow arguments', widget: 'boolean' },
    { path: 'availableIn', title: 'Availability', widget: 'text' },
  ] },
}, {
  id: 'prompts.invocation.delete', approval: { result: 'required' }, title: 'Delete a prompt shortcut',
  confirmVerb: { key: 'common.delete', fallback: 'Delete' }, irreversible: true,
  description: 'Remove an existing slash shortcut at its observed catalog revision. The prompt document remains in the library. Conflicts are not retried.',
  safety: 'danger', sideEffectClass: 'write', executionPlacement: 'account', placements: [],
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
  cli: { acceptsServerId: true, commands: [] },
  approvalPolicy: { uiConfirmation: 'policy' },
  approvalPresentation: { summary: () => 'This will delete the template.' },
  bindings: { mcpToolName: 'prompts_invocation_delete' },
  inputSchema: PromptInvocationDeleteInputSchema, outputSchema: PromptInvocationDeleteOutputSchema,
  inputHints: { fields: [
    { path: 'invocationId', title: 'Shortcut id', widget: 'text', required: true },
    { path: 'expectedRevision', title: 'Catalog revision', widget: 'number', required: true },
  ] },
}] as const satisfies readonly PreNormalizedActionSpec[];
}

export const PROMPT_INVOCATION_CREATE_ACTION_SPECS: ReturnType<typeof createPromptInvocationCreateActionSpecs> = lazyActionSpecArray(createPromptInvocationCreateActionSpecs);
