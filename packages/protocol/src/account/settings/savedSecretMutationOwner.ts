import {
  SavedSecretSchema,
  type SavedSecret,
} from '../../profiles/backendProfileSchema.js';
import type { SecretStringV1 } from '../../crypto/settingsSecretStringsV1.js';

const SECRETS_KEY = 'secrets';
const PROFILE_BINDINGS_KEY = 'secretBindingsByProfileId';
const PROVIDER_SETTINGS_KEY = 'providerSettingsV1';
const VOICE_SETTINGS_KEYS = ['voice', 'voiceSettingsV1'] as const;
const MCP_SETTINGS_KEY = 'mcpServersSettingsV1';
const ACP_SETTINGS_KEY = 'acpCatalogSettingsV1';
export const CONNECTED_ACCOUNT_SERVICE_CONFIGURATIONS_SETTINGS_KEY =
  'connectedAccountServiceConfigurationsV1';

export type AccountSettingsSavedSecretReferenceOwner =
  | 'profile'
  | 'provider'
  | 'voice'
  | 'mcp'
  | 'acp'
  | 'connectedAccountConfiguration'
  | 'unknown';

export type AccountSettingsSavedSecretReference = Readonly<{
  owner: AccountSettingsSavedSecretReferenceOwner;
  path: string;
}>;

export type AccountSettingsSavedSecretMutation =
  | Readonly<{
      kind: 'add';
      secret: SavedSecret;
    }>
  | Readonly<{
      kind: 'rename';
      secretId: string;
      expectedUpdatedAt: number;
      name: string;
      updatedAt: number;
    }>
  | Readonly<{
      kind: 'rotateGlobal';
      secretId: string;
      expectedUpdatedAt: number;
      encryptedValue: SecretStringV1;
      updatedAt: number;
    }>
  | Readonly<{
      kind: 'delete';
      secretId: string;
      expectedUpdatedAt: number;
    }>
  | Readonly<{
      kind: 'replaceVoiceCredentialSecret';
      target: Readonly<{
        settingsKey: 'voice' | 'voiceSettingsV1';
        providerId: string;
        credentialSlotId: string;
        machineId: string | null;
      }>;
      expectedSecretId: string | null;
      expectedSecretUpdatedAt: number | null;
      secret: SavedSecret;
      approvedRecipientContractDigest?: string;
    }>
  | Readonly<{
      kind: 'approveVoiceCredentialRecipientContract';
      target: Readonly<{
        settingsKey: 'voice' | 'voiceSettingsV1';
        providerId: string;
        credentialSlotId: string;
        machineId: string | null;
      }>;
      expectedSecretId: string;
      expectedSecretUpdatedAt: number;
      approvedRecipientContractDigest: string;
    }>
  | Readonly<{
      kind: 'removeVoiceCredentialSecret';
      target: Readonly<{
        settingsKey: 'voice' | 'voiceSettingsV1';
        providerId: string;
        credentialSlotId: string;
        machineId: string | null;
      }>;
      expectedSecretId: string;
      expectedSecretUpdatedAt: number;
    }>;

export class AccountSettingsSavedSecretMutationError extends Error {
  readonly code:
    | 'saved_secret_invalid'
    | 'saved_secret_conflict'
    | 'saved_secret_not_found'
    | 'saved_secret_in_use'
    | 'saved_secret_referenced_by_connected_account_configuration'
    | 'saved_secret_reference_invalid';
  readonly references: readonly AccountSettingsSavedSecretReference[];

  constructor(
    code: AccountSettingsSavedSecretMutationError['code'],
    message: string,
    references: readonly AccountSettingsSavedSecretReference[] = [],
  ) {
    super(message);
    this.name = 'AccountSettingsSavedSecretMutationError';
    this.code = code;
    this.references = Object.freeze([...references]);
  }
}

type MutableRecord = Record<string, unknown>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return isRecord(value) ? value : null;
}

function pathSegment(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key)
    ? `.${key}`
    : `[${JSON.stringify(key)}]`;
}

