import { PROVIDER_ACTION_INPUT_SCHEMAS_V1 as inputs, PROVIDER_ACTION_OUTPUT_SCHEMAS_V1 as outputs,
  isProviderActionMachineRequiredV1, resolveProviderActionExecutionPlacementsV1, parseProviderActionRequestV1, type ProviderActionIdV1 } from '../../providers/providerActionsV1.js';
import type { ActionInputFieldHint, PreNormalizedActionSpec } from '../actionSpecs.js';
import { readRecord } from '../../inputs/inputRecords.js';
import { ProviderEndpointUrlSyntaxSchema } from '../../providers/endpointUrlSchema.js';
import { ProviderPublicHeadersV1Schema } from '../../providers/publicHeadersSchema.js';
import { ProviderEndpointOverrideV1Schema } from '../../providers/connections/v1.js';
import { ProviderErrorV1Schema } from '../../providers/errors.js';
import { ProviderModelConfirmationSourceKeyV1Schema } from '../../providers/compatibility/sourceFacts.js';
import { CustomProviderTemplateV1Schema } from '../../providers/connections/customTemplateV1.js';
import { ProviderClaudeHelperModelsV1Schema, ProviderConnectionModelSettingsUpdateV1Schema, ProviderConnectionPurposeBindingDefaultsV1Schema,
  ProviderGatewayPlacementV1Schema } from '../../providers/connections/v1.js';

/** Outputs never disclose credentials, templates, endpoints or model inventories. */
function projectProviderObservation(input: unknown): unknown {
  const value = readRecord(input);
  const projected: Record<string, unknown> = Object.fromEntries(['status', 'action', 'machineId', 'connectionId', 'agentTargetKey', 'sourceProfileId']
    .filter(key => typeof value[key] === 'string').map(key => [key, value[key]]));
  const error = ProviderErrorV1Schema.safeParse(value.error);
  if (value.status === 'error' && error.success) projected.error = error.data;
  return projected;
}

/** The same safe operands explain execution observations and approval effects. */
function projectProviderInputObservation(input: unknown): unknown {
  const value = readRecord(input);
  const projected: Record<string, unknown> = { ...readRecord(projectProviderObservation(value)) };
  const catalogSourceKey = ProviderModelConfirmationSourceKeyV1Schema.safeParse(value.catalogSourceKey);
  if (catalogSourceKey.success) projected.catalogSourceKey = catalogSourceKey.data;
  for (const key of ['contributionKey', 'displayName', 'displayNameMode', 'newConnectionId', 'draftConnectionId', 'mode', 'scope',
    'endpointTemplateId', 'credentialSlotId', 'modelId', 'purpose', 'candidateId', 'compatibilityFingerprint']) {
    if (typeof value[key] === 'string' || value[key] === null) projected[key] = value[key];
  }
  for (const key of ['enable', 'enabled', 'shown', 'visible', 'expectedRevision', 'expectedConnectionRevision', 'forceRefresh']) {
    if (typeof value[key] === 'boolean' || typeof value[key] === 'number' || value[key] === null) projected[key] = value[key];
  }
  if (value.baseUrl === null) projected.baseUrl = null;
  else {
    const url = ProviderEndpointUrlSyntaxSchema.safeParse(value.baseUrl);
    if (url.success) projected.baseUrl = url.data;
  }
  if (value.publicHeaders === null) projected.publicHeaders = null;
  else {
    const headers = ProviderPublicHeadersV1Schema.safeParse(value.publicHeaders);
    if (headers.success) projected.publicHeaders = headers.data;
  }
  if (typeof value.policyReviewFingerprint === 'string' && value.policyReviewFingerprint.startsWith('authoring-review:v1:')) projected.policyReviewFingerprint = value.policyReviewFingerprint;
  const template = CustomProviderTemplateV1Schema.safeParse(value.template);
  if (template.success) {
    projected.template = { ...template.data, credential: template.data.credential ?? null };
  }
  const review = readRecord(value.authoringReview);
  if (Array.isArray(review.endpointOverrides)) {
    projected.authoringReview = { endpointOverrides: review.endpointOverrides.flatMap(entry => {
      const endpoint = ProviderEndpointOverrideV1Schema.safeParse(entry);
      return endpoint.success ? [endpoint.data] : [];
    }) };
  }
  const deployment = readRecord(value.deployment);
  if (deployment.kind === 'external') projected.deployment = { kind: 'external' };
  if (deployment.kind === 'managedLocal') {
    const defaults = ProviderConnectionPurposeBindingDefaultsV1Schema.safeParse(deployment.purposeBindingDefaults);
    if (defaults.success) projected.deployment = { kind: 'managedLocal', purposeBindingDefaults: defaults.data };
  }
  for (const [key, schema] of [['gatewayPlacement', ProviderGatewayPlacementV1Schema],
    ['claudeHelperModels', ProviderClaudeHelperModelsV1Schema]] as const) {
    if (value[key] === null) projected[key] = null;
    else {
      const parsed = schema.safeParse(value[key]);
      if (parsed.success) projected[key] = parsed.data;
    }
  }
  const modelSettings = ProviderConnectionModelSettingsUpdateV1Schema.safeParse(value.modelSettings);
  if (modelSettings.success) projected.modelSettings = modelSettings.data;
  return projected;
}

