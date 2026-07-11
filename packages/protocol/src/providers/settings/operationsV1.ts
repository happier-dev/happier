import { ProviderConnectionIdSchema, ProviderContributionKeySchema, ProviderLocalIdSchema, ProviderMachineIdSchema, ProviderModelIdSchema } from '../ids.js';
import { readOwnRecordValue } from '../ownRecordValue.js';
import {
  ModelVisibilityRefV1Schema,
  deserializeModelVisibilityRefV1,
  serializeModelVisibilityRefV1,
  type ModelVisibilityRefV1,
} from '../selection/v1.js';
import {
  PROVIDER_SETTINGS_LIMITS_V1,
  ProviderSettingsLimitError,
  ProviderSettingsV1Schema,
  assertProviderSettingsV1WithinLimits,
  type ProviderSettingsV1,
  ProviderManualModelV1Schema,
  ProviderExperimentalBindingConfirmationV1Schema,
} from './v1.js';

function requireProviderConnection(settings: ProviderSettingsV1, connectionIdInput: string) {
  const connectionId = ProviderConnectionIdSchema.parse(connectionIdInput);
  if (!settings.connections.some((connection) => connection.id === connectionId)) {
    throw new TypeError('Provider settings mutation references an unknown connection');
  }
  return connectionId;
}

export function addOrUpdateProviderManualModelV1(
  settings: ProviderSettingsV1,
  input: Readonly<{
    connectionId: string;
    model: Readonly<{ id: string; name?: string }>;
    addedAt: number;
  }>,
): ProviderSettingsV1 {
  return addOrUpdateProviderManualModelsV1(settings, {
    connectionId: input.connectionId,
    models: [input.model],
    addedAt: input.addedAt,
  });
}

export function addOrUpdateProviderManualModelsV1(
  settings: ProviderSettingsV1,
  input: Readonly<{
    connectionId: string;
    models: readonly Readonly<{ id: string; name?: string }>[];
    addedAt: number;
  }>,
): ProviderSettingsV1 {
  const parsed = assertProviderSettingsV1WithinLimits(settings);
  const connectionId = requireProviderConnection(parsed, input.connectionId);
  const seen = new Set<string>();
  const modelsToAdd = input.models.map((candidate) => {
    const model = ProviderManualModelV1Schema.parse({ ...candidate, addedAt: input.addedAt });
    if (seen.has(model.id)) throw new TypeError('Provider manual-model batch contains a duplicate model id');
    seen.add(model.id);
    return model;
  });
  const current = readOwnRecordValue(parsed.manualModelsByConnectionId, connectionId) ?? [];
  const replacements = new Map(modelsToAdd.map((model) => [model.id, model]));
  const models = current.map((candidate) => {
    const replacement = replacements.get(candidate.id);
    if (!replacement) return candidate;
    replacements.delete(candidate.id);
    return { ...replacement, addedAt: candidate.addedAt };
  });
  models.push(...replacements.values());
  return assertProviderSettingsV1WithinLimits({
    ...parsed,
    manualModelsByConnectionId: { ...parsed.manualModelsByConnectionId, [connectionId]: models },
  });
}

export function removeProviderManualModelV1(
  settings: ProviderSettingsV1,
  input: Readonly<{ connectionId: string; modelId: string }>,
): ProviderSettingsV1 {
  const parsed = assertProviderSettingsV1WithinLimits(settings);
  const connectionId = requireProviderConnection(parsed, input.connectionId);
  const modelId = ProviderModelIdSchema.parse(input.modelId);
  const current = readOwnRecordValue(parsed.manualModelsByConnectionId, connectionId) ?? [];
  const remaining = current.filter((candidate) => candidate.id !== modelId);
  const manualModelsByConnectionId = { ...parsed.manualModelsByConnectionId };
  if (remaining.length > 0) manualModelsByConnectionId[connectionId] = remaining;
  else delete manualModelsByConnectionId[connectionId];
  return assertProviderSettingsV1WithinLimits({ ...parsed, manualModelsByConnectionId });
}

