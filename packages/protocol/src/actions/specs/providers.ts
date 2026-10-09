import { PROVIDER_ACTION_INPUT_SCHEMAS_V1 as inputs, PROVIDER_ACTION_OUTPUT_SCHEMAS_V1 as outputs,
  type ProviderActionIdV1 } from '../../providers/providerActionsV1.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import { readRecord } from '../../inputs/inputRecords.js';

/** Observations deliberately omit credentials, templates, endpoints and model inventories. */
function projectProviderObservation(input: unknown): unknown {
  const value = readRecord(input);
  return Object.fromEntries(['status', 'action', 'machineId', 'connectionId', 'agentTargetKey', 'sourceProfileId']
    .filter(key => typeof value[key] === 'string').map(key => [key, value[key]]));
}
type ProviderActionSpec<Id extends ProviderActionIdV1> = PreNormalizedActionSpec & Readonly<{
  id: Id; inputSchema: (typeof inputs)[Id]; outputSchema: (typeof outputs)[Id];
}>;
function providerSpec<Id extends ProviderActionIdV1>(id: Id, title: string, options: Readonly<{
  danger?: boolean; read?: boolean; external?: boolean; account?: boolean;
}>): ProviderActionSpec<Id> {
  return {
    id, title, safety: options.danger ? 'danger' : 'safe',
    sideEffectClass: options.external ? 'external' : options.read ? 'read' : 'write',
    requiredAuthority: 'account_automation', executionPlacement: options.account ? 'account' : 'machine', placements: [],
    surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: false, rpc: true },
    bindings: { rpcMethod: id, mcpToolName: id.replaceAll('.', '_') },
    inputSchema: inputs[id], outputSchema: outputs[id],
    projectObservationInput: projectProviderObservation, projectObservationOutput: projectProviderObservation,
    inputHints: { fields: [] }, cli: { acceptsServerId: true, commands: [{ path: id.split('.'), visibility: 'canonical' }] },
  } satisfies ProviderActionSpec<Id>;
}
export const PROVIDER_ACTION_SPECS_V1 = [
  providerSpec('providers.connections.describe', 'Describe Provider connections', { read: true }),
  providerSpec('providers.connections.create_contribution', 'Create contributed Provider connection', { danger: true }),
  providerSpec('providers.connections.create_custom', 'Create custom Provider connection', { danger: true }),
  providerSpec('providers.connections.enable_detected', 'Enable detected Provider', { danger: true }),
  providerSpec('providers.connections.start_local', 'Start local Provider', { danger: true, external: true }),
  providerSpec('providers.connections.update', 'Update Provider connection', { danger: true }),
  providerSpec('providers.connections.endpoint.set', 'Set Provider endpoint override', { danger: true }),
  providerSpec('providers.connections.duplicate', 'Duplicate Provider connection', { danger: true }),
  providerSpec('providers.connections.delete', 'Delete Provider connection', { danger: true }),
  providerSpec('providers.connections.enabled.set', 'Set Provider grant enablement', { danger: true }),
  providerSpec('providers.connections.secrets.bind', 'Bind Provider credential reference', { danger: true }),
  providerSpec('providers.models.list', 'List Provider connection models', { read: true }),
  providerSpec('providers.models.projection', 'Read Provider model projection', { read: true }),
  providerSpec('providers.models.refresh', 'Refresh Provider models', { danger: true, external: true }),
  providerSpec('providers.models.manual.add', 'Add manual Provider models', {}),
  providerSpec('providers.models.manual.remove', 'Remove manual Provider model', {}),
  providerSpec('providers.models.visibility.set', 'Set Provider model visibility', {}),
  providerSpec('providers.models.visibility.reset', 'Reset Provider model visibility', {}),
  providerSpec('providers.models.visibility.bulk', 'Set Provider model visibility in bulk', {}),
  providerSpec('providers.models.experimental.confirm', 'Confirm experimental Provider model compatibility', { danger: true }),
  providerSpec('providers.models.load', 'Load Provider model', { danger: true, external: true }),
  providerSpec('providers.models.cancel_load', 'Cancel Provider model loading', { danger: true, external: true }),
  providerSpec('providers.probe', 'Probe Provider connection or draft', { danger: true, external: true }),
  providerSpec('providers.binding.status', 'Read Provider binding status', { read: true }),
  providerSpec('providers.legacy.prepare', 'Prepare legacy profile credentials for conversion', { danger: true }),
  providerSpec('providers.defaults.set', 'Set default Provider model preference', { account: true }),
] as const satisfies readonly PreNormalizedActionSpec[];
