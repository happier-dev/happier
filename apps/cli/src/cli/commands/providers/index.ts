import {
  CUSTOM_PROVIDER_AUTHORING_PROTOCOLS_V1,
  CustomProviderAuthoringProtocolV1Schema,
  CustomProviderCredentialStyleV1Schema,
  CustomProviderTemplateV1Schema,
  ProviderModelIdSchema,
  parseProviderManualModelInput,
  normalizeCustomProviderTemplateV1,
} from '@happier-dev/protocol';
import type { DaemonProviderContributionAuthoringPreviewV1 } from '@happier-dev/protocol/rpc';

import { assertNoRawSecretArguments, assertOnlyAllowedFlags, hasFlag, positionalArgs, readFlag, readRawFlag } from './args';
import { resolveConnectionIdentity, resolveContributionIdentity } from './identity';
import { ProviderCliError, type ProviderCliDependencies, type ProviderCliResult } from './types';
import type { ProviderConnectionView } from '@/providers/connections/service';

export { ProviderCliError, type ProviderCliDependencies, type ProviderCliResult } from './types';

const LEGACY_AGENT_SUBCOMMANDS = new Set(['install', 'setup', 'status']);
const CUSTOM_SHARED_FLAGS = new Set(['--custom', '--saved-secret-id', '--json']);
const CUSTOM_SIMPLE_FLAGS = new Set([
  ...CUSTOM_SHARED_FLAGS,
  '--name', '--protocol', '--base-url', '--credential-style', '--credential-header', '--catalog', '--models-path',
]);
const CUSTOM_ADVANCED_FLAGS = new Set([...CUSTOM_SHARED_FLAGS, '--advanced-json']);
const LIST_FLAGS = new Set(['--available', '--json']);
const ADD_FLAGS = new Set(['--name', '--saved-secret-id', '--candidate-id', '--json']);
const MACHINE_FLAGS = new Set(['--machine', '--json']);
const LOAD_MODEL_FLAGS = new Set(['--machine', '--model', '--json']);
const REMOVE_FLAGS = new Set(['--json']);
const EDIT_FLAGS = new Set([
  '--machine', '--name', '--automatic-name', '--scope', '--endpoint-template', '--base-url', '--clear-endpoint', '--json',
]);
const SECRET_FLAGS = new Set(['--machine', '--scope', '--saved-secret-id', '--json']);
const MODEL_ADD_FLAGS = new Set(['--machine', '--models', '--json']);
const MODEL_REMOVE_FLAGS = new Set(['--machine', '--model', '--json']);

function requireValue(value: string | null | undefined, label: string): string {
  if (!value) throw new ProviderCliError('invalid_arguments', `${label} is required`);
  return value;
}

function requireProviderModelId(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    throw new ProviderCliError('invalid_arguments', '--model is required');
  }
  const parsed = ProviderModelIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new ProviderCliError('provider_model_not_found', 'Provider model id is invalid');
  }
  return parsed.data;
}

function assertPositionalArity(args: readonly string[], expected: number): void {
  const actual = positionalArgs(args).length;
  if (actual !== expected) {
    throw new ProviderCliError('invalid_arguments', `Expected ${expected} positional argument${expected === 1 ? '' : 's'}, received ${actual}`);
  }
}

function serializeConnection(connection: ProviderConnectionView) {
  return {
    connectionId: connection.connectionId,
    contributionKey: connection.contributionKey,
    name: connection.displayName,
    role: connection.role,
    source: connection.contributionKey === null ? 'custom' : 'contribution',
  };
}

function serializeConnectionDetail(connection: ProviderConnectionView) {
  return {
    ...serializeConnection(connection),
    providerName: connection.providerName,
    sourceStatus: connection.sourceStatus,
    probeCapability: connection.probeCapability,
    manualModelPolicy: connection.manualModelPolicy,
    compatibility: connection.compatibility,
    grants: connection.grants,
    credential: connection.credential,
    deployment: connection.deployment,
    managedLocalOption: connection.managedLocalOption,
    endpoints: connection.endpoints,
    scope: connection.scope,
    authorized: connection.authorized,
    authorizationError: connection.authorizationError,
    revision: connection.revision,
    runtime: connection.runtime,
  };
}

function throwServiceError(result: Readonly<{ status: 'error'; error: Readonly<{ code: string }> }>): never {
  throw new ProviderCliError(result.error.code, `Provider operation failed: ${result.error.code}`, result.error);
}