export function setProviderModelVisibilityV1(
  settings: ProviderSettingsV1,
  input: Readonly<{ ref: ModelVisibilityRefV1; hidden: boolean }>,
): ProviderSettingsV1 {
  const parsed = assertProviderSettingsV1WithinLimits(settings);
  const ref = ModelVisibilityRefV1Schema.parse(input.ref);
  if (ref.providerConnectionId !== null) requireProviderConnection(parsed, ref.providerConnectionId);
  const key = serializeModelVisibilityRefV1(ref);
  const modelVisibilityByRef = { ...parsed.modelVisibilityByRef };
  if (input.hidden) modelVisibilityByRef[key] = 'hidden';
  else delete modelVisibilityByRef[key];
  return assertProviderSettingsV1WithinLimits({ ...parsed, modelVisibilityByRef });
}

export function resetProviderModelVisibilityV1(
  settings: ProviderSettingsV1,
  input: Readonly<{
    scope: Readonly<{ kind: 'agent'; agentTargetKey: string } | { kind: 'connection'; connectionId: string }>;
  }>,
): ProviderSettingsV1 {
  const parsed = assertProviderSettingsV1WithinLimits(settings);
  if (input.scope.kind === 'connection') requireProviderConnection(parsed, input.scope.connectionId);
  const modelVisibilityByRef = Object.fromEntries(Object.entries(parsed.modelVisibilityByRef).filter(([key]) => {
    const ref = deserializeModelVisibilityRefV1(key);
    return input.scope.kind === 'agent'
      ? !(ref.scope === 'agent' && ref.agentTargetKey === input.scope.agentTargetKey)
      : ref.providerConnectionId !== input.scope.connectionId;
  }));
  return assertProviderSettingsV1WithinLimits({ ...parsed, modelVisibilityByRef });
}

export function setProviderExperimentalConfirmationV1(
  settings: ProviderSettingsV1,
  input: Readonly<{
    connectionId: string;
    agentTargetKey: string;
    modelId: string | null;
    compatibilityFingerprint: string;
    confirmedAt: number;
  }>,
): ProviderSettingsV1 {
  const parsed = assertProviderSettingsV1WithinLimits(settings);
  const connectionId = requireProviderConnection(parsed, input.connectionId);
  const confirmation = ProviderExperimentalBindingConfirmationV1Schema.parse({ v: 1, ...input, connectionId });
  const remaining = parsed.experimentalBindingConfirmations.filter((candidate) => !(
    candidate.connectionId === confirmation.connectionId
    && candidate.agentTargetKey === confirmation.agentTargetKey
    && candidate.modelId === confirmation.modelId
  ));
  return assertProviderSettingsV1WithinLimits({
    ...parsed,
    experimentalBindingConfirmations: [...remaining, confirmation],
  });
}

export function ensureDefaultProviderConnectionV1(
  settings: ProviderSettingsV1,
  input: Readonly<{
    contributionKey: string;
    allocatedConnectionId: string;
    providerName: string;
    now: number;
  }>,
): Readonly<{
  settings: ProviderSettingsV1;
  connection: ProviderSettingsV1['connections'][number];
  changed: boolean;
}> {
  const parsedSettings = assertProviderSettingsV1WithinLimits(settings);
  const contributionKey = ProviderContributionKeySchema.parse(input.contributionKey);
  const existing = parsedSettings.connections.find((connection) =>
    connection.role === 'default'
    && connection.source.kind === 'contribution'
    && connection.source.contributionKey === contributionKey);
  if (existing) return { settings: parsedSettings, connection: existing, changed: false };
  if (parsedSettings.connections.length >= PROVIDER_SETTINGS_LIMITS_V1.connections) {
    throw new ProviderSettingsLimitError('Provider connection limit reached');
  }
  const id = ProviderConnectionIdSchema.parse(input.allocatedConnectionId);
  if (!Number.isFinite(input.now) || input.now < 0) throw new TypeError('Connection creation time must be non-negative');
  if (parsedSettings.connections.some((connection) => connection.id === id)
    || parsedSettings.connectionTombstones.some((tombstone) => tombstone.id === id)) {
    throw new TypeError('Allocated provider connection id is already used');
  }
  const displayName = input.providerName.trim();
  if (!displayName || displayName.length > 128) throw new TypeError('Provider name is invalid');
  const connection = {
    v: 1 as const,
    id,
    source: { kind: 'contribution' as const, contributionKey },
    role: 'default' as const,
    displayName,
    displayNameMode: 'automatic' as const,
    revision: 0,
    createdAt: input.now,
    updatedAt: input.now,
  };
  const next = assertProviderSettingsV1WithinLimits({
    ...parsedSettings,
    connections: [...parsedSettings.connections, connection],
  });
  return { settings: next, connection: next.connections[next.connections.length - 1]!, changed: true };
}

