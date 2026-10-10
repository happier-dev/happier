import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import { USAGE_SOURCE_ACTION_INPUT_SCHEMAS as inputs, USAGE_SOURCE_ACTION_OUTPUT_SCHEMAS as outputs,
  USAGE_SOURCE_CONSENT_DISCLOSURE, type UsageSourceActionId } from '../../usage/usageSources.js';

type SourceSpec<K extends UsageSourceActionId> = PreNormalizedActionSpec & Readonly<{
  id: K; inputSchema: (typeof inputs)[K]; outputSchema: (typeof outputs)[K];
}>;
function spec<K extends UsageSourceActionId>(id: K, title: string, summary: string, read = false): SourceSpec<K> {
  const dismiss = id === 'usage.sources.dismiss';
  return {
    id, title, description: summary,
    safety: read || dismiss ? 'safe' : 'danger', sideEffectClass: read ? 'read' : 'write',
    requiredAuthority: 'account_automation', executionPlacement: dismiss ? 'client' : 'machine', placements: [],
    ...(id === 'usage.sources.root.set' ? { approvalInputCustody: 'live_only' as const } : {}),
    ...(!dismiss && id !== 'usage.sources.history.delete' ? { approvalResultCustody: 'live_only' as const } : {}),
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: !dismiss },
    bindings: { ...(!dismiss ? { rpcMethod: id } : {}), mcpToolName: id.replaceAll('.', '_') },
    inputSchema: inputs[id], outputSchema: outputs[id],
    projectObservationInput: value => {
      const parsed = inputs[id].safeParse(value);
      if (!parsed.success) return {};
      return { serverId: parsed.data.serverId, machineId: parsed.data.machineId,
        ...('sourceId' in parsed.data ? { sourceId: parsed.data.sourceId } : {}) };
    },
    projectObservationOutput: () => ({}),
    inputHints: { fields: [] }, cli: { acceptsServerId: true, commands: [] },
  };
}
export const USAGE_SOURCE_ACTION_SPECS = [
  spec('usage.sources.discover', 'Find usage records on a machine',
    'Look for usage records that agents keep on a machine, such as token counts. Nothing is collected yet.', true),
  spec('usage.sources.get', 'Read usage source',
    'See whether Happier collects usage from one source and how far it has got.', true),
  spec('usage.sources.dismiss', 'Dismiss a found usage source',
    'Hide a usage source Happier found, without collecting from it.'),
  spec('usage.sources.consent.set', 'Allow or stop usage collection', USAGE_SOURCE_CONSENT_DISCLOSURE),
  spec('usage.sources.stop', 'Stop collecting usage',
    'Stop collecting usage from a source. What was already collected stays.'),
  spec('usage.sources.root.set', 'Set usage source folder',
    'Tell Happier which folder on the machine holds a source\'s usage records.'),
  spec('usage.sources.history.delete', 'Delete collected usage',
    'Permanently delete the usage Happier collected from a source.'),
] as const;