function describeAuthoringCandidates(
  preview: Extract<DaemonProviderContributionAuthoringPreviewV1, { status: 'selection_required' }>,
): string {
  const choices = preview.candidates.map((candidate, index) => {
    const machine = candidate.machineId ? ` on machine ${candidate.machineId}` : '';
    const endpoints = candidate.endpoints.map((endpoint) => endpoint.normalizedUrl).join(', ');
    return `${index + 1}. ${candidate.candidateId}${machine}\n   ${endpoints}`;
  }).join('\n');
  return [
    'This Provider has multiple destinations. Re-run the command with --candidate-id <id> using one exact choice:',
    choices,
    'Use --json for structured candidate details.',
  ].join('\n');
}

async function resolveTarget(args: readonly string[], deps: ProviderCliDependencies) {
  assertPositionalArity(args, 1);
  const snapshot = await deps.loadSnapshot();
  const identity = positionalArgs(args)[0];
  const machineId = readFlag(args, '--machine') ?? snapshot.machineId;
  if (machineId !== snapshot.machineId) {
    throw new ProviderCliError(
      'provider_not_enabled_on_machine',
      `This CLI can manage providers only on its current daemon machine (${snapshot.machineId}); use the UI or run the command on ${machineId}`,
      { requestedMachineId: machineId, currentMachineId: snapshot.machineId },
    );
  }
  const described = await deps.connections.describe({ machineId });
  if (described.status === 'error') throwServiceError(described);
  const connection = resolveConnectionIdentity(requireValue(identity, 'connection id'), described.connections);
  return { snapshot, connection, machineId };
}

async function addCustom(args: readonly string[], deps: ProviderCliDependencies): Promise<ProviderCliResult> {
  assertPositionalArity(args, 0);
  let template;
  try {
    const advancedPath = readFlag(args, '--advanced-json');
    if (advancedPath) {
      assertOnlyAllowedFlags(args, CUSTOM_ADVANCED_FLAGS);
      template = CustomProviderTemplateV1Schema.parse(await deps.readJsonFile(advancedPath));
    } else {
      assertOnlyAllowedFlags(args, CUSTOM_SIMPLE_FLAGS);
      const name = readFlag(args, '--name') ?? await deps.prompt('Provider connection name: ');
      // The authoring protocol and credential vocabularies are owned by
      // Protocol: prompt from that membership and narrow the raw flag through
      // its schema instead of restating the members as a cast here.
      const protocol = readFlag(args, '--protocol')
        ?? await deps.prompt(`Protocol (${CUSTOM_PROVIDER_AUTHORING_PROTOCOLS_V1.join(', ')}): `);
      const baseUrl = readFlag(args, '--base-url') ?? await deps.prompt('Base URL: ');
      const catalog = readFlag(args, '--catalog') ?? await deps.prompt('Catalog (manual or probe): ');
      const credentialStyle = readFlag(args, '--credential-style');
      template = normalizeCustomProviderTemplateV1({
        name,
        protocol: CustomProviderAuthoringProtocolV1Schema.parse(protocol),
        baseUrl,
        ...(credentialStyle ? {
          credentialStyle: CustomProviderCredentialStyleV1Schema.parse(credentialStyle),
        } : {}),
        ...(readFlag(args, '--credential-header') ? { credentialHeader: readFlag(args, '--credential-header')! } : {}),
        catalog: catalog as 'manual' | 'probe',
        ...(readFlag(args, '--models-path') ? { modelsPath: readFlag(args, '--models-path')! } : {}),
      });
    }
  } catch (error) {
    if (error instanceof ProviderCliError) throw error;
    throw new ProviderCliError('custom_provider_invalid', 'Custom provider configuration is invalid', {
      issues: error && typeof error === 'object' && 'issues' in error ? (error as { issues: unknown }).issues : undefined,
    });
  }
  let savedSecretId = readFlag(args, '--saved-secret-id');
  let preparedSavedSecret: Awaited<ReturnType<ProviderCliDependencies['createSavedSecret']>> | null = null;
  if (template.credential && !savedSecretId) {
    const value = await deps.promptSecret('API key (input hidden): ');
    if (value.trim()) {
      preparedSavedSecret = await deps.createSavedSecret({ name: `${template.name} API key`, value });
      savedSecretId = preparedSavedSecret.id;
    }
  }
  if (!template.credential && savedSecretId) {
    throw new ProviderCliError('invalid_arguments', '--saved-secret-id requires a credential style in the custom template');
  }
  const connectionId = deps.allocateConnectionId();
  const snapshot = await deps.loadSnapshot();
  const created = await deps.connections.create({
    action: 'createCustom', machineId: snapshot.machineId, connectionId,
    template, savedSecretId: savedSecretId ?? null, enable: false,
    ...(preparedSavedSecret ? { preparedSavedSecret } : {}),
  });
  if (created.status === 'error') throwServiceError(created);
  return { ok: true, kind: 'providers_add', data: { connectionId, contributionKey: null, created: true } };
}

