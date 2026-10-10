import { PROVIDER_ACTION_INPUT_SCHEMAS_V1 as inputs, PROVIDER_ACTION_OUTPUT_SCHEMAS_V1 as outputs,
  isProviderActionMachineRequiredV1, parseProviderActionRequestV1, type ProviderActionIdV1 } from '../../providers/providerActionsV1.js';
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
function providerSpec<Id extends ProviderActionIdV1>(id: Id, title: string, summary: string, options: Readonly<{
  danger?: boolean; read?: boolean; external?: boolean;
}>): ProviderActionSpec<Id> {
  return {
    id, title, safety: options.danger ? 'danger' : 'safe',
    sideEffectClass: options.external ? 'external' : options.read ? 'read' : 'write',
    requiredAuthority: 'account_automation', executionPlacement: isProviderActionMachineRequiredV1({ actionId: id }) ? 'machine' : 'account', placements: [],
    executionPlacementForInput: input => isProviderActionMachineRequiredV1(parseProviderActionRequestV1(id, input)) ? 'machine' : 'account',
    surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: false, rpc: true },
    bindings: { rpcMethod: id, mcpToolName: id.replaceAll('.', '_') },
    inputSchema: inputs[id], outputSchema: outputs[id],
    projectObservationInput: projectProviderObservation, projectObservationOutput: projectProviderObservation,
    inputHints: { description: summary, fields: [] }, cli: { acceptsServerId: true, commands: [{ path: id.split('.'), visibility: 'canonical' }] },
  } satisfies ProviderActionSpec<Id>;
}
export const PROVIDER_ACTION_SPECS_V1 = [
  providerSpec('providers.connections.describe', 'List Provider connections',
    'See saved Account Providers, with optional setup and readiness on a machine.', { read: true }),
  providerSpec('providers.connections.create_contribution', 'Add Provider from a plugin',
    'Connect a Provider that an installed plugin offers.', { danger: true }),
  providerSpec('providers.connections.create_custom', 'Add custom Provider',
    'Connect a Provider by entering its address and how it signs in.', { danger: true }),
  providerSpec('providers.connections.enable_detected', 'Enable detected Provider',
    'Start using a Provider that Happier found already set up on the machine.', { danger: true }),
  providerSpec('providers.connections.start_local', 'Start local Provider',
    'Start a Provider that runs on the machine itself, such as a local model server.', { danger: true, external: true }),
  providerSpec('providers.connections.update', 'Update Provider connection',
    'Change a Provider connection, including gateway subscription slots, placement and helper models.', { danger: true }),
  providerSpec('providers.connections.endpoint.set', 'Set Provider address',
    'Point a Provider connection at a different address than its default.', { danger: true }),
  providerSpec('providers.connections.duplicate', 'Duplicate Provider connection',
    'Make a copy of a Provider connection to adjust.', { danger: true }),
  providerSpec('providers.connections.delete', 'Delete Provider connection',
    'Remove a Provider connection. Agents can no longer use its models.', { danger: true }),
  providerSpec('providers.connections.enabled.set', 'Turn Provider on or off',
    'Allow or stop agents using this Provider at the selected Account or machine scope.', { danger: true }),
  providerSpec('providers.connections.secrets.bind', 'Choose Provider credential',
    'Choose which saved secret a Provider connection signs in with.', { danger: true }),
  providerSpec('providers.models.list', 'List Provider models',
    'See the models a Provider connection offers.', { read: true }),
  providerSpec('providers.models.projection', 'Read models in the model picker',
    'See the models the model picker shows for an agent, across its Providers.', { read: true }),
  providerSpec('providers.models.refresh', 'Refresh Provider models',
    'Ask a Provider for its current list of models.', { danger: true, external: true }),
  providerSpec('providers.models.manual.add', 'Add Provider models by name',
    'Add models the Provider does not list by itself.', {}),
  providerSpec('providers.models.manual.remove', 'Remove added Provider model',
    'Remove a model you added by name.', {}),
  providerSpec('providers.models.visibility.set', 'Show or hide Provider model',
    'Choose whether one model appears in the model picker.', {}),
  providerSpec('providers.models.source_visibility.set', 'Show or hide Provider in the model picker',
    'Choose whether a Provider and its models appear in the model picker.', {}),
  providerSpec('providers.models.visibility.reset', 'Reset Provider model visibility',
    'Go back to the default choice of which models appear in the model picker.', {}),
  providerSpec('providers.models.visibility.bulk', 'Show or hide several Provider models',
    'Choose which of several models appear in the model picker, in one step.', {}),
  providerSpec('providers.models.experimental.confirm', 'Allow experimental Provider model',
    'Confirm that a model not yet known to work with an agent may be used with it.', { danger: true }),
  providerSpec('providers.models.load', 'Load Provider model',
    'Load a model on a Provider that runs models locally, so it is ready to answer.', { danger: true, external: true }),
  providerSpec('providers.models.cancel_load', 'Cancel Provider model loading',
    'Stop loading a model on a local Provider.', { danger: true, external: true }),
  providerSpec('providers.probe', 'Test Provider connection',
    'Check that a Provider connection, saved or still being set up, can be reached and signs in.', { danger: true, external: true }),
  providerSpec('providers.binding.status', 'Check agent and Provider pairing',
    'See whether an agent can use a Provider, and what is missing if it cannot.', { read: true }),
  providerSpec('providers.legacy.prepare', 'Prepare credentials from an earlier version',
    'Get the credentials of a profile from an earlier version of Happier ready to become a Provider connection.', { danger: true }),
  providerSpec('providers.defaults.set', 'Set default Provider model',
    'Choose the model an agent starts with when nothing else picks one.', {}),
] as const satisfies readonly PreNormalizedActionSpec[];
