import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { EntityDragScopeV1Schema, EntityDragSessionAddressV1Schema } from '../plugins/ui/entityDragDrop.js';
import type { PreNormalizedActionSpec } from './actionSpecs.js';
import { WorkflowDefinitionEditOpV1Schema } from '../workflows/workflowDefinitionEditV1.js';
import { WorkflowValidationIssueV1Schema } from '../workflows/workflowV1.js';
import { WorkflowProjectTargetV1Schema } from '../workflows/workflowWorkspaceV1.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { WorkflowRunIdV1Schema } from '../workflows/workflowIdsV1.js';
import { WorkflowDecimalV1Schema } from '../workflows/workflowProgressV1.js';
export {
  WORKFLOW_AUTHORING_ACTION_IDS,
  isWorkflowAuthoringActionId,
  type WorkflowAuthoringActionId,
} from './workflowAuthoringActionIds.js';

const draftAddress = { scope: EntityDragScopeV1Schema, draftId: z.string().trim().min(1) };
export const WorkflowDraftAddressV1Schema = lazyZodSchema(() => z.object(draftAddress).strict());
export const WorkflowDraftGetInputV1Schema = lazyZodSchema(() => z.object({
  scope: EntityDragScopeV1Schema, draftId: draftAddress.draftId.optional(),
}).strict());
export const WorkflowDraftEditInputV1Schema = lazyZodSchema(() => z.object({
  ...draftAddress, expectedDraftRevision: z.number().int().nonnegative(), ops: z.array(WorkflowDefinitionEditOpV1Schema).min(1),
}).strict());
export const WorkflowReviewDraftSetInputV1Schema = lazyZodSchema(() => z.object({
  ...draftAddress, runId: WorkflowRunIdV1Schema, expectedContentRevision: WorkflowDecimalV1Schema,
  value: StrictJsonValueSchema,
}).strict());
export const WorkflowDraftMutationResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({ status: z.literal('applied'), draftRevision: z.number().int().nonnegative().optional(),
    changedBlockIds: z.array(z.string()).optional() }).strict(),
  z.object({ status: z.literal('unchanged'), draftRevision: z.number().int().nonnegative().optional() }).strict(),
  z.object({ status: z.literal('unavailable') }).strict(),
  z.object({ status: z.literal('refused'), reason: z.string().min(1), draftRevision: z.number().int().nonnegative().optional() }).strict(),
]));
// A draft can contain incomplete groups and invalid settings. This read is raw JSON,
// not saved-definition admission; the existing validator supplies its repair issues.
export const WorkflowMountedDraftV1Schema = lazyZodSchema(() => z.object({
  scope: EntityDragScopeV1Schema, draftId: draftAddress.draftId, name: z.string(),
  definition: StrictJsonValueSchema,
  blockLabels: z.array(z.object({ id: z.string(), label: z.string() }).strict()),
  settings: z.object({ description: z.string(), projectTarget: WorkflowProjectTargetV1Schema.nullable(),
    executionTarget: z.enum(['session', 'detached_run']), triggers: StrictJsonValueSchema }).strict(),
  validationIssues: z.array(WorkflowValidationIssueV1Schema), dirty: z.boolean(), draftRevision: z.number().int().nonnegative(),
}).strict());
export const WorkflowDraftGetResultV1Schema = lazyZodSchema(() => z.union([
  z.object({ status: z.literal('available'), drafts: z.array(WorkflowMountedDraftV1Schema) }).strict(),
  WorkflowDraftMutationResultV1Schema,
]));
export type WorkflowDraftEditInputV1 = z.infer<typeof WorkflowDraftEditInputV1Schema>;
export type WorkflowReviewDraftSetInputV1 = z.infer<typeof WorkflowReviewDraftSetInputV1Schema>;
export type WorkflowDraftMutationResultV1 = z.infer<typeof WorkflowDraftMutationResultV1Schema>;
export type WorkflowMountedDraftV1 = z.infer<typeof WorkflowMountedDraftV1Schema>;
export type WorkflowDraftGetResultV1 = z.infer<typeof WorkflowDraftGetResultV1Schema>;

