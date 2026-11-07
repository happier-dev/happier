import { lazyActionSpecArray } from './lazyActionSpecValue.js';
import type { ActionSpecProjectionMetadata, PreNormalizedActionSpec } from './actionSpecs.js';
import { AutomationEventTestInputV1Schema, AutomationEventTestResultV1Schema } from '../automations/automationEventTestV1.js';
import { WorkflowStartersListInputV1Schema, WorkflowStartersListResultV1Schema,
  WorkflowStartersResolveInputV1Schema, WorkflowStartersResolveResultV1Schema } from '../workflows/builtins/starterActionsV1.js';

const readMetadata = {
  safety: 'safe', sideEffectClass: 'read', requiredAuthority: 'account_automation', executionPlacement: 'account', placements: [],
  surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
  toolExposure: { mcp: 'discoverable_only' },
} as const;

type WorkflowDiagnosticActionSchemas = {
  'workflow.trigger.test': { inputSchema: typeof AutomationEventTestInputV1Schema; outputSchema: typeof AutomationEventTestResultV1Schema };
  'workflow.starters.list': { inputSchema: typeof WorkflowStartersListInputV1Schema; outputSchema: typeof WorkflowStartersListResultV1Schema };
  'workflow.starters.resolve': { inputSchema: typeof WorkflowStartersResolveInputV1Schema; outputSchema: typeof WorkflowStartersResolveResultV1Schema };
};
type WorkflowDiagnosticActionSpec = {
  [Id in keyof WorkflowDiagnosticActionSchemas]: ActionSpecProjectionMetadata & typeof readMetadata & Readonly<WorkflowDiagnosticActionSchemas[Id]> & Readonly<{
    id: Id;
    approval: { result: 'required' };
  }>;
}[keyof WorkflowDiagnosticActionSchemas];
export const WORKFLOW_DIAGNOSTIC_ACTION_SPECS: readonly WorkflowDiagnosticActionSpec[] = lazyActionSpecArray(() => [{
  ...readMetadata, id: 'workflow.trigger.test', approval: {result: 'required'}, title: 'Test workflow trigger',
  description: 'Compare supplied Event facts with a trigger using the canonical source, age and filter evaluators. This diagnostic does not admit an Event or attest retained occurrence custody.',
  bindings: { mcpToolName: 'workflow_trigger_test', voiceClientToolName: 'workflow_trigger_test' },
  inputSchema: AutomationEventTestInputV1Schema, outputSchema: AutomationEventTestResultV1Schema,
  inputHints: { fields: [{ path: 'trigger', title: 'Trigger diagnostic fields', widget: 'json', required: true },
    { path: 'observation', title: 'Supplied Event facts', widget: 'json', required: true }] },
  cli: { commands: [{ path: ['workflow', 'trigger', 'test'], visibility: 'canonical' }] },
}, {
  ...readMetadata, id: 'workflow.starters.list', approval: {result: 'required'}, title: 'List starter workflow templates',
  description: 'List named starter workflow templates in examples, each with a key and an unsaved definition. Use workflow.starters.resolve with a returned key to prepare a template for a selected Session. Listing creates no saved definition, trigger or Run.',
  bindings: { mcpToolName: 'workflow_starters_list', voiceClientToolName: 'workflow_starters_list' },
  inputSchema: WorkflowStartersListInputV1Schema, outputSchema: WorkflowStartersListResultV1Schema,
  inputHints: { description: 'Execute this Action with {} to read actual templates. Workflow block kinds and runWhen values describe execution syntax, not starter templates or eligible trigger events.', fields: [] },
  cli: { commands: [{ path: ['workflow', 'starters', 'list'], visibility: 'canonical' }] },
}, {
  ...readMetadata, id: 'workflow.starters.resolve', approval: {result: 'required'}, title: 'Resolve workflow starter',
  description: 'Materialize an unsaved starter with the explicitly selected Session and optional timezone. Session-bound seeds require a selection; this does not save or execute them.',
  bindings: { mcpToolName: 'workflow_starters_resolve', voiceClientToolName: 'workflow_starters_resolve' },
  inputSchema: WorkflowStartersResolveInputV1Schema, outputSchema: WorkflowStartersResolveResultV1Schema,
  inputHints: { fields: [{ path: 'key', title: 'Starter key', widget: 'text', required: true },
    { path: 'session', title: 'Selected Session and Machine', widget: 'json',
      description: 'For a Session-bound starter supply {sessionId, machineId} for the selected Session. Use its actual Happier Machine id, or the exact id from machines.list; host names, dev-target names and server profile ids are not Machine ids. Omit session for templates that do not require a Session.' },
    { path: 'timezone', title: 'Timezone', widget: 'text' }] },
  cli: { commands: [{ path: ['workflow', 'starters', 'resolve'], visibility: 'canonical' }] },
}] as const satisfies readonly PreNormalizedActionSpec[]);