/** Private review retains declared credential/model references, never credential values. */
function projectProviderApprovalInput(id: ProviderActionIdV1, input: unknown): unknown {
  const value = readRecord(inputs[id].parse(input));
  const projected: Record<string, unknown> = { ...readRecord(projectProviderInputObservation(input)),
    ...(typeof value.savedSecretId === 'string' || value.savedSecretId === null
      ? { savedSecretId: value.savedSecretId } : {}),
  };
  // These schema-admitted model choices and exact visibility operands are
  // reviewed privately; shared observations keep their existing projection.
  for (const key of ['ref', 'hidden', 'scope', 'models', 'changes', 'selection', 'manualModels']) {
    if (value[key] !== undefined) projected[key] = value[key];
  }
  return projected;
}

const templateFields = (prefix: string) => [
  { path: `${prefix}.name`, title: 'Connection name', widget: 'text' },
  { path: `${prefix}.endpointTemplates.[].id`, title: 'Endpoint', widget: 'text' },
  { path: `${prefix}.endpointTemplates.[].protocol`, title: 'Protocol', widget: 'text' },
  { path: `${prefix}.endpointTemplates.[].baseUrl`, title: 'Provider address', widget: 'text' },
  { path: `${prefix}.credential`, title: 'Credential requirement', widget: 'json' },
  { path: `${prefix}.catalog`, title: 'Model catalog', widget: 'json' },
] satisfies readonly ActionInputFieldHint[];