function readSavedSecrets(
  settings: Readonly<Record<string, unknown>>,
): readonly SavedSecret[] {
  const raw = settings[SECRETS_KEY];
  if (raw === undefined) return Object.freeze([]);
  if (!Array.isArray(raw)) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_invalid',
      'Account Settings SavedSecret collection is invalid',
    );
  }
  try {
    const validated = raw.map((entry) => {
      SavedSecretSchema.parse(entry);
      return entry as SavedSecret;
    });
    if (new Set(validated.map((entry) => entry.id)).size !== validated.length) {
      throw new Error('duplicate SavedSecret identity');
    }
    return Object.freeze(validated);
  } catch {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_invalid',
      'Account Settings SavedSecret collection is invalid',
    );
  }
}

function collectSlotBindingReferences(input: Readonly<{
  value: unknown;
  secretId: string;
  owner: 'provider' | 'voice';
  path: string;
  output: AccountSettingsSavedSecretReference[];
}>): void {
  const root = ownRecord(input.value);
  if (!root) return;
  const account = ownRecord(root.account);
  if (account) {
    for (const [slotId, candidate] of Object.entries(account)) {
      if (candidate === input.secretId) {
        input.output.push(Object.freeze({
          owner: input.owner,
          path: `${input.path}.account${pathSegment(slotId)}`,
        }));
      }
    }
  }
  const byMachineId = ownRecord(root.byMachineId);
  if (!byMachineId) return;
  for (const [machineId, rawBindings] of Object.entries(byMachineId)) {
    const bindings = ownRecord(rawBindings);
    if (!bindings) continue;
    for (const [slotId, candidate] of Object.entries(bindings)) {
      if (candidate === input.secretId) {
        input.output.push(Object.freeze({
          owner: input.owner,
          path: `${input.path}.byMachineId${pathSegment(machineId)}${pathSegment(slotId)}`,
        }));
      }
    }
  }
}

function collectValueRefMapReferences(input: Readonly<{
  value: unknown;
  secretId: string;
  owner: 'mcp' | 'acp';
  path: string;
  output: AccountSettingsSavedSecretReference[];
}>): void {
  const valueRefMap = ownRecord(input.value);
  if (!valueRefMap) return;
  for (const [key, candidate] of Object.entries(valueRefMap)) {
    const valueRef = ownRecord(candidate);
    if (valueRef?.t === 'savedSecret' && valueRef.secretId === input.secretId) {
      input.output.push(Object.freeze({
        owner: input.owner,
        path: `${input.path}${pathSegment(key)}`,
      }));
    }
  }
}

function collectMcpReferences(
  settings: Readonly<Record<string, unknown>>,
  secretId: string,
  output: AccountSettingsSavedSecretReference[],
): void {
  const root = ownRecord(settings[MCP_SETTINGS_KEY]);
  if (!root) return;
  if (Array.isArray(root.servers)) {
    root.servers.forEach((candidate, index) => {
      const server = ownRecord(candidate);
      if (!server) return;
      collectValueRefMapReferences({
        value: server.env,
        secretId,
        owner: 'mcp',
        path: `${MCP_SETTINGS_KEY}.servers[${index}].env`,
        output,
      });
      const remote = ownRecord(server.remote);
      collectValueRefMapReferences({
        value: remote?.headers,
        secretId,
        owner: 'mcp',
        path: `${MCP_SETTINGS_KEY}.servers[${index}].remote.headers`,
        output,
      });
    });
  }
  if (Array.isArray(root.bindings)) {
    root.bindings.forEach((candidate, index) => {
      const binding = ownRecord(candidate);
      const overrides = ownRecord(binding?.overrides);
      if (!overrides) return;
      collectValueRefMapReferences({
        value: overrides.envPatch,
        secretId,
        owner: 'mcp',
        path: `${MCP_SETTINGS_KEY}.bindings[${index}].overrides.envPatch`,
        output,
      });
      const remote = ownRecord(overrides.remote);
      collectValueRefMapReferences({
        value: remote?.headersPatch,
        secretId,
        owner: 'mcp',
        path: `${MCP_SETTINGS_KEY}.bindings[${index}].overrides.remote.headersPatch`,
        output,
      });
    });
  }
}

