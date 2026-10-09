import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { EntityDragScopeV1Schema, EntityDragSessionAddressV1Schema } from '../plugins/ui/entityDragDrop.js';
import type { PreNormalizedActionSpec } from './actionSpecs.js';

export const WorkflowConversationBindInputV1Schema = lazyZodSchema(() => z.object({
  scope: EntityDragScopeV1Schema,
  draftId: z.string().trim().min(1),
  stepId: z.string().trim().min(1).nullable(),
  address: EntityDragSessionAddressV1Schema,
}).strict());
export const WorkflowConversationBindResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({ status: z.literal('applied') }).strict(),
  z.object({ status: z.literal('unchanged') }).strict(),
  z.object({ status: z.literal('unavailable') }).strict(),
  z.object({ status: z.literal('refused'), reason: z.string().min(1) }).strict(),
]));
export type WorkflowConversationBindInputV1 = z.infer<typeof WorkflowConversationBindInputV1Schema>;
export type WorkflowConversationBindResultV1 = z.infer<typeof WorkflowConversationBindResultV1Schema>;
export const WORKFLOW_AUTHORING_ACTION_SPECS = [{
  id: 'workflow.authoring.conversation.bind', title: 'Bind Workflow conversation',
  description: 'Bind a current existing Session to a step (or the default with stepId null) in the answering mounted Workflow draft. This authors one change; it does not save, start the Workflow or submit text.',
  safety: 'safe', sideEffectClass: 'external', executionPlacement: 'client', placements: [],
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: false, rpc: false },
  bindings: { mcpToolName: 'workflow_authoring_conversation_bind' },
  inputSchema: WorkflowConversationBindInputV1Schema, outputSchema: WorkflowConversationBindResultV1Schema,
  inputHints: { fields: [
    { path: 'scope', title: 'Home and Account', widget: 'json', required: true },
    { path: 'draftId', title: 'Mounted Workflow draft id', widget: 'text', required: true },
    { path: 'stepId', title: 'Agent step id (null for Workflow default)', widget: 'json', required: true },
    { path: 'address', title: 'Qualified Session address', widget: 'json', required: true },
  ] },
}] as const satisfies readonly PreNormalizedActionSpec[];
