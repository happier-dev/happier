import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import type { PreNormalizedActionSpec } from './definition.js';
import { AUTOMATION_OCCURRENCE_ACTION_IDS, AutomationOccurrenceInputSchemas, AutomationOccurrenceOutputSchemas } from '../../automations/occurrenceActions.js';

const titles = {
  'automation.run.reply_handoff.retry': 'Retry Automation reply handoff',
  'automation.run.result.redeliver': 'Deliver Automation result again',
} as const;
function createAutomationOccurrenceActionSpecs() {
  return AUTOMATION_OCCURRENCE_ACTION_IDS.map(id => ({
  id, title: titles[id],
  description: id === 'automation.run.result.redeliver'
    ? 'Send the accepted result to the same conversation as a new delivery, for the exact Run revision reviewed.'
    : 'Requeue the blocked reply handoff using its existing frozen delivery identity.',
  approval: { result: 'optional', flow: 'deferred' },
  approvalPolicy: { uiConfirmation: 'policy' },
  safety: 'danger', sideEffectClass: 'write', executionPlacement: 'account', placements: [],
  surfaces: { ui: true, agent: true, mcp: true, cli: true, voice: false, rpc: false },
  toolExposure: { mcp: 'discoverable_only' },
  bindings: { mcpToolName: id.replaceAll('.', '_') },
  cli: { acceptsServerId: true, commands: [{ path: id.split('.'), visibility: 'canonical' }] },
  inputSchema: AutomationOccurrenceInputSchemas[id], outputSchema: AutomationOccurrenceOutputSchemas[id],
  inputHints: { fields: [{ path: 'runId', title: 'Occurrence Run ID', widget: 'text', required: true },
    ...(id === 'automation.run.result.redeliver'
      ? [{ path: 'expectedRevision', title: 'Reviewed Run revision', widget: 'number' as const, required: true }] : [])] },
} satisfies PreNormalizedActionSpec));
}

export const AUTOMATION_OCCURRENCE_ACTION_SPECS: ReturnType<typeof createAutomationOccurrenceActionSpecs> = lazyActionSpecArray(createAutomationOccurrenceActionSpecs);