function collectAcpReferences(
  settings: Readonly<Record<string, unknown>>,
  secretId: string,
  output: AccountSettingsSavedSecretReference[],
): void {
  const root = ownRecord(settings[ACP_SETTINGS_KEY]);
  if (!root || !Array.isArray(root.backends)) return;
  root.backends.forEach((candidate, index) => {
    const backend = ownRecord(candidate);
    if (!backend) return;
    collectValueRefMapReferences({
      value: backend.env,
      secretId,
      owner: 'acp',
      path: `${ACP_SETTINGS_KEY}.backends[${index}].env`,
      output,
    });
  });
}

function collectProviderReferences(
  settings: Readonly<Record<string, unknown>>,
  secretId: string,
  output: AccountSettingsSavedSecretReference[],
): void {
  const provider = ownRecord(settings[PROVIDER_SETTINGS_KEY]);
  const bindingsByConnectionId = ownRecord(provider?.secretBindingsByConnectionId);
  if (!bindingsByConnectionId) return;
  for (const [connectionId, bindings] of Object.entries(bindingsByConnectionId)) {
    collectSlotBindingReferences({
      value: bindings,
      secretId,
      owner: 'provider',
      path: `${PROVIDER_SETTINGS_KEY}.secretBindingsByConnectionId${pathSegment(connectionId)}`,
      output,
    });
  }
}

function collectVoiceReferences(
  settings: Readonly<Record<string, unknown>>,
  secretId: string,
  output: AccountSettingsSavedSecretReference[],
): void {
  for (const rootKey of VOICE_SETTINGS_KEYS) {
    const voice = ownRecord(settings[rootKey]);
    if (!Array.isArray(voice?.credentialBindings)) continue;
    voice.credentialBindings.forEach((candidate, index) => {
      const binding = ownRecord(candidate);
      if (!binding) return;
      collectSlotBindingReferences({
        value: binding.credentialBindings,
        secretId,
        owner: 'voice',
        path: `${rootKey}.credentialBindings[${index}].credentialBindings`,
        output,
      });
    });
  }
}

type VoiceCredentialTarget = Readonly<{
  settingsKey: 'voice' | 'voiceSettingsV1';
  providerId: string;
  credentialSlotId: string;
  machineId: string | null;
}>;

type VoiceCredentialTargetState = Readonly<{
  root: Readonly<Record<string, unknown>>;
  credentialBindings: readonly Readonly<Record<string, unknown>>[];
  bindingIndex: number;
  binding: Readonly<Record<string, unknown>> | null;
  exactSecretId: string | null;
}>;

function readVoiceCredentialTarget(
  settings: Readonly<Record<string, unknown>>,
  target: VoiceCredentialTarget,
): VoiceCredentialTargetState {
  const rawRoot = settings[target.settingsKey];
  const root = rawRoot === undefined ? {} : ownRecord(rawRoot);
  if (!root || (root.credentialBindings !== undefined && !Array.isArray(root.credentialBindings))) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_reference_invalid',
      'Voice credential references are invalid',
    );
  }
  const credentialBindings = (root.credentialBindings ?? []) as readonly unknown[];
  const parsed = credentialBindings.map((candidate) => {
    const binding = ownRecord(candidate);
    const slotBindings = ownRecord(binding?.credentialBindings);
    if (
      !binding
      || typeof binding.providerId !== 'string'
      || !slotBindings
    ) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_reference_invalid',
        'Voice credential reference is invalid',
      );
    }
    return binding;
  });
  const matchingIndexes = parsed.flatMap((binding, index) => (
    binding.providerId === target.providerId ? [index] : []
  ));
  if (matchingIndexes.length > 1) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_reference_invalid',
      'Voice credential target is duplicated',
    );
  }
  const bindingIndex = matchingIndexes[0] ?? -1;
  const binding = bindingIndex >= 0 ? parsed[bindingIndex]! : null;
  const slotBindings = ownRecord(binding?.credentialBindings);
  const account = ownRecord(slotBindings?.account);
  const byMachineId = ownRecord(slotBindings?.byMachineId);
  const machineBindings = target.machineId
    ? ownRecord(byMachineId?.[target.machineId])
    : null;
  const candidate = target.machineId
    ? machineBindings?.[target.credentialSlotId]
    : account?.[target.credentialSlotId];
  if (candidate !== undefined && typeof candidate !== 'string') {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_reference_invalid',
      'Voice credential target reference is invalid',
    );
  }
  return Object.freeze({
    root,
    credentialBindings: Object.freeze(parsed),
    bindingIndex,
    binding,
    exactSecretId: typeof candidate === 'string' ? candidate : null,
  });
}

