import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { AutomationEligibleEventsCatalogV1Schema } from '../../daemon/automationEligibleEvents.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';

export const WorkflowEventsListInputV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: z.string().check(z.trim(), z.minLength(1)),
  serverId: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));
export type WorkflowEventsListInputV1 = z.output<typeof WorkflowEventsListInputV1Schema>;

/** Current declarations and setup facts, not configured source instances or source custody admission. */
export const WorkflowEventsListOutputV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: z.string().check(z.trim(), z.minLength(1)),
  events: AutomationEligibleEventsCatalogV1Schema,
}));
export type WorkflowEventsListOutputV1 = z.output<typeof WorkflowEventsListOutputV1Schema>;

function createWorkflowEventCatalogActionSpecsV1() {
  return [{
  id: 'workflow.events.list', approval: {result: 'none'},
  title: 'List eligible workflow events',
  description: 'List eligible trigger events from the selected Machine\'s current Event declarations. Returns event ids, titles, supported observation transports and source setup Actions. Use these declarations to discover Event trigger types; runWhen values are workflow block outcome conditions. This catalog does not configure, list or admit source instances.',
  safety: 'safe', sideEffectClass: 'read', requiredAuthority: 'account_automation',
  executionPlacement: 'machine', placements: [],
  surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
  bindings: { mcpToolName: 'workflow_events_list', voiceClientToolName: 'workflow_events_list' },
  toolExposure: { mcp: 'discoverable_only' },
  inputHints: { fields: [{ path: 'machineId', title: 'Machine id', widget: 'text', required: true,
    description: 'In a Session, omit machineId to use that Session’s Machine. For another Machine, use its exact id returned by machines.list; a host name, dev-target name (such as nl1), or server profile id is not a Machine id.' }] },
  cli: { acceptsServerId: true, commands: [{ path: ['workflow', 'events', 'list'], visibility: 'canonical' }] },
  inputSchema: WorkflowEventsListInputV1Schema,
  outputSchema: WorkflowEventsListOutputV1Schema,
}] as const satisfies readonly PreNormalizedActionSpec[];
}

export const WORKFLOW_EVENT_CATALOG_ACTION_SPECS_V1: ReturnType<typeof createWorkflowEventCatalogActionSpecsV1> = lazyActionSpecArray(createWorkflowEventCatalogActionSpecsV1);
