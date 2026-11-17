import type { WorkflowActionIdV1 } from '../actionIds.js';
import type { PreNormalizedActionSpec } from './definition.js';

type WorkflowInputHints = NonNullable<PreNormalizedActionSpec['inputHints']>;
type Field = WorkflowInputHints['fields'][number];

export const WORKFLOW_AUTOMATION_REMOVAL_WARNING = 'Removing this Automation also deletes its past Runs when retention cleanup runs, including Runs set to keep forever.';

const runRevision = {
  path: 'expectedRevision', title: 'Observed Run revision', widget: 'number', required: true,
  description: 'Use run.revision from the current workflow.run.get response. A stale revision is refused; reread before deciding again.',
} as const satisfies Field;
const definitionId = {
  path: 'definitionId', title: 'Saved workflow', widget: 'select', optionsSourceId: 'workflows.references.available', required: true,
  description: 'Use the saved definitionId returned by workflow.definition.list or workflow.definition.get.',
} as const satisfies Field;
const definitionRevision = {
  path: 'expectedRevision', title: 'Observed definition revision', widget: 'json', required: true,
  description: 'Use the complete {headerVersion,bodyVersion} revision returned by workflow.definition.get for this definition. A stale revision is refused; reread before editing.',
} as const satisfies Field;
const definition = {
  path: 'definition', title: 'Authored Workflow definition', widget: 'json', required: true,
  description: 'Use the ordinary Workflow authored grammar accepted by workflow.validate, including blocks, declared inputs and defaults.',
} as const satisfies Field;
const invocation = {
  path: 'invocation', title: 'Exact invocation reference', widget: 'json', required: true,
  description: 'Use {recordId} with the exact invocation record id from the current Run invocation history; do not substitute a block id or another attempt.',
} as const satisfies Field;
const contentRevision = {
  path: 'expectedContentRevision', title: 'Observed invocation content revision', widget: 'text', required: true,
  description: 'Use the decimal-string content revision from workflow.run.invocations.get for this exact invocation. It is distinct from the Run revision.',
} as const satisfies Field;
const reviewFields = [invocation, contentRevision] as const;