function writeVoiceCredentialTarget(input: Readonly<{
  settings: Readonly<Record<string, unknown>>;
  target: VoiceCredentialTarget;
  state: VoiceCredentialTargetState;
  secretId: string | null;
  approvedRecipientContractDigest?: string;
}>): Readonly<Record<string, unknown>> {
  const existingSlotBindings = ownRecord(input.state.binding?.credentialBindings) ?? {};
  const account = { ...(ownRecord(existingSlotBindings.account) ?? {}) };
  const byMachineId = { ...(ownRecord(existingSlotBindings.byMachineId) ?? {}) };
  if (input.target.machineId) {
    const machine = {
      ...(ownRecord(byMachineId[input.target.machineId]) ?? {}),
    };
    if (input.secretId) {
      machine[input.target.credentialSlotId] = input.secretId;
    } else {
      delete machine[input.target.credentialSlotId];
    }
    if (Object.keys(machine).length > 0) {
      byMachineId[input.target.machineId] = machine;
    } else {
      delete byMachineId[input.target.machineId];
    }
  } else if (input.secretId) {
    account[input.target.credentialSlotId] = input.secretId;
  } else {
    delete account[input.target.credentialSlotId];
  }
  const nextSlotBindings: MutableRecord = { ...existingSlotBindings };
  if (Object.keys(account).length > 0) nextSlotBindings.account = account;
  else delete nextSlotBindings.account;
  if (Object.keys(byMachineId).length > 0) nextSlotBindings.byMachineId = byMachineId;
  else delete nextSlotBindings.byMachineId;

  const credentialBindings = [...input.state.credentialBindings];
  if (Object.keys(nextSlotBindings).length === 0 && input.state.bindingIndex >= 0) {
    credentialBindings.splice(input.state.bindingIndex, 1);
  } else {
    const nextBinding = {
      ...(input.state.binding ?? {}),
      providerId: input.target.providerId,
      credentialBindings: nextSlotBindings,
      ...(input.approvedRecipientContractDigest === undefined
        ? {}
        : {
            approvedRecipientContractDigest:
              input.approvedRecipientContractDigest,
          }),
    };
    if (input.state.bindingIndex >= 0) {
      credentialBindings[input.state.bindingIndex] = nextBinding;
    } else {
      credentialBindings.push(nextBinding);
    }
  }
  return Object.freeze({
    ...input.settings,
    [input.target.settingsKey]: {
      ...input.state.root,
      credentialBindings,
    },
  });
}

type ConnectedAccountConfigurationEntry = Readonly<{
  raw: Readonly<Record<string, unknown>>;
  service: Readonly<{ pluginId: string; localId: string }>;
  modeId: string;
  revision: string;
  secretRefs: Readonly<Record<string, unknown>>;
}>;

function readConnectedAccountConfigurationEntries(
  settings: Readonly<Record<string, unknown>>,
): readonly ConnectedAccountConfigurationEntry[] {
  const rawStore = settings[CONNECTED_ACCOUNT_SERVICE_CONFIGURATIONS_SETTINGS_KEY];
  if (rawStore === undefined) return Object.freeze([]);
  const store = ownRecord(rawStore);
  if (store === null || store.v !== 1 || !Array.isArray(store.entries)) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_reference_invalid',
      'Connected Account service configuration references are invalid',
    );
  }
  const targets = new Set<string>();
  return Object.freeze(store.entries.map((candidate) => {
    const raw = ownRecord(candidate);
    const service = ownRecord(raw?.service);
    const secretRefs = ownRecord(raw?.secretRefs);
    if (
      !raw
      || !service
      || !secretRefs
      || typeof service.pluginId !== 'string'
      || typeof service.localId !== 'string'
      || typeof raw.modeId !== 'string'
      || typeof raw.revision !== 'string'
    ) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_reference_invalid',
        'Connected Account service configuration reference is invalid',
      );
    }
    const targetKey = JSON.stringify([
      service.pluginId,
      service.localId,
      raw.modeId,
    ]);
    if (targets.has(targetKey)) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_reference_invalid',
        'Connected Account service configuration target is duplicated',
      );
    }
    targets.add(targetKey);
    return Object.freeze({
      raw,
      service: Object.freeze({
        pluginId: service.pluginId,
        localId: service.localId,
      }),
      modeId: raw.modeId,
      revision: raw.revision,
      secretRefs,
    });
  }));
}

