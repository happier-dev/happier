import { lazyActionSpecArray } from './lazyActionSpecValue.js';
import * as zMini from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { EntityDragScopeV1Schema, EntityDragSessionAddressV1Schema } from '../plugins/ui/entityDragDrop.js';
import type { PreNormalizedActionSpec } from './actionSpecs.js';
import { WorkflowDefinitionEditOpV1Schema } from '../workflows/workflowDefinitionEditV1.js';
import { WorkflowValidationIssueV1Schema } from '../workflows/workflowV1.js';
import { WorkflowProjectTargetV1Schema } from '../workflows/workflowWorkspaceV1.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { WorkflowRunIdV1Schema } from '../workflows/workflowIdsV1.js';
import { WorkflowDecimalV1Schema } from '../workflows/workflowProgressV1.js';
import { AutomationTriggerDefinitionInputSchema } from '../automations/automationTriggerDefinition.js';
import { PluginJsonSchemaV2Schema } from '../plugins/contributions/publicTypes.js';
import { AutomationTriggerIdSchema } from '../automations/automationTriggerIdentity.js';
import { AutomationStoredWorkflowDefinitionV2Schema } from '../automations/automationWorkflowRecipeV2.js';
export {
  WORKFLOW_AUTHORING_ACTION_IDS,
  isWorkflowAuthoringActionId,
  workflowDraftClientRpcMethod,
  isWorkflowDraftClientRpcMethod,
  type WorkflowAuthoringActionId,
} from './workflowAuthoringActionIds.js';

const draftAddress = { scope: EntityDragScopeV1Schema, draftId: z.string().check(z.trim(), z.minLength(1)) };
export const WorkflowDraftAddressV1Schema = lazyZodSchema(() => z.strictObject(draftAddress));
export const WorkflowDraftGetInputV1Schema = lazyZodSchema(() => z.strictObject({
  scope: EntityDragScopeV1Schema, draftId: z.optional(draftAddress.draftId),
}));
/** The desired trigger rows read by the mounted editor, not a persisted trigger writer. */
export const WorkflowDraftTriggerSnapshotV1Schema = lazyZodSchema(() => z.strictObject({
  rows: z.array(z.strictObject({
    identity: z.strictObject({ clientId: z.string().check(z.minLength(1)), triggerId: zMini.optional(AutomationTriggerIdSchema) }),
    trigger: zMini.nullable(AutomationTriggerDefinitionInputSchema), enabled: z.boolean(),
    /** Declaration metadata for local Event drafts and their Undo/Redo snapshots. */
    payloadSchema: z.optional(z.nullable(PluginJsonSchemaV2Schema)),
  })).check(z.refine(rows => {
    const clients = new Set(rows.map(row => row.identity.clientId));
    const savedIds = rows.flatMap(row => row.identity.triggerId ? [row.identity.triggerId] : []);
    return clients.size === rows.length && new Set(savedIds).size === savedIds.length
      && rows.every(row => row.trigger === null || row.trigger.enabled === row.enabled);
  })),
  project: zMini.nullable(WorkflowProjectTargetV1Schema), inputs: z.record(z.string(), StrictJsonValueSchema),
  roleOverrides: AutomationStoredWorkflowDefinitionV2Schema.shape.roleOverrides,
  visibleTeamId: AutomationStoredWorkflowDefinitionV2Schema.shape.visibleTeamId,
}));
export const WorkflowDraftSettingsV1Schema = lazyZodSchema(() => z.strictObject({
  description: z.string(), projectTarget: zMini.nullable(WorkflowProjectTargetV1Schema),
  executionTarget: z.enum(['session', 'detached_run']), triggers: WorkflowDraftTriggerSnapshotV1Schema,
}));
export const WorkflowDraftSettingsPatchV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.partial(WorkflowDraftSettingsV1Schema)));
export const WorkflowDraftEditInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...draftAddress, expectedDraftRevision: z.number().check(z.int(), z.nonnegative()),
  ops: z.optional(z.array(WorkflowDefinitionEditOpV1Schema)), settings: z.optional(WorkflowDraftSettingsPatchV1Schema),
}).check(z.refine(input => (input.ops?.length ?? 0) > 0 || Object.keys(input.settings ?? {}).length > 0)));
export const WorkflowReviewDraftSetInputV1Schema = lazyZodSchema(() => {
  const address = { ...draftAddress, runId: WorkflowRunIdV1Schema, expectedContentRevision: WorkflowDecimalV1Schema };
  return z.union([
    z.strictObject({ ...address, value: StrictJsonValueSchema }),
    z.strictObject({ ...address, operation: z.enum(['clear', 'show_newer']) }),
  ]);
});
export const WorkflowDraftMutationResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('applied'), draftRevision: z.optional(z.number().check(z.int(), z.nonnegative())),
    changedBlockIds: z.optional(z.array(z.string())) }),
  z.strictObject({ status: z.literal('unchanged'), draftRevision: z.optional(z.number().check(z.int(), z.nonnegative())) }),
  z.strictObject({ status: z.literal('unavailable') }),
  z.strictObject({ status: z.literal('refused'), reason: z.string().check(z.minLength(1)), draftRevision: z.optional(z.number().check(z.int(), z.nonnegative())) }),
]));
// A draft can contain incomplete groups and invalid settings. This read is raw JSON,
// not saved-definition admission; the existing validator supplies its repair issues.
export const WorkflowMountedDraftV1Schema = lazyZodSchema(() => z.strictObject({
  scope: EntityDragScopeV1Schema, draftId: draftAddress.draftId, name: z.string(),
  definition: StrictJsonValueSchema,
  blockLabels: z.array(z.strictObject({ id: z.string(), label: z.string() })),
  settings: WorkflowDraftSettingsV1Schema,
  validationIssues: z.array(WorkflowValidationIssueV1Schema), dirty: z.boolean(), draftRevision: z.number().check(z.int(), z.nonnegative()),
}));
export const WorkflowDraftGetResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('available'), drafts: z.array(WorkflowMountedDraftV1Schema) }),
  WorkflowDraftMutationResultV1Schema,
]));
export type WorkflowDraftEditInputV1 = z.infer<typeof WorkflowDraftEditInputV1Schema>;
export type WorkflowDraftSettingsPatchV1 = z.infer<typeof WorkflowDraftSettingsPatchV1Schema>;
export type WorkflowDraftTriggerSnapshotV1 = z.infer<typeof WorkflowDraftTriggerSnapshotV1Schema>;
export type WorkflowReviewDraftSetInputV1 = z.infer<typeof WorkflowReviewDraftSetInputV1Schema>;
export type WorkflowDraftMutationResultV1 = z.infer<typeof WorkflowDraftMutationResultV1Schema>;
export type WorkflowMountedDraftV1 = z.infer<typeof WorkflowMountedDraftV1Schema>;
export type WorkflowDraftGetResultV1 = z.infer<typeof WorkflowDraftGetResultV1Schema>;