const administrativeFields: Readonly<Partial<Record<WorkflowActionIdV1, readonly Field[]>>> = {
  'workflow.validate': [definition, { path: 'inputs', title: 'Declared Workflow inputs', widget: 'json',
    description: 'Values keyed by declared input names; validation does not save a definition or start a Run.' }],
  'workflow.run.list': [
    { path: 'sourceArtifactId', title: 'Saved definition source', widget: 'text', description: 'Filter by the accepted saved definition identity; use workflow.definition.list to discover it.' },
    { path: 'targetSessionId', title: 'Destination Session', widget: 'text', description: 'Filter Runs that write into this Session; this does not change their execution placement.' },
  ],
  'workflow.run.summaries': [
    { path: 'sourceArtifactIds', title: 'Saved definition sources', widget: 'json', description: 'Choose saved-definition summaries with recent, or triggered Workflow summaries with automationIds. These are separate strict input alternatives.' },
    { path: 'automationIds', title: 'Triggered Workflow sources', widget: 'json', description: 'Use this alternative alone for triggered Workflow occurrence summaries; do not combine it with sourceArtifactIds or recent.' },
  ],
  'workflow.run.read_state.set': [{ path: 'failedAt', title: 'Observed failure time', widget: 'text', required: true,
    description: 'Retain the exact failure timestamp and Run revision shown by the owner; this acknowledges that failure without clearing a newer one.' }],
  'workflow.run.pause': [runRevision],
  'workflow.run.cancel': [runRevision],
  'workflow.run.delete': [runRevision],
  'workflow.run.resume': [runRevision, { path: 'invocations', title: 'Reviewed recovery choices', widget: 'json',
    description: 'For mode recover, supply the canonical recovery choices from the held invocations: reattach, continue or restore_workspace. Boundary resume has no invocation choices.' }],
  'workflow.run.invocations.get': [{ path: 'invocationId', title: 'Invocation history record', widget: 'text', required: true,
    description: 'Use a record id from workflow.run.invocations.list, including a superseded attempt when that is the record you intend to inspect.' }],
  'workflow.run.invocations.retry': [runRevision, invocation,
    { path: 'causalInvocationIds', title: 'Reviewed causal records', widget: 'json', required: true, description: 'Retain the exact causal invocation history records used to make the retry decision.' },
    { path: 'input', title: 'Retry input', widget: 'json', required: true, description: 'Use the canonical Workflow recovery input: original, or replacement authored input. Preserve the selected same_conversation or fresh_agent recovery choice.' },
  ],
  'workflow.run.invocations.publish_draft': [...reviewFields,
    { path: 'value', title: 'Private draft result', widget: 'json', required: true, description: 'The result must satisfy this invocation’s frozen result contract. Publishing it does not complete or advance the review.' }],
  'workflow.run.invocations.complete_review': [...reviewFields,
    { path: 'value', title: 'Reviewed result', widget: 'json', description: 'With mode use_result, omit to accept the current stored draft, or supply a value matching the invocation’s frozen result contract. Only a present person can complete this review.' },
    { path: 'followUp', title: 'Reviewed follow-up', widget: 'json', description: 'Optional canonical Workflow follow-up when accepting a result. Generate mode uses the held invocation instead.' }],
  'workflow.definition.create': [
    { path: 'definitionId', title: 'New definition id', widget: 'text', required: true, description: 'Allocate a UUID for this new Artifact; reuse it only to reconcile the same create after an uncertain response.' }, definition],
  'workflow.definition.update': [definitionId, definitionRevision, definition],
  'workflow.definition.edit': [definitionId, definitionRevision,
    { path: 'ops', title: 'Canonical Workflow edit operations', widget: 'json', required: true, description: 'An ordered batch from the ordinary editor’s Workflow edit-operation schema. Prefer this for partial changes; update replaces the whole definition.' }],
  'workflow.definition.delete': [definitionId],
  'workflow.definition.import': [{ path: 'json', title: 'Workflow document JSON', widget: 'textarea', required: true,
    description: 'Supply the serialized ordinary Workflow document, as returned by workflow.definition.export. Import parses an unsaved definition; it does not save or start work.' }],
  'workflow.definition.export': [{ ...definitionId, required: false },
    { path: 'draft', title: 'Unsaved Workflow definition', widget: 'json',
      description: 'Supply the current definition from workflow.authoring.draft.get to export without saving. Choose either draft or definitionId.' }],
  'workflow.definition.capture': [
    { path: 'discussion', title: 'Source Discussion address', widget: 'json', required: true, description: 'The qualified Home and Discussion containing the selected authorized messages.' },
    { path: 'messageIds', title: 'Selected message ids', widget: 'json', required: true, description: 'Select exact messages from this Discussion. Capture creates an editable draft with source provenance; it does not save or run.' },
    { path: 'choices', title: 'Reviewed capture choices', widget: 'json', description: 'Resolve needs_review using the existing per-message input, step or exclude choices, dependencies, instructions and fixed/per-run participants.' },
  ],
  'workflow.trigger.remove': [
    { path: 'automationId', title: 'Saved Workflow trigger set', widget: 'text', required: true, description: 'Use automationId from workflow.trigger.list; this identifies the saved trigger set, not a Workflow Run.' },
    { path: 'triggerId', title: 'Child trigger to remove', widget: 'text', description: `Supply a child trigger id to remove only it. Omit to delete the entire Account trigger set and its saved recipe. ${WORKFLOW_AUTOMATION_REMOVAL_WARNING}` },
  ],
  'workflow.trigger.run_now': [
    { path: 'automationId', title: 'Saved Workflow trigger set', widget: 'text', required: true, description: 'Use automationId from workflow.trigger.list. Admits a manual occurrence of that retained Workflow without editing or converting it.' },
    { path: 'idempotencyKey', title: 'Manual occurrence identity', widget: 'text', description: 'Reuse the same key only to reconcile this same requested occurrence after an uncertain response.' },
  ],
};

function getWorkflowAdministrativeFields(actionId: WorkflowActionIdV1): readonly Field[] {
  return administrativeFields[actionId] ?? [];
}