function collectConnectedAccountReferences(
  settings: Readonly<Record<string, unknown>>,
  secretId: string,
  output: AccountSettingsSavedSecretReference[],
): void {
  readConnectedAccountConfigurationEntries(settings).forEach((entry, index) => {
    for (const [fieldId, candidate] of Object.entries(entry.secretRefs)) {
      if (candidate === secretId) {
        output.push(Object.freeze({
          owner: 'connectedAccountConfiguration',
          path: `${CONNECTED_ACCOUNT_SERVICE_CONFIGURATIONS_SETTINGS_KEY}.entries[${index}].secretRefs${pathSegment(fieldId)}`,
        }));
      }
    }
  });
}

function invalidReferenceRoot(message: string): never {
  throw new AccountSettingsSavedSecretMutationError(
    'saved_secret_reference_invalid',
    message,
  );
}

function validateStringMap(value: unknown, message: string): void {
  if (value === undefined) return;
  const record = ownRecord(value);
  if (!record) invalidReferenceRoot(message);
  if (Object.values(record).some((candidate) => typeof candidate !== 'string')) {
    invalidReferenceRoot(message);
  }
}

function validateSlotBindings(value: unknown, message: string): void {
  const root = ownRecord(value);
  if (!root) invalidReferenceRoot(message);
  validateStringMap(root.account, message);
  if (root.byMachineId === undefined) return;
  const byMachineId = ownRecord(root.byMachineId);
  if (!byMachineId) invalidReferenceRoot(message);
  Object.values(byMachineId).forEach((bindings) => {
    validateStringMap(bindings, message);
  });
}

function validateValueRefMap(
  value: unknown,
  message: string,
  allowNull: boolean,
): void {
  if (value === undefined) return;
  const record = ownRecord(value);
  if (!record) invalidReferenceRoot(message);
  Object.values(record).forEach((candidate) => {
    if (candidate === null && allowNull) return;
    const valueRef = ownRecord(candidate);
    if (
      !valueRef
      || (
        valueRef.t === 'savedSecret'
          ? typeof valueRef.secretId !== 'string'
          : valueRef.t === 'literal'
            ? typeof valueRef.v !== 'string'
            : true
      )
    ) {
      invalidReferenceRoot(message);
    }
  });
}

