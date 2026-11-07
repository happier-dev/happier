import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import type { PreNormalizedActionSpec } from '../actions/actionSpecs.js';
import { WorkflowDiscussionRoundProjectInputV1Schema, WorkflowDiscussionRoundProjectResultV1Schema } from './workflowDiscussionRoundV1.js';
import { WorkflowMachineCommandOutputV1Schema } from './commandOutputV1.js';
export { WorkflowMachineCommandOutputV1Schema, getWorkflowActionOutputKindV1, type WorkflowMachineCommandOutputV1 } from './commandOutputV1.js';

export { WORKFLOW_EFFECT_ACTION_IDS_V1, type WorkflowEffectActionIdV1 } from './workflowEffectActionIdsV1.js';

export const WorkflowWebhookInputV1Schema = lazyZodSchema(() => z.strictObject({
  url: z.string().check(z.trim(), z.url(), z.refine((url) => /^https?:/u.test(url), 'Use HTTP or HTTPS')),
  body: StrictJsonValueSchema,
}));
export const WorkflowWebhookOutputV1Schema = lazyZodSchema(() => z.strictObject({ status: z.number().check(z.int()), body: z.string() }));
export const WorkflowMachineCommandInputV1Schema = lazyZodSchema(() => z.strictObject({
  command: z.string().check(z.minLength(1), z.refine((value) => !value.includes('\0'), 'Commands cannot contain NUL')),
  env: z.optional(z.record(z.string().check(z.minLength(1), z.refine((key) => !/[=\0]/u.test(key), 'Invalid environment key')),
    z.string().check(z.refine((value) => !value.includes('\0'), 'Environment values cannot contain NUL')))),
}));
/** Authored shell syntax is never resolved from event/input/result data. */
export function isWorkflowActionLiteralFieldV1(actionId: string, field: string): boolean {
  return actionId === 'machines.command.run' && field === 'command'
    || actionId === 'machines.services.exec' && field === 'argv';
}

export const WorkflowEffectActionInputSchemasV1 = {
  'workflow.discussion.round.project': lazyZodSchema(() => WorkflowDiscussionRoundProjectInputV1Schema),
  'webhooks.call': WorkflowWebhookInputV1Schema,
  'machines.command.run': WorkflowMachineCommandInputV1Schema,
} as const;
export const WorkflowEffectActionOutputSchemasV1 = {
  'workflow.discussion.round.project': lazyZodSchema(() => WorkflowDiscussionRoundProjectResultV1Schema),
  'webhooks.call': WorkflowWebhookOutputV1Schema,
  'machines.command.run': WorkflowMachineCommandOutputV1Schema,
} as const;

export const WORKFLOW_EFFECT_ACTION_SPECS_V1 = [
  {
    id: 'workflow.discussion.round.project', approval: { result: 'required' }, title: 'Read Discussion round outcomes',
    description: 'Project completed participant outcomes in the current accepted Workflow frame. Pass and next speakers come from exact reply custody, never prose.',
    safety: 'safe', sideEffectClass: 'read', requiredAuthority: 'account_automation', executionPlacement: 'account', placements: [],
    bindings: { mcpToolName: 'workflow_discussion_round_project', voiceClientToolName: 'workflow_discussion_round_project', rpcMethod: 'workflow.discussion.round.project' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: true },
    inputSchema: WorkflowEffectActionInputSchemasV1['workflow.discussion.round.project'],
    outputSchema: WorkflowEffectActionOutputSchemasV1['workflow.discussion.round.project'],
    inputHints: { fields: [
      { path: 'collections', title: 'Round blocks', widget: 'json', required: true },
      { path: 'phase', title: 'Phase', widget: 'select', options: [
        { value: 'prepare', label: 'Prepare' }, { value: 'complete', label: 'Complete' },
      ] },
      { path: 'rosterInput', title: 'Roster input', widget: 'text' },
      { path: 'previousProjectionBlockId', title: 'Previous projection block', widget: 'text' },
      { path: 'preparationBlockId', title: 'Preparation block', widget: 'text' },
    ] },
  },
  {
    id: 'webhooks.call', approval: {result: 'required'}, title: 'Call a webhook',
    description: 'POST typed JSON through the host webhook destination policy. Retains the response; status 300 or higher fails.',
    safety: 'danger', sideEffectClass: 'write', requiredAuthority: 'account_automation',
    executionPlacement: 'account', placements: [],
    bindings: { mcpToolName: 'webhooks_call', rpcMethod: 'webhooks.call' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: true },
    inputSchema: WorkflowWebhookInputV1Schema, outputSchema: WorkflowWebhookOutputV1Schema,
    inputHints: { fields: [
      { path: 'url', title: 'Webhook URL', widget: 'text', required: true },
      { path: 'body', title: 'JSON body', widget: 'json', required: true },
    ] },
  },
  {
    id: 'machines.command.run', approval: {result: 'required'}, title: 'Run a command',
    description: 'Run literal shell syntax on the selected Machine in its project workspace. Dynamic values belong only in env. Retains exit code, stdout and stderr.',
    safety: 'danger', sideEffectClass: 'danger', requiredAuthority: 'account_automation',
    executionPlacement: 'machine', placements: [],
    bindings: { mcpToolName: 'machines_command_run', rpcMethod: 'machines.command.run' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: true },
    inputSchema: WorkflowMachineCommandInputV1Schema, outputSchema: WorkflowMachineCommandOutputV1Schema,
    inputHints: { fields: [
      { path: 'command', title: 'Command', widget: 'textarea', required: true },
      { path: 'env', title: 'Environment', widget: 'json' },
    ] },
  },
] as const satisfies readonly PreNormalizedActionSpec[];
