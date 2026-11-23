import { lazyActionSpecArray } from '../../lazyActionSpecValue.js';
import { z } from '../../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { PendingLocalIdSchema } from '../../../sessions/pending/pendingLocalId.js';
import { SessionIdSchema } from '../../../sessions/idsV1.js';
import { asProtocolZod } from '../../../plugins/actions/internalProtocolZodAdapter.js';
import { RawIngressStructuredInputV1Schema, HappierStructuredInputV1Schema } from '../../../runtime/input/structuredInputV1.js';
import type { PreNormalizedActionSpec } from '../definition.js';

/** Complete editable content, before daemon attachment/media admission. Prepared custody is never caller input. */
export const SessionPendingEditInputV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: asProtocolZod(SessionIdSchema),
  localId: PendingLocalIdSchema,
  text: z.string(),
  structuredInput: RawIngressStructuredInputV1Schema,
  replacementLocalId: z.optional(PendingLocalIdSchema),
}));
export const SessionPendingEditResultV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.literal('accepted'),
  localId: PendingLocalIdSchema,
  structuredInput: HappierStructuredInputV1Schema,
  settlement: z.enum(['complete', 'failed']),
}));
export type SessionPendingEditInputV1 = z.infer<typeof SessionPendingEditInputV1Schema>;
export type SessionPendingEditResultV1 = z.infer<typeof SessionPendingEditResultV1Schema>;

export const SessionPendingRetryInputV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: asProtocolZod(SessionIdSchema),
  localId: PendingLocalIdSchema,
}));
export const SessionPendingRetryResultV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.literal('retry_requested'),
}));
export type SessionPendingRetryInputV1 = z.infer<typeof SessionPendingRetryInputV1Schema>;

function createSessionPendingEditActionSpecs() {
  return [{
  id: 'session.pending.edit', approval: { result: 'required' },
  clientPresenter: 'session',
  title: 'Edit queued message',
  description: 'Replace an exact queued message through the answering client’s existing Composer admission and Pending writer. Requires a connected client with the pending input loaded.',
  safety: 'safe', sideEffectClass: 'write', executionPlacement: 'client',
  approvalPolicy: { uiConfirmation: 'direct' }, placements: ['pending_messages'],
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
  bindings: { mcpToolName: 'session_pending_edit' },
  cli: { acceptsServerId: true, commands: [{ path: ['session', 'pending', 'edit'], visibility: 'canonical' }] },
  inputSchema: SessionPendingEditInputV1Schema, outputSchema: SessionPendingEditResultV1Schema,
  inputHints: { fields: [
    { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
    { path: 'localId', title: 'Pending message local id', widget: 'text', required: true },
    { path: 'text', title: 'Replacement text', widget: 'text', required: true },
    { path: 'structuredInput', title: 'Complete references and attachments', widget: 'json', required: true,
      description: 'Supply the full raw structured-input snapshot; empty collections remove the previous selection. Attachment and media preparation remains daemon-owned.' },
    { path: 'replacementLocalId', title: 'Replacement admission id', widget: 'text',
      description: 'Retain this id when retrying the same prepared attachment edit. The owner allocates one when attachments need an identity and none was supplied.' },
  ] },
}, {
  id: 'session.pending.retry', approval: { result: 'required' },
  clientPresenter: 'session',
  title: 'Retry queued message',
  description: 'Ask the originating Happier client to retry its exact device-local outbox operation. The result acknowledges the retry request. Delivery continues through the existing outbox.',
  safety: 'safe', sideEffectClass: 'write', executionPlacement: 'client',
  approvalPolicy: { uiConfirmation: 'direct' }, placements: ['pending_messages'],
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
  bindings: { mcpToolName: 'session_pending_retry' },
  cli: { acceptsServerId: true, commands: [{ path: ['session', 'pending', 'retry'], visibility: 'canonical' }] },
  inputSchema: SessionPendingRetryInputV1Schema, outputSchema: SessionPendingRetryResultV1Schema,
  inputHints: { fields: [
    { path: 'sessionId', title: 'Session id', widget: 'text', required: true },
    { path: 'localId', title: 'Pending message local id', widget: 'text', required: true },
  ] },
}] as const satisfies readonly PreNormalizedActionSpec[];
}

export const SESSION_PENDING_EDIT_ACTION_SPECS: ReturnType<typeof createSessionPendingEditActionSpecs> = lazyActionSpecArray(createSessionPendingEditActionSpecs);