function validateKnownSavedSecretReferenceRoots(
  settings: Readonly<Record<string, unknown>>,
): void {
  if (settings[PROFILE_BINDINGS_KEY] !== undefined) {
    const profiles = ownRecord(settings[PROFILE_BINDINGS_KEY]);
    if (!profiles) invalidReferenceRoot('Profile SavedSecret references are invalid');
    Object.values(profiles).forEach((bindings) => {
      validateStringMap(bindings, 'Profile SavedSecret reference is invalid');
    });
  }

  if (settings[PROVIDER_SETTINGS_KEY] !== undefined) {
    const provider = ownRecord(settings[PROVIDER_SETTINGS_KEY]);
    if (!provider) invalidReferenceRoot('Provider SavedSecret references are invalid');
    if (provider.secretBindingsByConnectionId !== undefined) {
      const connections = ownRecord(provider.secretBindingsByConnectionId);
      if (!connections) invalidReferenceRoot('Provider SavedSecret references are invalid');
      Object.values(connections).forEach((bindings) => {
        validateSlotBindings(bindings, 'Provider SavedSecret reference is invalid');
      });
    }
  }

  for (const rootKey of VOICE_SETTINGS_KEYS) {
    if (settings[rootKey] === undefined) continue;
    const voice = ownRecord(settings[rootKey]);
    if (!voice) invalidReferenceRoot('Voice SavedSecret references are invalid');
    if (voice.credentialBindings === undefined) continue;
    if (!Array.isArray(voice.credentialBindings)) {
      invalidReferenceRoot('Voice SavedSecret references are invalid');
    }
    voice.credentialBindings.forEach((candidate) => {
      const binding = ownRecord(candidate);
      if (!binding || typeof binding.providerId !== 'string') {
        invalidReferenceRoot('Voice SavedSecret reference is invalid');
      }
      validateSlotBindings(
        binding.credentialBindings,
        'Voice SavedSecret reference is invalid',
      );
    });
  }

  if (settings[MCP_SETTINGS_KEY] !== undefined) {
    const mcp = ownRecord(settings[MCP_SETTINGS_KEY]);
    if (!mcp) invalidReferenceRoot('MCP SavedSecret references are invalid');
    if (mcp.servers !== undefined && !Array.isArray(mcp.servers)) {
      invalidReferenceRoot('MCP SavedSecret references are invalid');
    }
    if (Array.isArray(mcp.servers)) {
      mcp.servers.forEach((candidate) => {
        const server = ownRecord(candidate);
        if (!server) invalidReferenceRoot('MCP SavedSecret reference is invalid');
        validateValueRefMap(
          server.env,
          'MCP SavedSecret reference is invalid',
          false,
        );
        if (server.remote !== undefined) {
          const remote = ownRecord(server.remote);
          if (!remote) invalidReferenceRoot('MCP SavedSecret reference is invalid');
          validateValueRefMap(
            remote.headers,
            'MCP SavedSecret reference is invalid',
            false,
          );
        }
      });
    }
    if (mcp.bindings !== undefined && !Array.isArray(mcp.bindings)) {
      invalidReferenceRoot('MCP SavedSecret references are invalid');
    }
    if (Array.isArray(mcp.bindings)) {
      mcp.bindings.forEach((candidate) => {
        const binding = ownRecord(candidate);
        if (!binding) invalidReferenceRoot('MCP SavedSecret reference is invalid');
        if (binding.overrides === undefined) return;
        const overrides = ownRecord(binding.overrides);
        if (!overrides) invalidReferenceRoot('MCP SavedSecret reference is invalid');
        validateValueRefMap(
          overrides.envPatch,
          'MCP SavedSecret reference is invalid',
          true,
        );
        if (overrides.remote !== undefined) {
          const remote = ownRecord(overrides.remote);
          if (!remote) invalidReferenceRoot('MCP SavedSecret reference is invalid');
          validateValueRefMap(
            remote.headersPatch,
            'MCP SavedSecret reference is invalid',
            true,
          );
        }
      });
    }
  }

  if (settings[ACP_SETTINGS_KEY] !== undefined) {
    const acp = ownRecord(settings[ACP_SETTINGS_KEY]);
    if (!acp) invalidReferenceRoot('ACP SavedSecret references are invalid');
    if (acp.backends !== undefined && !Array.isArray(acp.backends)) {
      invalidReferenceRoot('ACP SavedSecret references are invalid');
    }
    if (Array.isArray(acp.backends)) {
      acp.backends.forEach((candidate) => {
        const backend = ownRecord(candidate);
        if (!backend) invalidReferenceRoot('ACP SavedSecret reference is invalid');
        validateValueRefMap(
          backend.env,
          'ACP SavedSecret reference is invalid',
          false,
        );
      });
    }
  }
}

export function listAccountSettingsSavedSecretReferences(
  settings: Readonly<Record<string, unknown>>,
  secretId: string,
): readonly AccountSettingsSavedSecretReference[] {
  if (!secretId) return Object.freeze([]);
  validateKnownSavedSecretReferenceRoots(settings);
  const output: AccountSettingsSavedSecretReference[] = [];
  const profiles = ownRecord(settings[PROFILE_BINDINGS_KEY]);
  if (profiles) {
    for (const [profileId, rawBindings] of Object.entries(profiles)) {
      const bindings = ownRecord(rawBindings);
      if (!bindings) continue;
      for (const [fieldId, candidate] of Object.entries(bindings)) {
        if (candidate === secretId) {
          output.push(Object.freeze({
            owner: 'profile',
            path: `${PROFILE_BINDINGS_KEY}${pathSegment(profileId)}${pathSegment(fieldId)}`,
          }));
        }
      }
    }
  }
  collectProviderReferences(settings, secretId, output);
  collectVoiceReferences(settings, secretId, output);
  collectMcpReferences(settings, secretId, output);
  collectAcpReferences(settings, secretId, output);
  collectConnectedAccountReferences(settings, secretId, output);
  return Object.freeze(output);
}