function requiredScope(args: readonly string[]): 'account' | 'machine' {
  const scope = readFlag(args, '--scope');
  if (scope !== 'account' && scope !== 'machine') {
    throw new ProviderCliError('invalid_arguments', '--scope must be account or machine');
  }
  return scope;
}

export async function executeProvidersCommand(
  args: readonly string[],
  deps: ProviderCliDependencies,
  context: Readonly<{ signal?: AbortSignal }> = {},
): Promise<ProviderCliResult> {
  assertNoRawSecretArguments(args);
  const subcommand = String(args[0] ?? '').trim();
  if (LEGACY_AGENT_SUBCOMMANDS.has(subcommand)) {
    throw new ProviderCliError(
      'legacy_agent_command_moved',
      `Agent setup moved to 'happier agents ${subcommand}'; 'happier providers' now manages model providers`,
    );
  }
  if (!subcommand || ['help', '--help', '-h'].includes(subcommand)) {
    return { ok: true, kind: 'providers_help', data: null };
  }
  deps.assertProvidersFeatureEnabled();
  if (subcommand === 'list') {
    assertOnlyAllowedFlags(args.slice(1), LIST_FLAGS);
    assertPositionalArity(args.slice(1), 0);
    const snapshot = await deps.loadSnapshot();
    const described = await deps.connections.describe({ machineId: snapshot.machineId });
    if (described.status === 'error') throwServiceError(described);
    const available = hasFlag(args, '--available') ? described.available : [];
    return {
      ok: true,
      kind: 'providers_list',
      data: { connections: described.connections.map(serializeConnection), available },
    };
  }
  if (subcommand === 'show') {
    assertOnlyAllowedFlags(args.slice(1), MACHINE_FLAGS);
    const target = await resolveTarget(args.slice(1), deps);
    return { ok: true, kind: 'providers_show', data: serializeConnectionDetail(target.connection) };
  }
  if (subcommand === 'add') {
    if (hasFlag(args, '--custom')) return addCustom(args.slice(1), deps);
    assertOnlyAllowedFlags(args.slice(1), ADD_FLAGS);
    assertPositionalArity(args.slice(1), 1);
    const snapshot = await deps.loadSnapshot();
    const identity = positionalArgs(args.slice(1))[0];
    const resolved = resolveContributionIdentity(requireValue(identity, 'qualified contribution key'), snapshot.registry);
    const displayName = readFlag(args, '--name');
    const selectedCandidateId = readFlag(args, '--candidate-id');
    const credential = resolved.contribution.definition.credential;
    let savedSecretId = readFlag(args, '--saved-secret-id');
    if (!credential && savedSecretId) {
      throw new ProviderCliError('provider_credential_transport_unavailable', 'This Provider does not accept a SavedSecret');
    }
    const allocatedConnectionId = deps.allocateConnectionId();
    const preview = await deps.connections.previewCreateContribution({
      machineId: snapshot.machineId,
      connectionId: allocatedConnectionId,
      contributionKey: resolved.contributionKey,
      displayName,
      selectedCandidateId,
    });
    if (preview.status === 'error') throwServiceError(preview);
    if (!preview.created) {
      return { ok: true, kind: 'providers_add', data: {
        connectionId: preview.connectionId,
        created: false,
        contributionKey: resolved.contributionKey,
      } };
    }
    if (preview.authoringPreview.status !== 'resolved') {
      throw new ProviderCliError(
        'provider_authorization_changed',
        describeAuthoringCandidates(preview.authoringPreview),
        { candidates: preview.authoringPreview.candidates },
      );
    }
    let preparedSavedSecret: Awaited<ReturnType<ProviderCliDependencies['createSavedSecret']>> | null = null;
    if (credential?.required === true && !savedSecretId) {
      const value = await deps.promptSecret('API key (input hidden): ');
      if (!value.trim()) {
        throw new ProviderCliError('provider_secret_missing', 'A SavedSecret is required to add this Provider');
      }
      preparedSavedSecret = await deps.createSavedSecret({
        name: `${displayName ?? resolved.contribution.definition.name} API key`,
        value,
      });
      savedSecretId = preparedSavedSecret.id;
    }
    const output = await deps.connections.create({
      action: 'createContribution', machineId: snapshot.machineId,
      connectionId: allocatedConnectionId, contributionKey: resolved.contributionKey,
      displayName, savedSecretId: savedSecretId ?? null, enable: false,
      authoringReview: {
        candidateId: preview.authoringPreview.candidateId,
        fingerprint: preview.authoringPreview.fingerprint,
        revision: preview.authoringPreview.revision,
      },
      ...(preparedSavedSecret ? { preparedSavedSecret } : {}),
    });
    if (output.status === 'error') throwServiceError(output);
    return { ok: true, kind: 'providers_add', data: {
      connectionId: output.connection.connectionId,
      created: output.created,
      contributionKey: resolved.contributionKey,
    } };
  }
  if (subcommand === 'enable' || subcommand === 'disable') {
    assertOnlyAllowedFlags(args.slice(1), MACHINE_FLAGS);
    const target = await resolveTarget(args.slice(1), deps);
    if (subcommand === 'disable') {
      const disabledScope = 'connection' as const;
      const result = await deps.connections.setEnabled({
        action: 'setEnabled', machineId: target.machineId, connectionId: target.connection.connectionId,
        enabled: false, scope: disabledScope,
      });
      if (result.status === 'error') throwServiceError(result);
      return { ok: true, kind: 'providers_disable', data: {
        connectionId: target.connection.connectionId,
        contributionKey: target.connection.contributionKey,
        machineId: target.machineId,
        scope: disabledScope,
      } };
    }
    const enabled = await deps.connections.setEnabled({
      action: 'setEnabled', machineId: target.machineId,
      connectionId: target.connection.connectionId, enabled: true,
    });
    if (enabled.status === 'error') throwServiceError(enabled);
    return { ok: true, kind: `providers_${subcommand}`, data: {
      connectionId: target.connection.connectionId, contributionKey: target.connection.contributionKey,
      machineId: target.machineId, scope: enabled.scope,
    } };
  }
  if (subcommand === 'edit') {
    assertOnlyAllowedFlags(args.slice(1), EDIT_FLAGS);
    const target = await resolveTarget(args.slice(1), deps);
    const name = readFlag(args, '--name');
    const automaticName = hasFlag(args, '--automatic-name');
    const endpointTemplateId = readFlag(args, '--endpoint-template');
    const baseUrl = readFlag(args, '--base-url');
    const clearEndpoint = hasFlag(args, '--clear-endpoint');
    if ((name !== null || automaticName) && (endpointTemplateId !== null || baseUrl !== null || clearEndpoint)) {
      throw new ProviderCliError('invalid_arguments', 'Edit the name and endpoint in separate commands so each revision is explicit');
    }
    let result;
    if (endpointTemplateId !== null || baseUrl !== null || clearEndpoint) {
      if (!endpointTemplateId || (baseUrl === null) === !clearEndpoint) {
        throw new ProviderCliError('invalid_arguments', 'Endpoint edit requires --endpoint-template and exactly one of --base-url or --clear-endpoint');
      }
      result = await deps.connections.setEndpointOverride({
        action: 'setEndpointOverride', machineId: target.machineId,
        connectionId: target.connection.connectionId, expectedRevision: target.connection.revision,
        scope: requiredScope(args), endpointTemplateId, baseUrl: clearEndpoint ? null : baseUrl,
      });
    } else {
      if ((name === null) === !automaticName) {
        throw new ProviderCliError('invalid_arguments', 'Name edit requires exactly one of --name or --automatic-name');
      }
      result = await deps.connections.update({
        action: 'update', machineId: target.machineId,
        connectionId: target.connection.connectionId, expectedRevision: target.connection.revision,
        ...(automaticName
          ? { displayNameMode: 'automatic' as const }
          : { displayNameMode: 'custom' as const, displayName: name! }),
      });
    }
    if (result.status === 'error') throwServiceError(result);
    return { ok: true, kind: 'providers_edit', data: serializeConnectionDetail(result) };
  }
  if (subcommand === 'bind-secret' || subcommand === 'unbind-secret' || subcommand === 'replace-secret') {
    assertOnlyAllowedFlags(args.slice(1), SECRET_FLAGS);
    const target = await resolveTarget(args.slice(1), deps);
    const scope = requiredScope(args);
    let savedSecretId = subcommand === 'bind-secret'
      ? requireValue(readFlag(args, '--saved-secret-id'), '--saved-secret-id')
      : null;
    let preparedSavedSecret: Awaited<ReturnType<ProviderCliDependencies['createSavedSecret']>> | null = null;
    if (subcommand === 'replace-secret') {
      if (readFlag(args, '--saved-secret-id') !== null) {
        throw new ProviderCliError('invalid_arguments', 'replace-secret reads a no-echo secret; use bind-secret for an existing SavedSecret');
      }
      const value = await deps.promptSecret('Replacement API key (input hidden): ');
      if (!value.trim()) throw new ProviderCliError('invalid_arguments', 'Replacement API key cannot be empty');
      preparedSavedSecret = await deps.createSavedSecret({ name: `${target.connection.displayName} API key`, value });
      savedSecretId = preparedSavedSecret.id;
    } else if (subcommand === 'unbind-secret' && readFlag(args, '--saved-secret-id') !== null) {
      throw new ProviderCliError('invalid_arguments', 'unbind-secret does not accept --saved-secret-id');
    }
    const result = await deps.connections.bindSecret({
      action: 'bindSecret', machineId: target.machineId, connectionId: target.connection.connectionId,
      credentialSlotId: 'apiKey', savedSecretId, scope,
      ...(preparedSavedSecret ? { preparedSavedSecret } : {}),
    });
    if (result.status === 'error') throwServiceError(result);
    return { ok: true, kind: `providers_${subcommand.replace(/-/gu, '_')}`, data: serializeConnectionDetail(result) };
  }
  if (subcommand === 'add-model' || subcommand === 'remove-model') {
    assertOnlyAllowedFlags(args.slice(1), subcommand === 'add-model' ? MODEL_ADD_FLAGS : MODEL_REMOVE_FLAGS);
    const target = await resolveTarget(args.slice(1), deps);
    if (subcommand === 'add-model') {
      const parsed = parseProviderManualModelInput(requireValue(readFlag(args, '--models'), '--models'));
      if (parsed.accepted.length === 0) {
        throw new ProviderCliError('provider_model_not_found', 'No valid manual model ids were provided', { rejected: parsed.rejected });
      }
      const result = await deps.mutateModelSettings({
        action: 'manualAdd', machineId: target.machineId, connectionId: target.connection.connectionId,
        expectedConnectionRevision: target.connection.revision, models: parsed.accepted.map((id) => ({ id })),
      });
      if (result.status === 'error') throwServiceError(result);
      return { ok: true, kind: 'providers_add_model', data: { ...serializeConnection(target.connection), accepted: parsed.accepted, rejected: parsed.rejected } };
    }
    const modelId = requireProviderModelId(readRawFlag(args, '--model'));
    const result = await deps.mutateModelSettings({
      action: 'manualRemove', machineId: target.machineId, connectionId: target.connection.connectionId,
      expectedConnectionRevision: target.connection.revision, modelId,
    });
    if (result.status === 'error') throwServiceError(result);
    return { ok: true, kind: 'providers_remove_model', data: { ...serializeConnection(target.connection), modelId } };
  }
  if (subcommand === 'remove') {
    assertOnlyAllowedFlags(args.slice(1), REMOVE_FLAGS);
    const target = await resolveTarget(args.slice(1), deps);
    const removed = await deps.connections.delete({
      action: 'delete', machineId: target.machineId, connectionId: target.connection.connectionId,
    });
    if (removed.status === 'error') throwServiceError(removed);
    return { ok: true, kind: 'providers_remove', data: {
      connectionId: target.connection.connectionId,
      contributionKey: target.connection.contributionKey,
    } };
  }
  if (subcommand === 'probe' || subcommand === 'test' || subcommand === 'models' || subcommand === 'load-model') {
    assertOnlyAllowedFlags(args.slice(1), subcommand === 'load-model' ? LOAD_MODEL_FLAGS : MACHINE_FLAGS);
    const target = await resolveTarget(args.slice(1), deps);
    const common = { connectionId: target.connection.connectionId, machineId: target.machineId };
    if (subcommand === 'probe' || subcommand === 'test') {
      const result = await deps.probe(common);
      if (result.status === 'error') throwServiceError(result);
      return { ok: true, kind: `providers_${subcommand}`, data: result };
    }
    if (subcommand === 'models') return { ok: true, kind: 'providers_models', data: {
      ...common,
      contributionKey: target.connection.contributionKey,
      models: await deps.models(common),
    } };
    const modelId = requireProviderModelId(readRawFlag(args, '--model'));
    const result = await deps.loadModel({
      ...common,
      modelId,
      ...(context.signal ? { signal: context.signal } : {}),
    });
    if (result.status === 'error') throwServiceError(result);
    return { ok: true, kind: 'providers_load_model', data: result };
  }
  throw new ProviderCliError('unknown_subcommand', `Unknown providers subcommand '${subcommand}'`);
}
