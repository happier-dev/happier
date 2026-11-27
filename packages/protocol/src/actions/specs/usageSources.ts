import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import { USAGE_SOURCE_DISMISS_ACTION_ID } from '../../usage/usageSourcesActionIdsV1.js';
import { USAGE_SOURCE_ACTION_INPUT_SCHEMAS as inputs, USAGE_SOURCE_ACTION_OUTPUT_SCHEMAS as outputs,
  USAGE_SOURCE_CONSENT_DISCLOSURE, type UsageSourceActionId } from '../../usage/usageSources.js';

type SourceSpec<K extends UsageSourceActionId> = PreNormalizedActionSpec & Readonly<{
  id: K; inputSchema: (typeof inputs)[K]; outputSchema: (typeof outputs)[K];
}>;
function spec<K extends UsageSourceActionId>(id: K, title: string, summary: string, read = false): SourceSpec<K> {
  const dismiss = id === USAGE_SOURCE_DISMISS_ACTION_ID;
  return {
    id, approval: { result: 'required' }, title, description: summary,
    ...(id === 'usage.sources.history.delete' ? { irreversible: true as const } : {}),
    safety: read || dismiss ? 'safe' : 'danger', sideEffectClass: read ? 'read' : 'write',
    ...(id === 'usage.sources.stop' || id === 'usage.sources.root.set'
      ? { approvalPolicy: { uiConfirmation: 'direct' as const } } : {}),
    ...(id === 'usage.sources.consent.set' ? { approvalPolicy: {
      uiConfirmation: 'direct' as const,
      // Enabling capture discloses new accounting; stopping it retains history.
      uiConfirmationForInput: (input: unknown) => {
        const consent = inputs['usage.sources.consent.set'].safeParse(input);
        return !consent.success || consent.data.enabled;
      },
    } } : {}),
    requiredAuthority: 'account_automation', executionPlacement: dismiss ? 'account' : 'machine', placements: [],
    ...(dismiss ? { originalExecution: { daemonIngressSurfaces: [] } } : {}),
    ...(id === 'usage.sources.root.set' ? { approvalInputCustody: 'live_only' as const } : {}),
    ...(!dismiss && id !== 'usage.sources.history.delete' ? { approvalResultCustody: 'live_only' as const } : {}),
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: !dismiss },
    bindings: { ...(!dismiss ? { rpcMethod: id } : {}), mcpToolName: id.replaceAll('.', '_') },
    inputSchema: inputs[id], outputSchema: outputs[id],
    projectObservationInput: value => {
      const parsed = inputs[id].safeParse(value);
      // Live-only approval records already contain this projection, without
      // root/consent operands. Public reads must preserve its safe target ids.
      const observed = parsed.success ? parsed : inputs['usage.sources.get'].safeParse(value);
      if (!observed.success) return {};
      return { serverId: observed.data.serverId, machineId: observed.data.machineId,
        ...('sourceId' in observed.data ? { sourceId: observed.data.sourceId } : {}),
        ...('dismissed' in observed.data && observed.data.dismissed !== undefined ? { dismissed: observed.data.dismissed } : {}) };
    },
    projectObservationOutput: () => ({}),
    inputHints: { fields: [] }, cli: { acceptsServerId: true, commands: [] },
  };
}
function createUsageSourceActionSpecs() {
  return [
  spec('usage.sources.discover', 'Find usage records on a machine',
    'Look for usage records that agents keep on a machine, such as token counts. Nothing is collected yet. Agent and MCP results summarize source statuses and list dismissedSourceIds separately; use usage.sources.get with sourceId for exact detail.', true),
  spec('usage.sources.get', 'Read usage source',
    'See whether Happier collects usage from one source and how far it has got. Agent and MCP reads without sourceId summarize the inventory and list dismissedSourceIds separately; select one returned sourceId for exact detail.', true),
  spec(USAGE_SOURCE_DISMISS_ACTION_ID, 'Dismiss or restore a found usage source',
    'Hide a found source without collecting from it. Pass dismissed: false to restore a source from the dismissed inventory.'),
  spec('usage.sources.consent.set', 'Allow or stop usage collection', USAGE_SOURCE_CONSENT_DISCLOSURE),
  spec('usage.sources.stop', 'Stop collecting usage',
    'Stop collecting usage from a source. What was already collected stays.'),
  spec('usage.sources.root.set', 'Set usage source folder',
    'Tell Happier which folder on the machine holds a source\'s usage records.'),
  spec('usage.sources.history.delete', 'Delete collected usage',
    'Permanently delete the usage Happier collected from a source.'),
] as const;
}

export const USAGE_SOURCE_ACTION_SPECS: ReturnType<typeof createUsageSourceActionSpecs> = lazyActionSpecArray(createUsageSourceActionSpecs);