export type ProviderGrantResolutionV1 =
  | Readonly<{ authorized: true; grantKind: 'account' | 'machine' }>
  | Readonly<{
      authorized: false;
      errorCode:
        | 'provider_connection_not_found'
        | 'provider_connection_disabled'
        | 'provider_account_grant_stale'
        | 'provider_not_enabled_on_machine'
        | 'provider_machine_grant_stale';
    }>;

export function resolveProviderGrantV1(
  settings: ProviderSettingsV1,
  input: Readonly<{
    scope: 'account' | 'machine';
    connectionId: string;
    machineId: string;
    connectionSecurityFingerprint: string;
    endpointSetFingerprint: string;
  }>,
): ProviderGrantResolutionV1 {
  const connectionId = ProviderConnectionIdSchema.parse(input.connectionId);
  if (!settings.connections.some((connection) => connection.id === connectionId)) {
    return { authorized: false, errorCode: 'provider_connection_not_found' };
  }
  if (input.scope === 'account') {
    const grant = settings.accountGrants.find((candidate) => candidate.connectionId === connectionId);
    if (!grant) return { authorized: false, errorCode: 'provider_connection_disabled' };
    if (grant.connectionSecurityFingerprint !== input.connectionSecurityFingerprint) {
      return { authorized: false, errorCode: 'provider_account_grant_stale' };
    }
    return { authorized: true, grantKind: 'account' };
  }
  const machineId = ProviderMachineIdSchema.parse(input.machineId);
  const grant = settings.machineGrants.find((candidate) =>
    candidate.connectionId === connectionId && candidate.machineId === machineId);
  if (!grant) return { authorized: false, errorCode: 'provider_not_enabled_on_machine' };
  if (grant.connectionSecurityFingerprint !== input.connectionSecurityFingerprint
    || grant.endpointSetFingerprint !== input.endpointSetFingerprint) {
    return { authorized: false, errorCode: 'provider_machine_grant_stale' };
  }
  return { authorized: true, grantKind: 'machine' };
}

export function resolveProviderSecretBindingIdV1(
  settings: ProviderSettingsV1,
  connectionIdInput: string,
  machineIdInput: string,
  credentialSlotId: string,
): string | null {
  const connectionId = ProviderConnectionIdSchema.parse(connectionIdInput);
  const machineId = ProviderMachineIdSchema.parse(machineIdInput);
  const credentialSlot = ProviderLocalIdSchema.parse(credentialSlotId);
  const bindings = readOwnRecordValue(settings.secretBindingsByConnectionId, connectionId);
  const machineBindings = readOwnRecordValue(bindings?.byMachineId, machineId);
  return readOwnRecordValue(machineBindings, credentialSlot)
    ?? readOwnRecordValue(bindings?.account, credentialSlot)
    ?? null;
}

