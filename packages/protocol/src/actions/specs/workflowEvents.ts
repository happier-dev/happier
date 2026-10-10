import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { AutomationEligibleEventsCatalogV1Schema } from '../../daemon/automationEligibleEvents.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';

export const WorkflowEventsListInputV1Schema = lazyZodSchema(() => z.object({
  machineId: z.string().trim().min(1),
  serverId: z.string().trim().min(1).optional(),
}).strict());
export type WorkflowEventsListInputV1 = z.output<typeof WorkflowEventsListInputV1Schema>;

/** Current declarations and setup facts, not configured source instances or source custody admission. */
export const WorkflowEventsListOutputV1Schema = lazyZodSchema(() => z.object({
  machineId: z.string().trim().min(1),
  events: AutomationEligibleEventsCatalogV1Schema,
}).strict());
export type WorkflowEventsListOutputV1 = z.output<typeof WorkflowEventsListOutputV1Schema>;

export const WORKFLOW_EVENT_CATALOG_ACTION_SPECS_V1 = [{
  id: 'workflow.events.list',
  title: 'List eligible workflow events',
  description: 'Read the selected Machine\'s current eligible Event declarations, supported observation transports and source setup Actions. This catalog does not configure, list or admit source instances.',
  safety: 'safe', sideEffectClass: 'read', requiredAuthority: 'account_automation',
  executionPlacement: 'machine', placements: [],
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
  bindings: { mcpToolName: 'workflow_events_list' },
  toolExposure: { mcp: 'discoverable_only' },
  inputHints: { fields: [{ path: 'machineId', title: 'Machine id', widget: 'text' }] },
  cli: { acceptsServerId: true, commands: [{ path: ['workflow', 'events', 'list'], visibility: 'canonical' }] },
  inputSchema: WorkflowEventsListInputV1Schema,
  outputSchema: WorkflowEventsListOutputV1Schema,
}] as const satisfies readonly PreNormalizedActionSpec[];