const mountedSurfaces = { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false } as const;
const addressHints = [
  { path: 'scope', title: 'Home and Account', widget: 'json', required: true },
  { path: 'draftId', title: 'Mounted draft id', widget: 'text', required: true },
] as const;
const addressExample = '{"scope":{"serverId":"home-a","accountId":"account-a"},"draftId":"draft-a"}';
const editExample = '{"scope":{"serverId":"home-a","accountId":"account-a"},"draftId":"draft-a","expectedDraftRevision":0,"ops":[{"kind":"set_step_prompt","blockId":"step-a","text":"Review this change"}]}';
const reviewExample = '{"scope":{"serverId":"home-a","accountId":"account-a"},"draftId":"invocation-a","runId":"run-a","expectedContentRevision":"7","value":"Reviewed value"}';

export const WorkflowConversationBindInputV1Schema = lazyZodSchema(() => z.strictObject({
  scope: EntityDragScopeV1Schema,
  draftId: z.string().check(z.trim(), z.minLength(1)),
  stepId: z.nullable(z.string().check(z.trim(), z.minLength(1))),
  address: EntityDragSessionAddressV1Schema,
}));
export const WorkflowConversationBindResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('applied') }),
  z.strictObject({ status: z.literal('unchanged') }),
  z.strictObject({ status: z.literal('unavailable') }),
  z.strictObject({ status: z.literal('refused'), reason: z.string().check(z.minLength(1)) }),
]));
export type WorkflowConversationBindInputV1 = z.infer<typeof WorkflowConversationBindInputV1Schema>;
export type WorkflowConversationBindResultV1 = z.infer<typeof WorkflowConversationBindResultV1Schema>;
function createWorkflowAuthoringActionSpecs() {
  return [{
  id: 'workflow.authoring.conversation.bind', approval: {result: 'required'}, title: 'Bind Workflow conversation',
  cli: { commands: [{ path: ['workflow', 'authoring', 'conversation', 'bind'], visibility: 'canonical' }] },
  description: 'Bind a current existing Session to a step (or the default with stepId null) in the answering mounted Workflow draft. This authors one change; it does not save, start the Workflow or submit text.',
  safety: 'safe', sideEffectClass: 'external', executionPlacement: 'client', placements: [],
  surfaces: { ...mountedSurfaces, cli: true },
  bindings: { mcpToolName: 'workflow_authoring_conversation_bind', voiceClientToolName: 'workflow_authoring_conversation_bind' },
  inputSchema: WorkflowConversationBindInputV1Schema, outputSchema: WorkflowConversationBindResultV1Schema,
  inputHints: { fields: [
    { path: 'scope', title: 'Home and Account', widget: 'json', required: true },
    { path: 'draftId', title: 'Mounted Workflow draft id', widget: 'text', required: true },
    { path: 'stepId', title: 'Agent step id (null for Workflow default)', widget: 'json', required: true },
    { path: 'address', title: 'Qualified Session address', widget: 'json', required: true },
  ] },
}, {
  id: 'workflow.authoring.draft.get', approval: {result: 'required'}, title: 'Read mounted Workflow draft',
  cli: { commands: [{ path: ['workflow', 'authoring', 'draft', 'get'], visibility: 'canonical' }] },
  description: 'Read the answering client’s open Workflow draft, settings, validation and revision. Omit draftId to list drafts in the scope. Never loads or creates an editor.',
  safety: 'safe', sideEffectClass: 'read', executionPlacement: 'client', placements: [], surfaces: mountedSurfaces,
  bindings: { mcpToolName: 'workflow_authoring_draft_get', voiceClientToolName: 'readWorkflowDraft' },
  inputSchema: WorkflowDraftGetInputV1Schema, outputSchema: WorkflowDraftGetResultV1Schema,
  inputHints: { fields: [{ ...addressHints[0] }, { ...addressHints[1], required: false }] },
  examples: { mcp: { argsExample: addressExample }, voice: { argsExample: addressExample } },
}, {
  id: 'workflow.authoring.draft.edit', approval: {result: 'required'}, title: 'Edit mounted Workflow draft',
  cli: { commands: [{ path: ['workflow', 'authoring', 'draft', 'edit'], visibility: 'canonical' }] },
  description: 'Apply canonical Workflow edit ops and/or a settings patch (description, projectTarget, executionTarget, triggers) to the open draft at expectedDraftRevision as one undoable change. A stale revision is refused. Changed blocks are highlighted. Does not save or run.',
  safety: 'safe', sideEffectClass: 'external', executionPlacement: 'client', placements: [], surfaces: mountedSurfaces,
  bindings: { mcpToolName: 'workflow_authoring_draft_edit', voiceClientToolName: 'editWorkflowDraft' },
  inputSchema: WorkflowDraftEditInputV1Schema, outputSchema: WorkflowDraftMutationResultV1Schema,
  inputHints: { fields: [...addressHints, { path: 'expectedDraftRevision', title: 'Observed draft revision', widget: 'number', required: true },
    { path: 'ops', title: 'Canonical Workflow edit operations', widget: 'json', required: false },
    { path: 'settings', title: 'Mounted draft settings patch', widget: 'json', required: false }] },
  examples: { mcp: { argsExample: editExample }, voice: { argsExample: editExample } },
}, {
  id: 'workflow.authoring.draft.undo', approval: {result: 'required'}, title: 'Undo Workflow draft change',
  cli: { commands: [{ path: ['workflow', 'authoring', 'draft', 'undo'], visibility: 'canonical' }] },
  description: 'Undo through the mounted editor’s existing document and settings history. Does not save or run.',
  safety: 'safe', sideEffectClass: 'external', executionPlacement: 'client', placements: [], surfaces: mountedSurfaces,
  bindings: { mcpToolName: 'workflow_authoring_draft_undo', voiceClientToolName: 'undoWorkflowDraft' },
  inputSchema: WorkflowDraftAddressV1Schema, outputSchema: WorkflowDraftMutationResultV1Schema,
  inputHints: { fields: addressHints }, examples: { mcp: { argsExample: addressExample }, voice: { argsExample: addressExample } },
}, {
  id: 'workflow.authoring.draft.redo', approval: {result: 'required'}, title: 'Redo Workflow draft change',
  cli: { commands: [{ path: ['workflow', 'authoring', 'draft', 'redo'], visibility: 'canonical' }] },
  description: 'Redo through the mounted editor’s existing document and settings history. Does not save or run.',
  safety: 'safe', sideEffectClass: 'external', executionPlacement: 'client', placements: [], surfaces: mountedSurfaces,
  bindings: { mcpToolName: 'workflow_authoring_draft_redo', voiceClientToolName: 'redoWorkflowDraft' },
  inputSchema: WorkflowDraftAddressV1Schema, outputSchema: WorkflowDraftMutationResultV1Schema,
  inputHints: { fields: addressHints }, examples: { mcp: { argsExample: addressExample }, voice: { argsExample: addressExample } },
}, {
  id: 'workflow.authoring.draft.save', approval: {result: 'required'}, title: 'Save mounted Workflow draft',
  cli: { commands: [{ path: ['workflow', 'authoring', 'draft', 'save'], visibility: 'canonical' }] },
  description: 'Explicitly save through the mounted host’s validation and conflict-checked Save, including its trigger delta. Waits for Save to finish; never starts a Run.',
  safety: 'safe', sideEffectClass: 'write', executionPlacement: 'client', placements: [], surfaces: mountedSurfaces,
  bindings: { mcpToolName: 'workflow_authoring_draft_save', voiceClientToolName: 'saveWorkflowDraft' },
  inputSchema: WorkflowDraftAddressV1Schema, outputSchema: WorkflowDraftMutationResultV1Schema,
  inputHints: { fields: addressHints }, examples: { mcp: { argsExample: addressExample }, voice: { argsExample: addressExample } },
}, {
  id: 'workflow.authoring.draft.discard', approval: {result: 'required'}, title: 'Discard mounted Workflow edits',
  cli: { commands: [{ path: ['workflow', 'authoring', 'draft', 'discard'], visibility: 'canonical' }] },
  // The mounted editor already confirms Discard and preserves saved-draft Undo.
  approvalPolicy: { uiConfirmation: 'direct' },
  description: 'Request human approval, then follow the host’s existing Discard confirmation. Cancel keeps the draft. A saved document stays open and Discard changes is undoable.',
  safety: 'danger', requiredAuthority: 'present_user', sideEffectClass: 'external', executionPlacement: 'client', placements: [], surfaces: mountedSurfaces,
  bindings: { mcpToolName: 'workflow_authoring_draft_discard', voiceClientToolName: 'discardWorkflowDraft' },
  inputSchema: WorkflowDraftAddressV1Schema, outputSchema: WorkflowDraftMutationResultV1Schema,
  inputHints: { fields: addressHints }, examples: { mcp: { argsExample: addressExample }, voice: { argsExample: addressExample } },
}, {
  id: 'workflow.run.review.draft.set', approval: {result: 'required'}, title: 'Prepare open Workflow review value',
  cli: { commands: [{ path: ['workflow', 'run', 'review', 'draft', 'set'], visibility: 'canonical' }] },
  description: 'Prepare the exact open hold at expectedContentRevision: set value, clear edits while keeping the reading, or show_newer to read the latest publication and clear edits. Does not publish or accept the result.',
  safety: 'safe', sideEffectClass: 'external', executionPlacement: 'client', placements: [], surfaces: mountedSurfaces,
  bindings: { mcpToolName: 'workflow_run_review_draft_set', voiceClientToolName: 'prepareWorkflowReviewValue' },
  inputSchema: WorkflowReviewDraftSetInputV1Schema, outputSchema: WorkflowDraftMutationResultV1Schema,
  inputHints: { fields: [...addressHints, { path: 'runId', title: 'Open Run id', widget: 'text', required: true },
    { path: 'expectedContentRevision', title: 'Observed hold content revision', widget: 'text', required: true },
    { path: 'value', title: 'Proposed review value (omit for an operation)', widget: 'json', required: false },
    { path: 'operation', title: 'Buffer operation (omit when setting value)', widget: 'select', required: false,
      options: [{ value: 'clear', label: 'Clear edits' }, { value: 'show_newer', label: 'Show newer publication' }] }] },
  examples: { mcp: { argsExample: reviewExample }, voice: { argsExample: reviewExample } },
}] as const satisfies readonly PreNormalizedActionSpec[];
}

export const WORKFLOW_AUTHORING_ACTION_SPECS: ReturnType<typeof createWorkflowAuthoringActionSpecs> = lazyActionSpecArray(createWorkflowAuthoringActionSpecs);
