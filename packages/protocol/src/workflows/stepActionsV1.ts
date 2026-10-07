import { z } from 'zod';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import type { PreNormalizedActionSpec } from '../actions/actionSpecs.js';

export const WORKFLOW_EFFECT_ACTION_IDS_V1 = ['webhooks.call', 'machines.command.run'] as const;
export type WorkflowEffectActionIdV1 = typeof WORKFLOW_EFFECT_ACTION_IDS_V1[number];

export const WorkflowWebhookInputV1Schema = z.object({
  url: z.string().trim().url().refine((url) => /^https?:/u.test(url), 'Use HTTP or HTTPS'),
  body: StrictJsonValueSchema,
}).strict();
export const WorkflowWebhookOutputV1Schema = z.object({ status: z.number().int(), body: z.string() }).strict();
export const WorkflowMachineCommandInputV1Schema = z.object({
  command: z.string().min(1).refine((value) => !value.includes('\0'), 'Commands cannot contain NUL'),
  env: z.record(z.string().min(1).refine((key) => !/[=\0]/u.test(key), 'Invalid environment key'),
    z.string().refine((value) => !value.includes('\0'), 'Environment values cannot contain NUL')).optional(),
}).strict();
export const WorkflowMachineCommandOutputV1Schema = z.object({
  exitCode: z.number().int(), stdout: z.string(), stderr: z.string(),
}).strict();

/** Authored shell syntax is never resolved from event/input/result data. */
export function isWorkflowActionLiteralFieldV1(actionId: string, field: string): boolean {
  return actionId === 'machines.command.run' && field === 'command';
}

export const WorkflowEffectActionInputSchemasV1 = {
  'webhooks.call': WorkflowWebhookInputV1Schema,
  'machines.command.run': WorkflowMachineCommandInputV1Schema,
} as const;
export const WorkflowEffectActionOutputSchemasV1 = {
  'webhooks.call': WorkflowWebhookOutputV1Schema,
  'machines.command.run': WorkflowMachineCommandOutputV1Schema,
} as const;

export const WORKFLOW_EFFECT_ACTION_SPECS_V1 = [
  {
    id: 'webhooks.call', title: 'Call a webhook',
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
    id: 'machines.command.run', title: 'Run a command',
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