export function removeProviderMachineStateV1(
  settings: ProviderSettingsV1,
  machineIdInput: string,
): ProviderSettingsV1 {
  const machineId = ProviderMachineIdSchema.parse(machineIdInput);
  const connections = settings.connections.map((connection) => {
    const overridesByMachine = connection.endpointOverridesByMachineId;
    if (!overridesByMachine || !readOwnRecordValue(overridesByMachine, machineId)) return connection;
    const { [machineId]: _removed, ...remaining } = overridesByMachine;
    const { endpointOverridesByMachineId: _previous, ...base } = connection;
    return Object.keys(remaining).length > 0 ? { ...base, endpointOverridesByMachineId: remaining } : base;
  });
  const secretBindingsByConnectionId: Record<string, unknown> = {};
  for (const [connectionId, bindings] of Object.entries(settings.secretBindingsByConnectionId)) {
    const { [machineId]: _removed, ...remainingMachines } = bindings.byMachineId ?? {};
    const next = {
      ...(bindings.account ? { account: bindings.account } : {}),
      ...(Object.keys(remainingMachines).length > 0 ? { byMachineId: remainingMachines } : {}),
    };
    if (Object.keys(next).length > 0) secretBindingsByConnectionId[connectionId] = next;
  }
  return ProviderSettingsV1Schema.parse({
    ...settings,
    connections,
    machineGrants: settings.machineGrants.filter((grant) => grant.machineId !== machineId),
    secretBindingsByConnectionId,
  });
}

export function deleteProviderConnectionV1(
  settings: ProviderSettingsV1,
  connectionIdInput: string,
  deletedAt: number,
): ProviderSettingsV1 {
  const connectionId = ProviderConnectionIdSchema.parse(connectionIdInput);
  const connection = settings.connections.find((candidate) => candidate.id === connectionId);
  if (!connection) return ProviderSettingsV1Schema.parse(settings);
  if (!Number.isFinite(deletedAt) || deletedAt < 0) throw new TypeError('Deletion time must be non-negative');

  const secretBindingsByConnectionId = { ...settings.secretBindingsByConnectionId };
  const manualModelsByConnectionId = { ...settings.manualModelsByConnectionId };
  delete secretBindingsByConnectionId[connectionId];
  delete manualModelsByConnectionId[connectionId];
  const modelVisibilityByRef = Object.fromEntries(Object.entries(settings.modelVisibilityByRef).filter(([key]) => {
    try { return deserializeModelVisibilityRefV1(key).providerConnectionId !== connectionId; } catch { return false; }
  }));
  const defaultsByAgentTargetKey = Object.fromEntries(Object.entries(settings.defaultsByAgentTargetKey).filter(([, selection]) =>
    selection.ref.providerConnectionId !== connectionId));
  const connectionTombstones = [
    ...settings.connectionTombstones,
    {
      v: 1 as const,
      id: connectionId,
      contributionKey: connection.source.kind === 'contribution' ? connection.source.contributionKey : null,
      lastDisplayName: connection.displayName,
      deletedAt,
    },
  ].sort((a, b) => a.deletedAt - b.deletedAt || a.id.localeCompare(b.id));
  const retainedTombstones = connectionTombstones.slice(
    Math.max(0, connectionTombstones.length - PROVIDER_SETTINGS_LIMITS_V1.connectionTombstones),
  );
  return ProviderSettingsV1Schema.parse({
    ...settings,
    connections: settings.connections.filter((candidate) => candidate.id !== connectionId),
    connectionTombstones: retainedTombstones,
    accountGrants: settings.accountGrants.filter((grant) => grant.connectionId !== connectionId),
    machineGrants: settings.machineGrants.filter((grant) => grant.connectionId !== connectionId),
    secretBindingsByConnectionId,
    manualModelsByConnectionId,
    modelVisibilityByRef,
    experimentalBindingConfirmations: settings.experimentalBindingConfirmations.filter((confirmation) =>
      confirmation.connectionId !== connectionId),
    defaultsByAgentTargetKey,
  });
}
