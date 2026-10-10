import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { EntityDragScopeV1Schema } from '../plugins/ui/entityDragDrop.js';
import { ParticipantExecutionRunRecipientRoutingIdentityV1Schema } from '../messages/structured/participantMessageV1.js';
import { AnchoredListPositionV1Schema } from './anchoredListOrderV1.js';
import type { PreNormalizedActionSpec } from './actionSpecs.js';

const id = z.string().trim().min(1);
// V1 mutation envelopes, including routing, scope and anchors, are closed.
export const TodoReorderInputV1Schema = lazyZodSchema(() => z.object({
  scope: EntityDragScopeV1Schema, sourceId: id, position: AnchoredListPositionV1Schema,
}).strict());
export const PendingReorderInputV1Schema = lazyZodSchema(() => TodoReorderInputV1Schema.extend({
  sessionId: id,
  // Main is explicit null; a selected Run never supplies a missing recipient.
  recipient: ParticipantExecutionRunRecipientRoutingIdentityV1Schema.nullable(),
}).strict());
export const ListReorderOutputV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({ status: z.literal('applied') }).strict(),
  z.object({ status: z.literal('unavailable') }).strict(),
  z.object({ status: z.literal('refused'), reason: id }).strict(),
  z.object({ status: z.literal('unknown'), reason: id }).strict(),
]));
export type TodoReorderInputV1 = z.infer<typeof TodoReorderInputV1Schema>;
export type PendingReorderInputV1 = z.infer<typeof PendingReorderInputV1Schema>;
export type ListReorderOutputV1 = z.infer<typeof ListReorderOutputV1Schema>;

const shared = {
  safety: 'safe', sideEffectClass: 'write', requiredAuthority: 'account_automation', executionPlacement: 'client',
  placements: [], surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
  outputSchema: ListReorderOutputV1Schema,
  inputHints: { fields: [
    { path: 'scope', title: 'Home and Account', widget: 'json', required: true },
    { path: 'sourceId', title: 'Item', widget: 'text', required: true },
    { path: 'position', title: 'Current anchor', widget: 'json', required: true },
  ] },
} as const;
export const LIST_REORDER_ACTION_SPECS = [
  { ...shared, id: 'session.pending.reorder', title: 'Reorder pending input',
    cli: { commands: [{ path: ['session', 'pending', 'reorder'], visibility: 'canonical' }] },
    description: 'Move pending input relative to current membership of an exact Session and recipient queue. Does not transfer input custody or recipients.',
    inputHints: { fields: [
      ...shared.inputHints.fields,
      { path: 'sessionId', title: 'Session', widget: 'text', required: true },
      { path: 'recipient', title: 'Recipient (null for Main)', widget: 'json', required: true },
    ] },
    bindings: { mcpToolName: 'session_pending_reorder' }, inputSchema: PendingReorderInputV1Schema },
  { ...shared, id: 'todos.reorder', title: 'Reorder undone todo',
    cli: { commands: [{ path: ['todos', 'reorder'], visibility: 'canonical' }] },
    description: 'Move an undone todo relative to current undone membership. Does not change completion status.',
    bindings: { mcpToolName: 'todos_reorder' }, inputSchema: TodoReorderInputV1Schema },
] as const satisfies readonly PreNormalizedActionSpec[];