function providerFields(id: ProviderActionIdV1): readonly ActionInputFieldHint[] {
  if (id === 'providers.binding.status') return [
    { path: 'machineId', title: 'Computer', widget: 'text', required: true },
    { path: 'sessionId', title: 'Owned Session', widget: 'text' },
    { path: 'agentTargetKey', title: 'Agent for an explicit pairing', widget: 'text' },
    { path: 'selection', title: 'Explicit model selection', widget: 'json' },
    { path: 'launchBinding', title: 'Explicit launch binding', widget: 'json' },
  ];
  if (id === 'providers.gateways.choose') return [
    { path: 'contributionKey', title: 'Qualified gateway contribution', widget: 'text' },
    { path: 'service', title: 'Qualified connected service', widget: 'json' },
    { path: 'purpose', title: 'Declared gateway purpose', widget: 'text' },
    { path: 'machineId', title: 'Installed contribution Machine', widget: 'text' },
  ];
  const target = [
    { path: 'connectionId', title: 'Provider connection', widget: 'text' },
    { path: 'machineId', title: 'Computer', widget: 'text' },
  ] satisfies readonly ActionInputFieldHint[];
  if (id === 'providers.models.experimental.confirm') return [
    { path: 'modelId', title: 'Model', widget: 'text' },
    { path: 'agentTargetKey', title: 'Agent', widget: 'text', required: true },
    ...target,
  ];
  const fields: Partial<Record<ProviderActionIdV1, readonly ActionInputFieldHint[]>> = {
    'providers.connections.create_custom': [...templateFields('template'),
      { path: 'manualModels', title: 'Initial manual models', widget: 'json' },
      { path: 'enable', title: 'Enable connection', widget: 'boolean' }],
    'providers.connections.create_contribution': [
      { path: 'contributionKey', title: 'Provider', widget: 'text' }, { path: 'displayName', title: 'Connection name', widget: 'text' },
      { path: 'authoringReview.endpointOverrides', title: 'Provider addresses', widget: 'json' }, { path: 'enable', title: 'Enable connection', widget: 'boolean' },
      { path: 'deployment.kind', title: 'Deployment', widget: 'text' },
      { path: 'deployment.purposeBindingDefaults', title: 'Subscription slots', widget: 'json' },
    ],
    'providers.connections.update': [
      { path: 'displayName', title: 'Connection name', widget: 'text' }, { path: 'expectedRevision', title: 'Connection revision', widget: 'text' },
      ...templateFields('template'), { path: 'deployment.kind', title: 'Deployment', widget: 'text' },
      { path: 'deployment.purposeBindingDefaults', title: 'Subscription slots', widget: 'json' },
      { path: 'gatewayPlacement', title: 'Gateway runs on', widget: 'json' }, { path: 'claudeHelperModels', title: 'Claude Code helper models', widget: 'json' },
      { path: 'modelSettings', title: 'Model generation settings', widget: 'json' },
    ],
    'providers.connections.endpoint.set': [
      { path: 'endpointTemplateId', title: 'Endpoint', widget: 'text' }, { path: 'baseUrl', title: 'Provider address', widget: 'json' },
      { path: 'scope', title: 'Scope', widget: 'text' },
      { path: 'publicHeaders', title: 'Public request policy (null resets inheritance)', widget: 'json' },
    ],
    'providers.connections.duplicate': [
      { path: 'newConnectionId', title: 'New connection', widget: 'text' }, { path: 'displayName', title: 'Connection name', widget: 'text' }, { path: 'mode', title: 'Source', widget: 'text' },
    ],
    'providers.connections.enabled.set': [{ path: 'enabled', title: 'Enabled', widget: 'boolean' }, { path: 'scope', title: 'Scope', widget: 'text' }],
    'providers.connections.secrets.bind': [{ path: 'credentialSlotId', title: 'Credential slot', widget: 'text' }, { path: 'scope', title: 'Scope', widget: 'text' }],
    'providers.probe': [{ path: 'draftConnectionId', title: 'Draft connection', widget: 'text' }, ...templateFields('template')],
  };
  return [...target, ...(fields[id] ?? [])];
}
type ProviderActionSpec<Id extends ProviderActionIdV1> = PreNormalizedActionSpec & Readonly<{
  id: Id; inputSchema: (typeof inputs)[Id]; outputSchema: (typeof outputs)[Id];
}>;
function providerSpec<Id extends ProviderActionIdV1>(id: Id, title: string, summary: string, options: Readonly<{
  danger?: boolean; read?: boolean; external?: boolean;
}>): ProviderActionSpec<Id> {
  return {
    id, approvalPolicy: { uiConfirmation: 'policy',
      ...(id === 'providers.models.experimental.confirm' ? { retainUiFieldIntent: true } : {}),
    }, approval: { result: 'required' }, title, safety: options.danger ? 'danger' : 'safe',
    ...(id === 'providers.connections.update' ? { safetyForInput: (input: unknown) => {
      const parsed = inputs['providers.connections.update'].safeParse(input);
      if (!parsed.success) return 'danger' as const;
      const displayKeys = new Set(['action', 'machineId', 'connectionId', 'expectedRevision', 'displayName', 'displayNameMode']);
      return Object.keys(parsed.data).every(key => displayKeys.has(key)) ? 'safe' as const : 'danger' as const;
    } } : {}),
    sideEffectClass: options.external ? 'external' : options.read ? 'read' : 'write',
    requiredAuthority: 'account_automation', executionPlacement: isProviderActionMachineRequiredV1({ actionId: id }) ? 'machine' : 'account', placements: [],
    executionPlacementForInput: input => isProviderActionMachineRequiredV1(parseProviderActionRequestV1(id, input)) ? 'machine' : 'account',
    executionPlacements: resolveProviderActionExecutionPlacementsV1(id),
    surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: false, rpc: true },
    bindings: { rpcMethod: id, mcpToolName: id.replaceAll('.', '_') },
    inputSchema: inputs[id], outputSchema: outputs[id],
    projectObservationInput: projectProviderInputObservation, projectObservationOutput: projectProviderObservation,
    approvalPresentation: { summary: () => summary, projectInput: input => projectProviderApprovalInput(id, input) },
    inputHints: { description: summary, fields: providerFields(id) }, cli: { acceptsServerId: true, commands: [{ path: id.split('.'), visibility: 'canonical' }] },
  } satisfies ProviderActionSpec<Id>;
}
export const PROVIDER_ACTION_SPECS_V1 = [
  providerSpec('providers.gateways.choose', 'Choose a gateway contribution',
    'Choose an admitted gateway contribution without creating a connection. Several candidates require an explicit qualified contribution key.', { read: true }),
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
  providerSpec('providers.connections.endpoint.set', 'Set Provider address and request policy',
    'Change or independently reset the Provider address and nonsecret request policy at the selected layer.', { danger: true }),
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
    'Ask a Provider for its current list of models.', { read: true }),
  providerSpec('providers.models.manual.add', 'Add Provider models by name',
    'Add or update manual models, optionally declaring their supported reasoning effort tiers.', {}),
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
  providerSpec('providers.usage.refresh', 'Refresh Provider usage',
    'Read current spend and credits from the declared usage sources of a saved Provider connection.', { read: true }),
  providerSpec('providers.binding.status', 'Check agent and Provider pairing',
    'Check the Provider pairing. Supply machineId and sessionId to read the owned Session pairing and, when changed, receive the exact providerBindingSecurityChangeConfirmationV1 for session.runtime.refresh.', { read: true }),
  providerSpec('providers.legacy.prepare', 'Prepare credentials from an earlier version',
    'Get the credentials of a profile from an earlier version of Happier ready to become a Provider connection.', { danger: true }),
  providerSpec('providers.defaults.set', 'Set default Provider model',
    'Choose the model an agent starts with when nothing else picks one.', {}),
] as const satisfies readonly PreNormalizedActionSpec[];