const mountedSurfaces = { ui: true, voice: true, agent: true, mcp: true, cli: false, rpc: false } as const;
const addressHints = [
  { path: 'scope', title: 'Home and Account', widget: 'json', required: true },
  { path: 'draftId', title: 'Mounted draft id', widget: 'text', required: true },
] as const;
const addressExample = '{"scope":{"serverId":"home-a","accountId":"account-a"},"draftId":"draft-a"}';
const editExample = '{"scope":{"serverId":"home-a","accountId":"account-a"},"draftId":"draft-a","expectedDraftRevision":0,"ops":[{"kind":"set_step_prompt","blockId":"step-a","text":"Review this change"}]}';
const reviewExample = '{"scope":{"serverId":"home-a","accountId":"account-a"},"draftId":"invocation-a","runId":"run-a","expectedContentRevision":"7","value":"Reviewed value"}';

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
  cli: { commands: [{ path: ['workflow', 'authoring', 'conversation', 'bind'], visibility: 'canonical' }] },
  description: 'Bind a current existing Session to a step (or the default with stepId null) in the answering mounted Workflow draft. This authors one change; it does not save, start the Workflow or submit text.',
  safety: 'safe', sideEffectClass: 'external', executionPlacement: 'client', placements: [],
  surfaces: { ...mountedSurfaces, voice: false, cli: true },
  bindings: { mcpToolName: 'workflow_authoring_conversation_bind' },
  inputSchema: WorkflowConversationBindInputV1Schema, outputSchema: WorkflowConversationBindResultV1Schema,
  inputHints: { fields: [
    { path: 'scope', title: 'Home and Account', widget: 'json', required: true },
    { path: 'draftId', title: 'Mounted Workflow draft id', widget: 'text', required: true },
    { path: 'stepId', title: 'Agent step id (null for Workflow default)', widget: 'json', required: true },
    { path: 'address', title: 'Qualified Session address', widget: 'json', required: true },
  ] },
}, {
  id: 'workflow.authoring.draft.get', title: 'Read mounted Workflow draft',
  description: 'Read the answering client’s open Workflow draft, settings, validation and revision. Omit draftId to list drafts in the scope. Never loads or creates an editor.',
  safety: 'safe', sideEffectClass: 'read', executionPlacement: 'client', placements: [], surfaces: mountedSurfaces,
  bindings: { mcpToolName: 'workflow_authoring_draft_get', voiceClientToolName: 'readWorkflowDraft' },
  inputSchema: WorkflowDraftGetInputV1Schema, outputSchema: WorkflowDraftGetResultV1Schema,
  inputHints: { fields: [{ ...addressHints[0] }, { ...addressHints[1], required: false }] },
  examples: { mcp: { argsExample: addressExample }, voice: { argsExample: addressExample } },
}, {
  id: 'workflow.authoring.draft.edit', title: 'Edit mounted Workflow draft',
  description: 'Apply canonical Workflow edit ops to the open draft at expectedDraftRevision as one undoable, visibly highlighted change. A stale revision is refused. Does not save or run.',
  safety: 'safe', sideEffectClass: 'external', executionPlacement: 'client', placements: [], surfaces: mountedSurfaces,
  bindings: { mcpToolName: 'workflow_authoring_draft_edit', voiceClientToolName: 'editWorkflowDraft' },
  inputSchema: WorkflowDraftEditInputV1Schema, outputSchema: WorkflowDraftMutationResultV1Schema,
  inputHints: { fields: [...addressHints, { path: 'expectedDraftRevision', title: 'Observed draft revision', widget: 'number', required: true },
    { path: 'ops', title: 'Canonical Workflow edit operations', widget: 'json', required: true }] },
  examples: { mcp: { argsExample: editExample }, voice: { argsExample: editExample } },
}, {
  id: 'workflow.authoring.draft.undo', title: 'Undo Workflow draft change',
  description: 'Undo through the mounted editor’s existing document and settings history. Does not save or run.',
  safety: 'safe', sideEffectClass: 'external', executionPlacement: 'client', placements: [], surfaces: mountedSurfaces,
  bindings: { mcpToolName: 'workflow_authoring_draft_undo', voiceClientToolName: 'undoWorkflowDraft' },
  inputSchema: WorkflowDraftAddressV1Schema, outputSchema: WorkflowDraftMutationResultV1Schema,
  inputHints: { fields: addressHints }, examples: { mcp: { argsExample: addressExample }, voice: { argsExample: addressExample } },
}, {
  id: 'workflow.authoring.draft.redo', title: 'Redo Workflow draft change',
  description: 'Redo through the mounted editor’s existing document and settings history. Does not save or run.',
  safety: 'safe', sideEffectClass: 'external', executionPlacement: 'client', placements: [], surfaces: mountedSurfaces,
  bindings: { mcpToolName: 'workflow_authoring_draft_redo', voiceClientToolName: 'redoWorkflowDraft' },
  inputSchema: WorkflowDraftAddressV1Schema, outputSchema: WorkflowDraftMutationResultV1Schema,
  inputHints: { fields: addressHints }, examples: { mcp: { argsExample: addressExample }, voice: { argsExample: addressExample } },
}, {
  id: 'workflow.authoring.draft.save', title: 'Save mounted Workflow draft',
  description: 'Explicitly save through the mounted host’s validation and conflict-checked Save, including its trigger delta. Waits for Save to finish; never starts a Run.',
  safety: 'safe', sideEffectClass: 'write', executionPlacement: 'client', placements: [], surfaces: mountedSurfaces,
  bindings: { mcpToolName: 'workflow_authoring_draft_save', voiceClientToolName: 'saveWorkflowDraft' },
  inputSchema: WorkflowDraftAddressV1Schema, outputSchema: WorkflowDraftMutationResultV1Schema,
  inputHints: { fields: addressHints }, examples: { mcp: { argsExample: addressExample }, voice: { argsExample: addressExample } },
}, {
  id: 'workflow.authoring.draft.discard', title: 'Discard mounted Workflow edits',
  description: 'Request human approval, then follow the host’s existing Discard confirmation. Cancel keeps the draft. A saved document stays open and Discard changes is undoable.',
  safety: 'danger', requiredAuthority: 'present_user', sideEffectClass: 'external', executionPlacement: 'client', placements: [], surfaces: mountedSurfaces,
  bindings: { mcpToolName: 'workflow_authoring_draft_discard', voiceClientToolName: 'discardWorkflowDraft' },
  inputSchema: WorkflowDraftAddressV1Schema, outputSchema: WorkflowDraftMutationResultV1Schema,
  inputHints: { fields: addressHints }, examples: { mcp: { argsExample: addressExample }, voice: { argsExample: addressExample } },
}, {
  id: 'workflow.run.review.draft.set', title: 'Prepare open Workflow review value',
  description: 'Set the displayed human review buffer of the exact open hold at expectedContentRevision. Retains Keep my edits / Use newer semantics. Does not publish or accept the result.',
  safety: 'safe', sideEffectClass: 'external', executionPlacement: 'client', placements: [], surfaces: mountedSurfaces,
  bindings: { mcpToolName: 'workflow_run_review_draft_set', voiceClientToolName: 'prepareWorkflowReviewValue' },
  inputSchema: WorkflowReviewDraftSetInputV1Schema, outputSchema: WorkflowDraftMutationResultV1Schema,
  inputHints: { fields: [...addressHints, { path: 'runId', title: 'Open Run id', widget: 'text', required: true },
    { path: 'expectedContentRevision', title: 'Observed hold content revision', widget: 'text', required: true },
    { path: 'value', title: 'Proposed review value', widget: 'json', required: true }] },
  examples: { mcp: { argsExample: reviewExample }, voice: { argsExample: reviewExample } },
}] as const satisfies readonly PreNormalizedActionSpec[];
