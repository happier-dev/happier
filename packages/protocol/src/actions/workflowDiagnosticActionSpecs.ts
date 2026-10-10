import type { PreNormalizedActionSpec } from './actionSpecs.js';
import { AutomationEventTestInputV1Schema, AutomationEventTestResultV1Schema } from '../automations/automationEventTestV1.js';
import { WorkflowStartersListInputV1Schema, WorkflowStartersListResultV1Schema,
  WorkflowStartersResolveInputV1Schema, WorkflowStartersResolveResultV1Schema } from '../workflows/builtins/starterActionsV1.js';

const readMetadata = {
  safety: 'safe', sideEffectClass: 'read', requiredAuthority: 'account_automation', executionPlacement: 'account', placements: [],
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
  toolExposure: { mcp: 'discoverable_only' },
} as const;

export const WORKFLOW_DIAGNOSTIC_ACTION_SPECS = [{
  ...readMetadata, id: 'workflow.trigger.test', title: 'Test workflow trigger',
  description: 'Compare supplied Event facts with a trigger using the canonical source, age and filter evaluators. This diagnostic does not admit an Event or attest retained occurrence custody.',
  bindings: { mcpToolName: 'workflow_trigger_test' },
  inputSchema: AutomationEventTestInputV1Schema, outputSchema: AutomationEventTestResultV1Schema,
  inputHints: { fields: [{ path: 'trigger', title: 'Trigger diagnostic fields', widget: 'json', required: true },
    { path: 'observation', title: 'Supplied Event facts', widget: 'json', required: true }] },
  cli: { commands: [{ path: ['workflow', 'trigger', 'test'], visibility: 'canonical' }] },
}, {
  ...readMetadata, id: 'workflow.starters.list', title: 'List workflow starters',
  description: 'Read the canonical unsaved starter templates. Listing creates no definition, trigger or Run.',
  bindings: { mcpToolName: 'workflow_starters_list' },
  inputSchema: WorkflowStartersListInputV1Schema, outputSchema: WorkflowStartersListResultV1Schema,
  inputHints: { fields: [] },
  cli: { commands: [{ path: ['workflow', 'starters', 'list'], visibility: 'canonical' }] },
}, {
  ...readMetadata, id: 'workflow.starters.resolve', title: 'Resolve workflow starter',
  description: 'Materialize an unsaved starter with the explicitly selected Session and optional timezone. Session-bound seeds require a selection; this does not save or execute them.',
  bindings: { mcpToolName: 'workflow_starters_resolve' },
  inputSchema: WorkflowStartersResolveInputV1Schema, outputSchema: WorkflowStartersResolveResultV1Schema,
  inputHints: { fields: [{ path: 'key', title: 'Starter key', widget: 'text', required: true },
    { path: 'session', title: 'Selected Session and Machine', widget: 'json' }, { path: 'timezone', title: 'Timezone', widget: 'text' }] },
  cli: { commands: [{ path: ['workflow', 'starters', 'resolve'], visibility: 'canonical' }] },
}] as const satisfies readonly PreNormalizedActionSpec[];