function findSecret(
  secrets: readonly SavedSecret[],
  secretId: string,
  expectedUpdatedAt: number,
): Readonly<{ index: number; secret: SavedSecret }> {
  const index = secrets.findIndex((candidate) => candidate.id === secretId);
  if (index < 0) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_not_found',
      'SavedSecret does not exist',
    );
  }
  const secret = secrets[index]!;
  if (secret.updatedAt !== expectedUpdatedAt) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_conflict',
      'SavedSecret changed before the mutation settled',
    );
  }
  return Object.freeze({ index, secret });
}

export function applyAccountSettingsSavedSecretMutation(
  settings: Readonly<Record<string, unknown>>,
  mutation: AccountSettingsSavedSecretMutation,
): Readonly<{
  settings: Readonly<Record<string, unknown>>;
}> {
  const mutationKind = (mutation as Readonly<{ kind?: unknown }>).kind;
  if (
    mutationKind !== 'add'
    && mutationKind !== 'rename'
    && mutationKind !== 'rotateGlobal'
    && mutationKind !== 'delete'
    && mutationKind !== 'replaceVoiceCredentialSecret'
    && mutationKind !== 'approveVoiceCredentialRecipientContract'
    && mutationKind !== 'removeVoiceCredentialSecret'
  ) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_invalid',
      'SavedSecret mutation kind is invalid',
    );
  }
  const secrets = readSavedSecrets(settings);
  if (mutation.kind === 'add') {
    const parsed = SavedSecretSchema.safeParse(mutation.secret);
    if (!parsed.success) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_invalid',
        'SavedSecret is invalid',
      );
    }
    if (secrets.some((candidate) => candidate.id === parsed.data.id)) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_conflict',
        'SavedSecret identity already exists',
      );
    }
    return Object.freeze({
      settings: Object.freeze({
        ...settings,
        secrets: Object.freeze([mutation.secret, ...secrets]),
      }),
    });
  }
  if (mutation.kind === 'replaceVoiceCredentialSecret') {
    const replacementSecret = SavedSecretSchema.safeParse(mutation.secret);
    if (!replacementSecret.success) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_invalid',
        'Target-local Voice SavedSecret replacement is invalid',
      );
    }
    if (secrets.some((candidate) => candidate.id === replacementSecret.data.id)) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_conflict',
        'Target-local Voice SavedSecret identity already exists',
      );
    }
    const targetState = readVoiceCredentialTarget(settings, mutation.target);
    if (targetState.exactSecretId !== mutation.expectedSecretId) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_conflict',
        'Target-local Voice credential changed',
      );
    }
    if (
      mutation.expectedSecretId !== null
      && mutation.expectedSecretUpdatedAt !== null
    ) {
      findSecret(
        secrets,
        mutation.expectedSecretId,
        mutation.expectedSecretUpdatedAt,
      );
    } else if (
      mutation.expectedSecretId !== null
      || mutation.expectedSecretUpdatedAt !== null
    ) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_conflict',
        'Target-local Voice SavedSecret source changed',
      );
    }
    const rebound = writeVoiceCredentialTarget({
      settings,
      target: mutation.target,
      state: targetState,
      secretId: replacementSecret.data.id,
      ...(mutation.approvedRecipientContractDigest === undefined
        ? {}
        : {
            approvedRecipientContractDigest:
              mutation.approvedRecipientContractDigest,
          }),
    });
    const keepPrevious = mutation.expectedSecretId !== null
      && listAccountSettingsSavedSecretReferences(
        rebound,
        mutation.expectedSecretId,
      ).length > 0;
    return Object.freeze({
      settings: Object.freeze({
        ...rebound,
        secrets: Object.freeze([
          mutation.secret,
          ...secrets.filter((candidate) => (
            keepPrevious || candidate.id !== mutation.expectedSecretId
          )),
        ]),
      }),
    });
  }
  if (mutation.kind === 'approveVoiceCredentialRecipientContract') {
    if (mutation.approvedRecipientContractDigest.trim().length === 0) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_invalid',
        'Voice credential recipient contract digest is invalid',
      );
    }
    const targetState = readVoiceCredentialTarget(settings, mutation.target);
    if (targetState.exactSecretId !== mutation.expectedSecretId) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_conflict',
        'Target-local Voice credential changed',
      );
    }
    findSecret(
      secrets,
      mutation.expectedSecretId,
      mutation.expectedSecretUpdatedAt,
    );
    const approved = writeVoiceCredentialTarget({
      settings,
      target: mutation.target,
      state: targetState,
      secretId: mutation.expectedSecretId,
      approvedRecipientContractDigest:
        mutation.approvedRecipientContractDigest,
    });
    return Object.freeze({
      settings: Object.freeze({
        ...approved,
        secrets: Object.freeze([...secrets]),
      }),
    });
  }
  if (mutation.kind === 'removeVoiceCredentialSecret') {
    const targetState = readVoiceCredentialTarget(settings, mutation.target);
    if (targetState.exactSecretId !== mutation.expectedSecretId) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_conflict',
        'Target-local Voice credential changed',
      );
    }
    findSecret(
      secrets,
      mutation.expectedSecretId,
      mutation.expectedSecretUpdatedAt,
    );
    const unbound = writeVoiceCredentialTarget({
      settings,
      target: mutation.target,
      state: targetState,
      secretId: null,
    });
    const keepSecret = listAccountSettingsSavedSecretReferences(
      unbound,
      mutation.expectedSecretId,
    ).length > 0;
    return Object.freeze({
      settings: Object.freeze({
        ...unbound,
        secrets: keepSecret
          ? Object.freeze([...secrets])
          : Object.freeze(
              secrets.filter(
                (candidate) => candidate.id !== mutation.expectedSecretId,
              ),
            ),
      }),
    });
  }

  const current = findSecret(
    secrets,
    mutation.secretId,
    mutation.expectedUpdatedAt,
  );
  if (mutation.kind === 'delete') {
    const references = listAccountSettingsSavedSecretReferences(
      settings,
      mutation.secretId,
    );
    if (references.length > 0) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_in_use',
        'SavedSecret is still referenced by Account Settings',
        references,
      );
    }
    return Object.freeze({
      settings: Object.freeze({
        ...settings,
        secrets: Object.freeze(
          secrets.filter((candidate) => candidate.id !== mutation.secretId),
        ),
      }),
    });
  }

  if (mutation.kind === 'rotateGlobal') {
    const connectedAccountReferences: AccountSettingsSavedSecretReference[] = [];
    collectConnectedAccountReferences(
      settings,
      mutation.secretId,
      connectedAccountReferences,
    );
    if (connectedAccountReferences.length > 0) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_referenced_by_connected_account_configuration',
        'Replace this SavedSecret from the exact Connected Account configuration that references it',
        connectedAccountReferences,
      );
    }
  }

  if (
    !Number.isFinite(mutation.updatedAt)
    || mutation.updatedAt <= current.secret.updatedAt
  ) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_invalid',
      'SavedSecret update time must advance',
    );
  }
  const replacement = mutation.kind === 'rename'
    ? {
        ...current.secret,
        name: mutation.name.trim(),
        updatedAt: mutation.updatedAt,
      }
    : {
        ...current.secret,
        encryptedValue: mutation.encryptedValue,
        updatedAt: mutation.updatedAt,
      };
  if (!SavedSecretSchema.safeParse(replacement).success) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_invalid',
      'SavedSecret replacement is invalid',
    );
  }
  const nextSecrets = [...secrets];
  nextSecrets[current.index] = replacement;
  const withSecret = Object.freeze({
    ...settings,
    secrets: Object.freeze(nextSecrets),
  });
  if (mutation.kind === 'rename') {
    return Object.freeze({
      settings: withSecret,
    });
  }
  return Object.freeze({
    settings: withSecret,
  });
}