/** Authored Workflow semantics supplement the catalog's schema-derived operands. */
export function getWorkflowInputHints(actionId: WorkflowActionIdV1, title: string): WorkflowInputHints {
  return { title, fields: actionId === 'workflow.definition.list'
      ? [
        { path: 'cursor', title: 'Next page cursor', widget: 'text', description: 'Use the previous response nextCursor to continue the saved workflow library.' },
        { path: 'limit', title: 'Page size preference', widget: 'number' },
      ]
      : actionId === 'workflow.definition.get'
        ? [{ ...definitionId, description: 'Use a definitionId returned by workflow.definition.list.' }]
      : actionId === 'workflow.trigger.list'
        // Keep the union's authored selection semantics at this owner;
        // shared catalog derivation supplies uncovered structural operands.
        ? [
          { path: 'workflow', title: 'Workflow', widget: 'select', optionsSourceId: 'workflows.references.available',
            description: 'Choose a workflow, an Account scope, or a retained workflow with Review.',
            requiredWhen: { op: 'and', all: [
              { op: 'not', predicate: { op: 'truthy', path: 'scope' } },
              { op: 'not', predicate: { op: 'eq', path: 'review', value: true } },
            ] } },
          { path: 'scope', title: 'Account scope', widget: 'select', options: [
            { value: 'account_inline', label: 'Inline workflows' },
            { value: 'account_all', label: 'All workflows' },
            { value: 'account_source_unavailable', label: 'Unavailable saved workflows' },
          ] },
          { path: 'review', title: 'Review retained Workflow', widget: 'boolean' },
          { path: 'automationId', title: 'Workflow trigger set', widget: 'text',
            requiredWhen: { op: 'eq', path: 'review', value: true } },
        ]
      : actionId === 'workflow.trigger.add'
      ? [{ path: 'workflow', title: 'Workflow', widget: 'select', optionsSourceId: 'workflows.references.available' }]
      : actionId === 'workflow.trigger.update'
        ? [
          { path: 'automationId', title: 'Workflow trigger set', widget: 'text', required: true },
          { path: 'expectedRevision', title: 'Reviewed revision', widget: 'number', required: true },
          { path: 'triggerId', title: 'Trigger', widget: 'text' },
          { path: 'patch', title: 'Changes', widget: 'json', required: true,
            description: 'For a reviewed legacy conversion, include the reviewed target and project, and optionally enabled.' },
          { path: 'confirmLegacyConversion', title: 'Store reviewed workflow without end-to-end encryption', widget: 'boolean', required: true,
            visibleWhen: { op: 'eq', path: 'confirmLegacyConversion', value: true } },
        ]
      : actionId === 'workflow.run.start'
        ? [
          { path: 'runId', title: 'New Run id', widget: 'text', required: true,
            description: 'Allocate a UUID for this new start; reuse it to reconcile a lost response.' },
          { path: 'source.workflow', title: 'Workflow', widget: 'select', optionsSourceId: 'workflows.references.available' },
          { path: 'source.replay.runId', title: 'Accepted Run to repeat', widget: 'text',
            description: 'With an inline source, reopens this authorized Run and preserves its accepted graph and concrete participants.' },
          { path: 'source.replay.intent', title: 'Continuation', widget: 'select',
            options: [{ value: 'another_round', label: 'Another round' }],
            description: 'Omit for ordinary Run again. Another round retains accepted inputs and supplies authorized outcomes as previousRoundContext; that JSON input must be declared by the workflow.' },
          { path: 'inputs', title: 'Workflow inputs', widget: 'json',
            description: 'Values keyed by declared workflow input names. Resolve input choices with action.options.resolve using a workflow consumer and the declared input name as fieldPath. Machine/workspace routing comes from Action context, not this object. Another round inherits the completed Run inputs; it never substitutes current picker defaults.' },
          { path: 'executionTarget', title: 'Step execution kind', widget: 'json',
            description: 'Optional leaf execution kind: session or detached_run. This does not select a Machine or directory; a Session caller inherits those from its authenticated context.' },
        ]
      : actionId === 'workflow.run.invocations.list'
        ? [{ path: 'includeContent', title: 'Include invocation content', widget: 'boolean',
          description: 'Open progress and output beside each history row in the same page. Not available with parentRecordId.' }]
      : getWorkflowAdministrativeFields(actionId) };
}

