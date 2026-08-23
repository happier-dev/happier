import {
  SAVED_SECRET_COLLECTION_MAX_ENTRIES,
  SavedSecretSchema,
  type SavedSecret,
} from '../../profiles/backendProfileSchema.js';
import type { SecretStringV1 } from '../../crypto/settingsSecretStringSchemasV1.js';
import {
  QualifiedConnectedAccountPurposeBindingTargetV1Schema,
  QualifiedConnectedAccountPurposeBindingsV1Schema,
  qualifiedPurposeKey,
  type QualifiedConnectedAccountPurposeBindingTargetV1,
  type QualifiedConnectedAccountPurposeBindingV1,
  type QualifiedConnectedAccountPurposeBindingsV1,
} from '../../connect/connectedAccountPurposeBindings.js';
import {
  QualifiedConnectedAccountPurposeV1Schema,
  type QualifiedConnectedAccountPurposeV1,
} from '../../connect/connectedAccountPurposes.js';
import {
  PluginContributionIdentityV1Schema,
  type PluginContributionIdentityV1,
} from '../../plugins/contributionIdentity.js';
import { PluginIdSchema } from '../../plugins/pluginId.js';
import { PluginCredentialAccessSlotIdSchema } from '../../plugins/permissions/grants.js';
import { PluginSettingFieldIdV2Schema } from '../../plugins/contributions/settings.js';
import {
  deriveVoiceCredentialBindingIdentityV1,
  type VoiceProviderContribution,
} from '../../plugins/contributions/voiceProviders.js';
import { ProviderMachineIdSchema } from '../../providers/ids.js';
import { SavedSecretSlotBindingsV1Schema } from '../../providers/settings/v1.js';
import {
  LegacyVoiceCredentialBindingV1Schema,
  VoiceCredentialBindingV1Schema,
} from '../../voice/realtime/providerSettings.js';
import {
  CONNECTED_ACCOUNT_SERVICE_CONFIGURATIONS_SETTINGS_KEY,
  parseConnectedAccountServiceConfigurationsV1,
  type ConnectedAccountServiceConfigurationEntryV1,
} from './connectedAccountServiceConfigurationsV1.js';

export { CONNECTED_ACCOUNT_SERVICE_CONFIGURATIONS_SETTINGS_KEY } from './connectedAccountServiceConfigurationsV1.js';

const SECRETS_KEY = 'secrets';
const PROFILE_BINDINGS_KEY = 'secretBindingsByProfileId';
const PROVIDER_SETTINGS_KEY = 'providerSettingsV1';
const VOICE_SETTINGS_KEYS = ['voice', 'voiceSettingsV1'] as const;
const MCP_SETTINGS_KEY = 'mcpServersSettingsV1';
const ACP_SETTINGS_KEY = 'acpCatalogSettingsV1';
export const PLUGIN_SECRET_BINDINGS_SETTINGS_KEY = 'pluginSecretBindingsV1';
const MAX_PLUGIN_SECRET_BINDINGS = 256;
const MAX_PLUGIN_SECRET_BINDINGS_BYTES = 64 * 1024;
export type AccountSettingsSavedSecretReferenceOwner =
  | 'profile'
  | 'provider'
  | 'voice'
  | 'mcp'
  | 'acp'
  | 'plugin'
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
      target: VoiceCredentialSecretTarget;
      expectedSecretId: string | null;
      expectedSecretUpdatedAt: number | null;
      secret: SavedSecret;
      approvedRecipientContractDigest?: string;
    }>
  | Readonly<{
      /**
       * Points a Voice credential slot at a SavedSecret the account already
       * stores. No secret material is carried, created, or removed: the
       * mutation only moves the reference, and an unknown id fails closed.
       */
      kind: 'bindVoiceCredentialSavedSecret';
      target: VoiceCredentialSecretTarget;
      expectedSecretId: string | null;
      expectedSecretUpdatedAt: number | null;
      secretId: string;
      approvedRecipientContractDigest?: string;
    }>
  | Readonly<{
      kind: 'approveVoiceCredentialRecipientContract';
      target: VoiceCredentialSecretTarget;
      expectedSecretId: string;
      expectedSecretUpdatedAt: number;
      approvedRecipientContractDigest: string;
    }>
  | Readonly<{
      kind: 'removeVoiceCredentialSecret';
      target: VoiceCredentialSecretTarget;
      expectedSecretId: string;
      expectedSecretUpdatedAt: number;
    }>
  | Readonly<{
      kind: 'replacePluginSecret';
      target: PluginAccountSecretBindingTarget;
      expectedSecretId: string | null;
      expectedSecretUpdatedAt: number | null;
      secret: SavedSecret;
    }>
  | Readonly<{
      kind: 'bindPluginSecret';
      target: PluginAccountSecretBindingTarget;
      expectedSecretId: string | null;
      expectedSecretUpdatedAt: number | null;
      secretId: string;
    }>
  | Readonly<{
      kind: 'removePluginSecret';
      target: PluginAccountSecretBindingTarget;
      expectedSecretId: string;
      expectedSecretUpdatedAt: number | null;
    }>
  | Readonly<{
      /** Removes only the plugin binding; the SavedSecret remains user-owned. */
      kind: 'unbindPluginSecret';
      target: PluginAccountSecretBindingTarget;
      expectedSecretId: string;
      expectedSecretUpdatedAt: number | null;
    }>;

export type PluginAccountSecretBindingTarget = Readonly<{
  pluginId: string;
  localId: string;
}>;

export type PluginAccountSecretBinding = Readonly<{
  pluginId: string;
  custody: 'account';
  localId: string;
  savedSecretId: string;
  createdForBinding: boolean;
}>;

export type AccountSettingsPluginSecretResolution = Readonly<{
  binding: PluginAccountSecretBinding;
  secret: SavedSecret;
}>;

export type VoiceCredentialSecretTarget = Readonly<{
  contribution: PluginContributionIdentityV1;
  credentialSlotId: string;
  machineId: string | null;
}>;

export type AccountSettingsVoiceCredentialSecretResolution = Readonly<{
  exactSecretId: string | null;
  reference: Readonly<{
    secretId: string;
    source: 'account' | 'machine_override';
  }> | null;
  approvedRecipientContractDigest: string | null;
}>;

export type VoiceCredentialSourceSelection =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'savedSecret' }>
  | Readonly<{
      kind: 'connectedAccount';
      target: QualifiedConnectedAccountPurposeBindingTargetV1;
    }>;

export type AccountSettingsVoiceCredentialSourceMutation = Readonly<{
  contribution: PluginContributionIdentityV1;
  credentialSlotId: string;
  selection: VoiceCredentialSourceSelection;
  expectedSettingsVersion: number;
  savedSecretMutation?: Extract<
    AccountSettingsSavedSecretMutation,
    Readonly<{ kind: 'replaceVoiceCredentialSecret' }>
    | Readonly<{ kind: 'bindVoiceCredentialSavedSecret' }>
  >;
}>;

export type AccountSettingsVoiceCredentialSourceMutationResult =
  | Readonly<{
      status: 'applied';
      settingsVersion: number;
      selection: VoiceCredentialSourceSelection;
      binding: QualifiedConnectedAccountPurposeBindingV1 | null;
    }>
  | Readonly<{
      status: 'conflict';
      currentSettingsVersion: number;
    }>
  /**
   * The Account Settings one-shot write may have reached storage, but the
   * SavedSecret source owner cannot truthfully attribute a readback to it.
   */
  | Readonly<{
      status: 'outcomeUnknown';
      lastKnownSettingsVersion: number;
      safeSnapshotVersion?: number;
    }>;

export type AccountSettingsVoiceCredentialSourceResolution = Readonly<{
  selection: VoiceCredentialSourceSelection;
  binding: QualifiedConnectedAccountPurposeBindingV1 | null;
  savedSecret: Readonly<{
    secretId: string;
    source: 'account' | 'machine_override';
  }> | null;
  /** The recipient contract the user approved for this target, when recorded. */
  approvedRecipientContractDigest: string | null;
}>;

export class AccountSettingsSavedSecretMutationError extends Error {
  readonly code:
    | 'saved_secret_invalid'
    | 'saved_secret_conflict'
    | 'saved_secret_not_found'
    | 'saved_secret_in_use'
    | 'saved_secret_referenced_by_connected_account_configuration'
    | 'saved_secret_reference_invalid'
    | 'saved_secret_collection_full';
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

function hasOnlyOwnKeys(
  value: Readonly<Record<string, unknown>>,
  allowedKeys: readonly string[],
): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
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

function pluginSecretBindingError(message: string): never {
  throw new AccountSettingsSavedSecretMutationError(
    'saved_secret_reference_invalid',
    message,
  );
}

function parsePluginAccountSecretBindingTarget(
  value: unknown,
): PluginAccountSecretBindingTarget {
  const raw = ownRecord(value);
  const pluginId = PluginIdSchema.safeParse(raw?.pluginId);
  const localId = PluginSettingFieldIdV2Schema.safeParse(raw?.localId);
  if (
    !raw
    || !hasOnlyOwnKeys(raw, ['pluginId', 'localId'])
    || !pluginId.success
    || !localId.success
  ) {
    pluginSecretBindingError('Plugin SavedSecret binding target is invalid');
  }
  return Object.freeze({ pluginId: pluginId.data, localId: localId.data });
}

/**
 * A JSON tuple keeps plugin ids and local ids collision-safe even though both
 * can contain the separators used elsewhere in contribution identifiers.
 */
export function qualifyPluginAccountSecretBindingKey(
  target: PluginAccountSecretBindingTarget,
): string {
  const parsed = parsePluginAccountSecretBindingTarget(target);
  return JSON.stringify([parsed.pluginId, 'account', parsed.localId]);
}

function parsePluginAccountSecretBinding(
  key: string,
  value: unknown,
): PluginAccountSecretBinding {
  const raw = ownRecord(value);
  if (
    !raw
    || !hasOnlyOwnKeys(raw, [
      'pluginId',
      'custody',
      'localId',
      'savedSecretId',
      'createdForBinding',
    ])
    || raw.custody !== 'account'
    || typeof raw.savedSecretId !== 'string'
    || raw.savedSecretId.length === 0
    || typeof raw.createdForBinding !== 'boolean'
  ) {
    pluginSecretBindingError('Plugin SavedSecret binding is invalid');
  }
  const target = parsePluginAccountSecretBindingTarget({
    pluginId: raw.pluginId,
    localId: raw.localId,
  });
  if (key !== qualifyPluginAccountSecretBindingKey(target)) {
    pluginSecretBindingError('Plugin SavedSecret binding key is not canonical');
  }
  return Object.freeze({
    pluginId: target.pluginId,
    custody: 'account',
    localId: target.localId,
    savedSecretId: raw.savedSecretId,
    createdForBinding: raw.createdForBinding,
  });
}

function canonicalPluginSecretBindingsJson(
  bindings: Readonly<Record<string, PluginAccountSecretBinding>>,
): string {
  const ordered = Object.fromEntries(
    Object.entries(bindings)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, binding]) => [
        key,
        {
          pluginId: binding.pluginId,
          custody: binding.custody,
          localId: binding.localId,
          savedSecretId: binding.savedSecretId,
          createdForBinding: binding.createdForBinding,
        },
      ]),
  );
  return JSON.stringify(ordered);
}

function readPluginAccountSecretBindings(
  settings: Readonly<Record<string, unknown>>,
): Readonly<Record<string, PluginAccountSecretBinding>> {
  const raw = settings[PLUGIN_SECRET_BINDINGS_SETTINGS_KEY];
  if (raw === undefined) return Object.freeze({});
  const root = ownRecord(raw);
  if (!root) {
    pluginSecretBindingError('Plugin SavedSecret bindings are invalid');
  }
  const entries = Object.entries(root);
  if (entries.length > MAX_PLUGIN_SECRET_BINDINGS) {
    pluginSecretBindingError('Plugin SavedSecret bindings exceed the entry limit');
  }
  const bindings = Object.fromEntries(entries.map(([key, value]) => [
    key,
    parsePluginAccountSecretBinding(key, value),
  ])) as Record<string, PluginAccountSecretBinding>;
  if (
    new TextEncoder().encode(canonicalPluginSecretBindingsJson(bindings)).byteLength
      > MAX_PLUGIN_SECRET_BINDINGS_BYTES
  ) {
    pluginSecretBindingError('Plugin SavedSecret bindings exceed the byte limit');
  }
  return Object.freeze(bindings);
}

function withPluginAccountSecretBindings(
  settings: Readonly<Record<string, unknown>>,
  bindings: Readonly<Record<string, PluginAccountSecretBinding>>,
): Readonly<Record<string, unknown>> {
  if (Object.keys(bindings).length === 0) {
    const { [PLUGIN_SECRET_BINDINGS_SETTINGS_KEY]: _removed, ...withoutBindings } = settings;
    return Object.freeze(withoutBindings);
  }
  // Re-parse through the strict bounded reader before committing the root.
  const canonical = JSON.parse(canonicalPluginSecretBindingsJson(bindings)) as Record<
    string,
    PluginAccountSecretBinding
  >;
  readPluginAccountSecretBindings({
    [PLUGIN_SECRET_BINDINGS_SETTINGS_KEY]: canonical,
  });
  return Object.freeze({
    ...settings,
    [PLUGIN_SECRET_BINDINGS_SETTINGS_KEY]: canonical,
  });
}

function readPluginAccountSecretBindingTarget(
  settings: Readonly<Record<string, unknown>>,
  target: PluginAccountSecretBindingTarget,
): Readonly<{
  target: PluginAccountSecretBindingTarget;
  key: string;
  binding: PluginAccountSecretBinding | null;
}> {
  const parsedTarget = parsePluginAccountSecretBindingTarget(target);
  const key = qualifyPluginAccountSecretBindingKey(parsedTarget);
  const bindings = readPluginAccountSecretBindings(settings);
  return Object.freeze({
    target: parsedTarget,
    key,
    binding: Object.prototype.hasOwnProperty.call(bindings, key)
      ? bindings[key]!
      : null,
  });
}

function writePluginAccountSecretBinding(input: Readonly<{
  settings: Readonly<Record<string, unknown>>;
  target: PluginAccountSecretBindingTarget;
  binding: PluginAccountSecretBinding | null;
}>): Readonly<Record<string, unknown>> {
  const targetState = readPluginAccountSecretBindingTarget(
    input.settings,
    input.target,
  );
  const bindings = { ...readPluginAccountSecretBindings(input.settings) };
  if (input.binding) {
    bindings[targetState.key] = input.binding;
  } else {
    delete bindings[targetState.key];
  }
  return withPluginAccountSecretBindings(input.settings, bindings);
}

function assertPluginSecretBindingExpectation(
  secrets: readonly SavedSecret[],
  binding: PluginAccountSecretBinding | null,
  expectedSecretId: string | null,
  expectedSecretUpdatedAt: number | null,
): void {
  if (expectedSecretId === null) {
    if (expectedSecretUpdatedAt === null && binding === null) return;
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_conflict',
      'Plugin SavedSecret binding changed before the mutation settled',
    );
  }
  if (!binding || binding.savedSecretId !== expectedSecretId) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_conflict',
      'Plugin SavedSecret binding changed before the mutation settled',
    );
  }
  assertVoiceCredentialSecretExpectation(
    secrets,
    expectedSecretId,
    expectedSecretUpdatedAt,
  );
}

function removeUnreferencedBindingCreatedSecret(input: Readonly<{
  settings: Readonly<Record<string, unknown>>;
  secrets: readonly SavedSecret[];
  binding: PluginAccountSecretBinding | null;
}>): readonly SavedSecret[] {
  if (!input.binding?.createdForBinding) return input.secrets;
  const stillReferenced = listAccountSettingsSavedSecretReferences(
    input.settings,
    input.binding.savedSecretId,
  ).length > 0;
  return stillReferenced
    ? input.secrets
    : input.secrets.filter((secret) => secret.id !== input.binding!.savedSecretId);
}

/**
 * The Account-erasure arm for one plugin's declared Account secrets. It is
 * intentionally a Settings-owned pure operation: callers submit its complete
 * result through the incumbent whole-document Account Settings CAS rather
 * than changing the bindings or SavedSecrets through a Data store.
 */
export type AccountSettingsPluginSecretBindingsEraseResult = Readonly<{
  settings: Readonly<Record<string, unknown>>;
  removedBindingCount: number;
  removedSavedSecretCount: number;
}>;

export function eraseAccountSettingsPluginSecretBindings(
  settings: Readonly<Record<string, unknown>>,
  pluginId: string,
): AccountSettingsPluginSecretBindingsEraseResult {
  const parsedPluginId = PluginIdSchema.safeParse(pluginId);
  if (!parsedPluginId.success) {
    pluginSecretBindingError('Plugin SavedSecret erase target is invalid');
  }

  const secrets = readSavedSecrets(settings);
  const bindings = readPluginAccountSecretBindings(settings);
  // Validate every known reference root before any candidate binding is
  // removed. A malformed root must not turn an erase into a guessed delete.
  validateKnownSavedSecretReferenceRoots(settings);

  const removedBindings = Object.values(bindings).filter((binding) => (
    binding.pluginId === parsedPluginId.data
  ));
  if (removedBindings.length === 0) {
    return Object.freeze({
      settings,
      removedBindingCount: 0,
      removedSavedSecretCount: 0,
    });
  }

  const retainedBindings = Object.fromEntries(
    Object.entries(bindings).filter(([, binding]) => (
      binding.pluginId !== parsedPluginId.data
    )),
  ) as Record<string, PluginAccountSecretBinding>;
  const withoutBindings = withPluginAccountSecretBindings(settings, retainedBindings);
  const candidateSecretIds = new Set(
    removedBindings
      .filter((binding) => binding.createdForBinding)
      .map((binding) => binding.savedSecretId),
  );
  const removableSecretIds = new Set<string>();
  for (const secretId of candidateSecretIds) {
    if (
      secrets.some((secret) => secret.id === secretId)
      && listAccountSettingsSavedSecretReferences(withoutBindings, secretId).length === 0
    ) {
      removableSecretIds.add(secretId);
    }
  }
  const retainedSecrets = secrets.filter((secret) => !removableSecretIds.has(secret.id));
  const nextSettings = removableSecretIds.size === 0
    ? withoutBindings
    : Object.freeze({
      ...withoutBindings,
      secrets: Object.freeze(retainedSecrets),
    });
  return Object.freeze({
    settings: nextSettings,
    removedBindingCount: removedBindings.length,
    removedSavedSecretCount: removableSecretIds.size,
  });
}

/**
 * Resolves only a safe Account SavedSecret reference for one host-stamped
 * plugin/id pair. A missing binding is ordinary absence; malformed or dangling
 * bindings fail closed before a caller can disclose material.
 */
export function resolveAccountSettingsPluginSecret(
  settings: Readonly<Record<string, unknown>>,
  target: PluginAccountSecretBindingTarget,
): AccountSettingsPluginSecretResolution | null {
  const targetState = readPluginAccountSecretBindingTarget(settings, target);
  if (!targetState.binding) return null;
  const secret = readSavedSecrets(settings).find((candidate) => (
    candidate.id === targetState.binding!.savedSecretId
  ));
  if (!secret) {
    pluginSecretBindingError('Plugin SavedSecret binding points at a missing SavedSecret');
  }
  return Object.freeze({ binding: targetState.binding, secret });
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

type VoiceCredentialTarget = VoiceCredentialSecretTarget;

type VoiceCredentialTargetState = Readonly<{
  root: Readonly<Record<string, unknown>>;
  credentialBindings: readonly Readonly<Record<string, unknown>>[];
  bindingIndex: number;
  binding: Readonly<Record<string, unknown>> | null;
  exactSecretId: string | null;
}>;

function sameContribution(
  left: PluginContributionIdentityV1,
  right: PluginContributionIdentityV1,
): boolean {
  return left.pluginId === right.pluginId && left.localId === right.localId;
}

function parseQualifiedVoiceCredentialTarget(
  target: VoiceCredentialSecretTarget,
): VoiceCredentialSecretTarget {
  const raw = ownRecord(target);
  const contribution = PluginContributionIdentityV1Schema.safeParse(
    raw?.contribution,
  );
  if (
    !raw
    || !hasOnlyOwnKeys(raw, ['contribution', 'credentialSlotId', 'machineId'])
    || !contribution.success
    || !PluginCredentialAccessSlotIdSchema.safeParse(
      raw.credentialSlotId,
    ).success
    || (
      raw.machineId !== null
      && !ProviderMachineIdSchema.safeParse(raw.machineId).success
    )
  ) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_invalid',
      'Qualified Voice credential target is invalid',
    );
  }
  return Object.freeze({
    contribution: contribution.data,
    credentialSlotId: raw.credentialSlotId as string,
    machineId: raw.machineId as string | null,
  });
}

function parseCanonicalVoiceCredentialBinding(
  candidate: unknown,
): Readonly<Record<string, unknown>> {
  const parsed = VoiceCredentialBindingV1Schema.safeParse(candidate);
  if (!parsed.success) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_reference_invalid',
      'Voice credential reference is invalid',
    );
  }
  return parsed.data;
}

function parseVoiceCredentialBindingForReferenceEnumeration(
  candidate: unknown,
): Readonly<Record<string, unknown>> {
  const legacy = LegacyVoiceCredentialBindingV1Schema.safeParse(candidate);
  return legacy.success
    ? legacy.data
    : parseCanonicalVoiceCredentialBinding(candidate);
}

function readVoiceCredentialTarget(
  settings: Readonly<Record<string, unknown>>,
  target: VoiceCredentialTarget,
): VoiceCredentialTargetState {
  const qualifiedTarget = parseQualifiedVoiceCredentialTarget(target);
  const rawRoot = settings.voiceSettingsV1;
  const root = rawRoot === undefined ? {} : ownRecord(rawRoot);
  if (!root || (root.credentialBindings !== undefined && !Array.isArray(root.credentialBindings))) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_reference_invalid',
      'Voice credential references are invalid',
    );
  }
  const credentialBindings = (root.credentialBindings ?? []) as readonly unknown[];
  const parsed = credentialBindings.map(parseCanonicalVoiceCredentialBinding);
  const matchingIndexes = parsed.flatMap((binding, index) => (
    PluginContributionIdentityV1Schema.safeParse(binding.contribution).success
    && sameContribution(
      PluginContributionIdentityV1Schema.parse(binding.contribution),
      qualifiedTarget.contribution,
    )
    && binding.credentialSlotId === qualifiedTarget.credentialSlotId
      ? [index]
      : []
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
  const machineId = qualifiedTarget.machineId;
  const credentialSlotId = qualifiedTarget.credentialSlotId;
  const machineBindings = machineId
    ? ownRecord(byMachineId?.[machineId])
    : null;
  const candidate = machineId
    ? machineBindings?.[credentialSlotId]
    : account?.[credentialSlotId];
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

/**
 * Resolves the current SavedSecret reference at the qualified Voice target.
 * A concrete machine uses its exact override before the account default;
 * `machineId: null` deliberately ignores every machine override.
 */
export function resolveAccountSettingsVoiceCredentialSecret(
  settings: Readonly<Record<string, unknown>>,
  target: VoiceCredentialSecretTarget,
): AccountSettingsVoiceCredentialSecretResolution {
  const qualifiedTarget = parseQualifiedVoiceCredentialTarget(target);
  const state = readVoiceCredentialTarget(settings, qualifiedTarget);
  const slotBindings = ownRecord(state.binding?.credentialBindings) ?? {};
  const account = ownRecord(slotBindings.account);
  const byMachineId = ownRecord(slotBindings.byMachineId);
  const machine = qualifiedTarget.machineId === null
    ? null
    : ownRecord(byMachineId?.[qualifiedTarget.machineId]);
  const machineSecretId = machine?.[qualifiedTarget.credentialSlotId];
  const accountSecretId = account?.[qualifiedTarget.credentialSlotId];
  const candidate = qualifiedTarget.machineId !== null
    && typeof machineSecretId === 'string'
    ? Object.freeze({
        secretId: machineSecretId,
        source: 'machine_override' as const,
      })
    : typeof accountSecretId === 'string'
      ? Object.freeze({
          secretId: accountSecretId,
          source: 'account' as const,
        })
      : null;
  const reference = candidate
    && readSavedSecrets(settings).some((secret) => secret.id === candidate.secretId)
    ? candidate
    : null;
  const digest = state.binding?.approvedRecipientContractDigest;
  return Object.freeze({
    exactSecretId: state.exactSecretId,
    reference,
    approvedRecipientContractDigest:
      typeof digest === 'string' ? digest : null,
  });
}

function writeVoiceCredentialTarget(input: Readonly<{
  settings: Readonly<Record<string, unknown>>;
  target: VoiceCredentialTarget;
  state: VoiceCredentialTargetState;
  secretId: string | null;
  approvedRecipientContractDigest?: string;
}>): Readonly<Record<string, unknown>> {
  if (
    !VoiceCredentialBindingV1Schema.shape.approvedRecipientContractDigest
      .safeParse(input.approvedRecipientContractDigest).success
  ) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_invalid',
      'Voice credential recipient contract digest is invalid',
    );
  }
  const existingSlotBindings = ownRecord(input.state.binding?.credentialBindings) ?? {};
  const account = { ...(ownRecord(existingSlotBindings.account) ?? {}) };
  const byMachineId = { ...(ownRecord(existingSlotBindings.byMachineId) ?? {}) };
  const qualifiedTarget = parseQualifiedVoiceCredentialTarget(input.target);
  const machineId = qualifiedTarget.machineId;
  const credentialSlotId = qualifiedTarget.credentialSlotId;
  if (machineId) {
    const machine = {
      ...(ownRecord(byMachineId[machineId]) ?? {}),
    };
    if (input.secretId) {
      machine[credentialSlotId] = input.secretId;
    } else {
      delete machine[credentialSlotId];
    }
    if (Object.keys(machine).length > 0) {
      byMachineId[machineId] = machine;
    } else {
      delete byMachineId[machineId];
    }
  } else if (input.secretId) {
    account[credentialSlotId] = input.secretId;
  } else {
    delete account[credentialSlotId];
  }
  const nextSlotBindings: MutableRecord = { ...existingSlotBindings };
  if (Object.keys(account).length > 0) nextSlotBindings.account = account;
  else delete nextSlotBindings.account;
  if (Object.keys(byMachineId).length > 0) nextSlotBindings.byMachineId = byMachineId;
  else delete nextSlotBindings.byMachineId;

  const credentialBindings = [...input.state.credentialBindings];
  const nextBinding = {
    ...(input.state.binding ?? {}),
    contribution: qualifiedTarget.contribution,
    credentialSlotId: qualifiedTarget.credentialSlotId,
    credentialSource: input.state.binding?.credentialSource
      ?? { kind: 'none' },
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
  return Object.freeze({
    ...input.settings,
    voiceSettingsV1: {
      ...input.state.root,
      credentialBindings,
    },
  });
}

function parseVoiceCredentialSourceMutationIdentity(input: Readonly<{
  contribution: PluginContributionIdentityV1;
  credentialSlotId: string;
  purpose: QualifiedConnectedAccountPurposeV1;
}>): Readonly<{
  contribution: PluginContributionIdentityV1;
  credentialSlotId: string;
  purpose: QualifiedConnectedAccountPurposeV1;
}> {
  const contribution = PluginContributionIdentityV1Schema.safeParse(
    input.contribution,
  );
  const purpose = QualifiedConnectedAccountPurposeV1Schema.safeParse(
    input.purpose,
  );
  if (
    !contribution.success
    || !purpose.success
    || !PluginCredentialAccessSlotIdSchema.safeParse(
      input.credentialSlotId,
    ).success
    || !sameContribution(contribution.data, purpose.data.consumer)
  ) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_invalid',
      'Voice credential source identity is invalid',
    );
  }
  return Object.freeze({
    contribution: contribution.data,
    credentialSlotId: input.credentialSlotId,
    purpose: purpose.data,
  });
}

function parseVoiceCredentialSourceSelection(
  selection: VoiceCredentialSourceSelection,
): VoiceCredentialSourceSelection {
  const raw = ownRecord(selection);
  if (!raw || typeof raw.kind !== 'string') {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_invalid',
      'Voice credential source selection is invalid',
    );
  }
  if (
    (raw.kind === 'none' || raw.kind === 'savedSecret')
    && Object.keys(raw).length === 1
  ) {
    return Object.freeze({ kind: raw.kind });
  }
  if (raw.kind === 'connectedAccount' && Object.keys(raw).length === 2) {
    const target = QualifiedConnectedAccountPurposeBindingTargetV1Schema
      .safeParse(raw.target);
    if (target.success) {
      return Object.freeze({
        kind: 'connectedAccount',
        target: target.data,
      });
    }
  }
  throw new AccountSettingsSavedSecretMutationError(
    'saved_secret_invalid',
    'Voice credential source selection is invalid',
  );
}

/**
 * Reads the one persisted Connected Account purpose-binding root used by the
 * combined Voice credential-source mutation. An omitted root predates the
 * feature and initializes empty; any present noncanonical value is evidence
 * that must be preserved and rejected before a caller can write Settings.
 */
export function readAccountSettingsConnectedAccountPurposeBindings(
  settings: Readonly<Record<string, unknown>>,
): QualifiedConnectedAccountPurposeBindingsV1 {
  const raw = settings.connectedAccountPurposeBindingsV1;
  if (raw === undefined) {
    return QualifiedConnectedAccountPurposeBindingsV1Schema.parse({
      v: 1,
      bindings: [],
    });
  }
  const parsed = QualifiedConnectedAccountPurposeBindingsV1Schema.safeParse(raw);
  if (!parsed.success) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_reference_invalid',
      'Connected Account purpose bindings are invalid',
    );
  }
  return parsed.data;
}

function readQualifiedPurposeBindings(
  settings: Readonly<Record<string, unknown>>,
): readonly QualifiedConnectedAccountPurposeBindingV1[] {
  return Object.freeze(
    readAccountSettingsConnectedAccountPurposeBindings(settings).bindings,
  );
}

function findQualifiedPurposeBinding(
  bindings: readonly QualifiedConnectedAccountPurposeBindingV1[],
  purpose: QualifiedConnectedAccountPurposeV1,
): QualifiedConnectedAccountPurposeBindingV1 | null {
  const key = qualifiedPurposeKey(purpose);
  return bindings.find((candidate) => (
    qualifiedPurposeKey(candidate.purpose) === key
  )) ?? null;
}

function writeVoiceCredentialSource(input: Readonly<{
  settings: Readonly<Record<string, unknown>>;
  contribution: PluginContributionIdentityV1;
  credentialSlotId: string;
  kind: VoiceCredentialSourceSelection['kind'];
}>): Readonly<Record<string, unknown>> {
  const target = Object.freeze({
    contribution: input.contribution,
    credentialSlotId: input.credentialSlotId,
    machineId: null,
  });
  const state = readVoiceCredentialTarget(input.settings, target);
  const credentialBindings = [...state.credentialBindings];
  const nextBinding = {
    ...(state.binding ?? {}),
    contribution: input.contribution,
    credentialSlotId: input.credentialSlotId,
    credentialSource: { kind: input.kind },
    credentialBindings: ownRecord(state.binding?.credentialBindings) ?? {},
  };
  if (state.bindingIndex >= 0) {
    credentialBindings[state.bindingIndex] = nextBinding;
  } else {
    credentialBindings.push(nextBinding);
  }
  return Object.freeze({
    ...input.settings,
    voiceSettingsV1: {
      ...state.root,
      credentialBindings,
    },
  });
}

function writeVoicePurposeBinding(input: Readonly<{
  settings: Readonly<Record<string, unknown>>;
  purpose: QualifiedConnectedAccountPurposeV1;
  selection: VoiceCredentialSourceSelection;
}>): Readonly<{
  settings: Readonly<Record<string, unknown>>;
  binding: QualifiedConnectedAccountPurposeBindingV1 | null;
}> {
  const existing = readQualifiedPurposeBindings(input.settings);
  const purposeKey = qualifiedPurposeKey(input.purpose);
  const withoutPurpose = existing.filter((candidate) => (
    qualifiedPurposeKey(candidate.purpose) !== purposeKey
  ));
  const binding = input.selection.kind === 'connectedAccount'
    ? Object.freeze({
        purpose: input.purpose,
        target: input.selection.target,
      })
    : null;
  const next = QualifiedConnectedAccountPurposeBindingsV1Schema.parse({
    v: 1,
    bindings: binding ? [...withoutPurpose, binding] : withoutPurpose,
  });
  return Object.freeze({
    settings: Object.freeze({
      ...input.settings,
      connectedAccountPurposeBindingsV1: next,
    }),
    binding,
  });
}

/**
 * Pure Account Settings owner seam. The caller must admit the returned object
 * through the existing outer Account Settings V2 version CAS; this function
 * deliberately owns no retry or persistence path.
 */
export function applyAccountSettingsVoiceCredentialSourceMutation(
  settings: Readonly<Record<string, unknown>>,
  mutation: AccountSettingsVoiceCredentialSourceMutation,
  currentDeclaration: VoiceProviderContribution,
): Readonly<{
  settings: Readonly<Record<string, unknown>>;
  selection: VoiceCredentialSourceSelection;
  binding: QualifiedConnectedAccountPurposeBindingV1 | null;
}> {
  const rawMutation = ownRecord(mutation);
  if (
    !rawMutation
    || !hasOnlyOwnKeys(rawMutation, [
      'contribution',
      'credentialSlotId',
      'selection',
      'expectedSettingsVersion',
      'savedSecretMutation',
    ])
  ) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_invalid',
      'Voice credential source mutation is invalid',
    );
  }
  if (!Number.isInteger(mutation.expectedSettingsVersion)
    || mutation.expectedSettingsVersion < 0) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_invalid',
      'Voice credential source mutation settings version is invalid',
    );
  }
  let derivedIdentity: ReturnType<typeof deriveVoiceCredentialBindingIdentityV1>;
  try {
    derivedIdentity = deriveVoiceCredentialBindingIdentityV1({
      pluginId: mutation.contribution.pluginId,
      contribution: currentDeclaration,
    });
  } catch {
    derivedIdentity = null;
  }
  if (!derivedIdentity
    || !sameContribution(derivedIdentity.contribution, mutation.contribution)
    || derivedIdentity.credentialSlotId !== mutation.credentialSlotId) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_invalid',
      'Voice credential source mutation does not match the current declaration',
    );
  }
  const identity = parseVoiceCredentialSourceMutationIdentity(derivedIdentity);
  const selection = parseVoiceCredentialSourceSelection(mutation.selection);
  if (selection.kind === 'savedSecret'
    && currentDeclaration.credentials?.sources.some((source) => (
      source.kind === 'savedSecret'
    )) !== true) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_invalid',
      'Voice SavedSecret source is not declared by the current contribution',
    );
  }
  if (selection.kind === 'connectedAccount') {
    const selectedService = selection.target.kind === 'account'
      ? selection.target.account.service
      : selection.target.service;
    const declared = currentDeclaration.credentials?.sources.some((source) => (
      source.kind === 'connectedAccount'
      && sameContribution(
        typeof source.service === 'string'
          ? {
              pluginId: mutation.contribution.pluginId,
              localId: source.service,
            }
          : source.service,
        selectedService,
      )
    )) === true;
    if (!declared) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_invalid',
        'Voice Connected Account source is not declared by the current contribution',
      );
    }
  }
  if (mutation.savedSecretMutation) {
    if (mutation.savedSecretMutation.kind !== 'replaceVoiceCredentialSecret'
      && mutation.savedSecretMutation.kind !== 'bindVoiceCredentialSavedSecret') {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_invalid',
        'Voice credential source mutation may only carry a SavedSecret replacement or binding',
      );
    }
    if (selection.kind !== 'savedSecret') {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_invalid',
        'A Voice SavedSecret replacement may only accompany SavedSecret selection',
      );
    }
    const target = parseQualifiedVoiceCredentialTarget(
      mutation.savedSecretMutation.target,
    );
    if (
      !sameContribution(target.contribution, identity.contribution)
      || target.credentialSlotId !== identity.credentialSlotId
    ) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_invalid',
        'Voice SavedSecret replacement target does not match its source selection',
      );
    }
  }

  const withSecret = mutation.savedSecretMutation
    ? applyAccountSettingsSavedSecretMutation(
        settings,
        mutation.savedSecretMutation,
      ).settings
    : settings;
  const withSource = writeVoiceCredentialSource({
    settings: withSecret,
    contribution: identity.contribution,
    credentialSlotId: identity.credentialSlotId,
    kind: selection.kind,
  });
  const withPurpose = writeVoicePurposeBinding({
    settings: withSource,
    purpose: identity.purpose,
    selection,
  });
  return Object.freeze({
    settings: withPurpose.settings,
    selection,
    binding: withPurpose.binding,
  });
}

export function resolveAccountSettingsVoiceCredentialSource(
  settings: Readonly<Record<string, unknown>>,
  input: Readonly<{
    contribution: PluginContributionIdentityV1;
    credentialSlotId: string;
    purpose: QualifiedConnectedAccountPurposeV1;
    machineId: string | null;
  }>,
): AccountSettingsVoiceCredentialSourceResolution {
  const rawInput = ownRecord(input);
  if (
    !rawInput
    || !hasOnlyOwnKeys(rawInput, [
      'contribution',
      'credentialSlotId',
      'purpose',
      'machineId',
    ])
  ) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_invalid',
      'Voice credential source resolution input is invalid',
    );
  }
  const identity = parseVoiceCredentialSourceMutationIdentity(input);
  const target = parseQualifiedVoiceCredentialTarget({
    contribution: identity.contribution,
    credentialSlotId: identity.credentialSlotId,
    machineId: input.machineId,
  });
  const state = readVoiceCredentialTarget(settings, target);
  const source = ownRecord(state.binding?.credentialSource) ?? { kind: 'none' };
  const purposeBinding = findQualifiedPurposeBinding(
    readQualifiedPurposeBindings(settings),
    identity.purpose,
  );
  const rawDigest = state.binding?.approvedRecipientContractDigest;
  const approvedRecipientContractDigest = typeof rawDigest === 'string' ? rawDigest : null;
  if (source.kind === 'connectedAccount') {
    if (!purposeBinding) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_reference_invalid',
        'Selected Voice Connected Account binding is missing',
      );
    }
    return Object.freeze({
      selection: Object.freeze({
        kind: 'connectedAccount',
        target: purposeBinding.target,
      }),
      binding: purposeBinding,
      savedSecret: null,
      approvedRecipientContractDigest,
    });
  }
  if (purposeBinding) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_reference_invalid',
      'Dormant Voice Connected Account binding remained effective',
    );
  }
  if (source.kind === 'none') {
    return Object.freeze({
      selection: Object.freeze({ kind: 'none' }),
      binding: null,
      savedSecret: null,
      approvedRecipientContractDigest,
    });
  }
  if (source.kind !== 'savedSecret') {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_reference_invalid',
      'Voice credential source discriminant is invalid',
    );
  }
  const slotBindings = ownRecord(state.binding?.credentialBindings) ?? {};
  const account = ownRecord(slotBindings.account);
  const byMachineId = ownRecord(slotBindings.byMachineId);
  const machine = input.machineId === null
    ? null
    : ownRecord(byMachineId?.[input.machineId]);
  const machineSecretId = machine?.[identity.credentialSlotId];
  const accountSecretId = account?.[identity.credentialSlotId];
  const selected = input.machineId !== null && typeof machineSecretId === 'string'
    ? Object.freeze({
        secretId: machineSecretId,
        source: 'machine_override' as const,
      })
    : typeof accountSecretId === 'string'
      ? Object.freeze({
          secretId: accountSecretId,
          source: 'account' as const,
        })
      : null;
  const secrets = readSavedSecrets(settings);
  const savedSecret = selected
    && secrets.some((candidate) => candidate.id === selected.secretId)
    ? selected
    : null;
  return Object.freeze({
    selection: Object.freeze({ kind: 'savedSecret' }),
    binding: null,
    savedSecret,
    approvedRecipientContractDigest,
  });
}

function readConnectedAccountConfigurationEntries(
  settings: Readonly<Record<string, unknown>>,
): readonly ConnectedAccountServiceConfigurationEntryV1[] {
  const rawStore = settings[CONNECTED_ACCOUNT_SERVICE_CONFIGURATIONS_SETTINGS_KEY];
  if (rawStore === undefined) return Object.freeze([]);
  try {
    return Object.freeze(
      parseConnectedAccountServiceConfigurationsV1(rawStore).entries,
    );
  } catch {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_reference_invalid',
      'Connected Account service configuration references are invalid',
    );
  }
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
  // The plugin binding root is part of the same reference census as every
  // incumbent SavedSecret consumer. It contains only safe IDs, never raw
  // material, but it must still fail closed before a delete can proceed.
  readPluginAccountSecretBindings(settings);

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
      const binding = parseVoiceCredentialBindingForReferenceEnumeration(candidate);
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

function collectPluginSecretReferences(
  settings: Readonly<Record<string, unknown>>,
  secretId: string,
  output: AccountSettingsSavedSecretReference[],
): void {
  const bindings = readPluginAccountSecretBindings(settings);
  for (const [key, binding] of Object.entries(bindings)) {
    if (binding.savedSecretId === secretId) {
      output.push(Object.freeze({
        owner: 'plugin',
        path: `${PLUGIN_SECRET_BINDINGS_SETTINGS_KEY}${pathSegment(key)}`,
      }));
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
  collectPluginSecretReferences(settings, secretId, output);
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

/**
 * Verifies the caller's view of the record a Voice slot currently points at.
 *
 * The slot identity itself is compared separately (`exactSecretId`); this pins
 * the *record*. Three expectations are representable, and each is checked:
 *
 * - `null`/`null` — the slot points at nothing.
 * - id + `updatedAt` — the slot points at that record, unchanged.
 * - id + `null` — the slot points at a record the account no longer stores.
 *   A binding-loss event leaves exactly this state, and rejecting it as an
 *   ambiguous half-specification made the slot permanently unusable: binding,
 *   replacing, and removing all failed, so the user could never repair it.
 *   It is a checkable assertion, not a relaxation — the record must really be
 *   absent, otherwise the caller read a different snapshot and this conflicts.
 */
function assertVoiceCredentialSecretExpectation(
  secrets: readonly SavedSecret[],
  expectedSecretId: string | null,
  expectedSecretUpdatedAt: number | null,
): void {
  if (expectedSecretId === null) {
    if (expectedSecretUpdatedAt === null) return;
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_conflict',
      'Target-local Voice SavedSecret source changed',
    );
  }
  if (expectedSecretUpdatedAt !== null) {
    findSecret(secrets, expectedSecretId, expectedSecretUpdatedAt);
    return;
  }
  if (secrets.some((candidate) => candidate.id === expectedSecretId)) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_conflict',
      'Target-local Voice SavedSecret source changed',
    );
  }
}

/**
 * Applies one SavedSecret mutation and enforces the collection's capacity in the
 * same step.
 *
 * The canonical Account-Settings reader exposes at most
 * `SAVED_SECRET_COLLECTION_MAX_ENTRIES` records. A write that stores more is not
 * a larger collection; it is a collection whose overflow no reader can resolve,
 * so a still-referenced Provider secret would silently stop satisfying its slot
 * at spawn. The capacity is therefore refused at the write, not truncated at the
 * read. A collection that is ALREADY oversized (from a write this owner did not
 * make) can still shrink, so the only recovery path stays open.
 */
export function applyAccountSettingsSavedSecretMutation(
  settings: Readonly<Record<string, unknown>>,
  mutation: AccountSettingsSavedSecretMutation,
): Readonly<{
  settings: Readonly<Record<string, unknown>>;
}> {
  const result = applySavedSecretMutation(settings, mutation);
  const nextSecrets = result.settings.secrets;
  const currentSecrets = settings.secrets;
  const nextCount = Array.isArray(nextSecrets) ? nextSecrets.length : 0;
  const currentCount = Array.isArray(currentSecrets) ? currentSecrets.length : 0;
  if (nextCount > SAVED_SECRET_COLLECTION_MAX_ENTRIES && nextCount > currentCount) {
    throw new AccountSettingsSavedSecretMutationError(
      'saved_secret_collection_full',
      'Account Settings cannot hold another SavedSecret',
    );
  }
  return result;
}

function applySavedSecretMutation(
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
    && mutationKind !== 'bindVoiceCredentialSavedSecret'
    && mutationKind !== 'approveVoiceCredentialRecipientContract'
    && mutationKind !== 'removeVoiceCredentialSecret'
    && mutationKind !== 'replacePluginSecret'
    && mutationKind !== 'bindPluginSecret'
    && mutationKind !== 'removePluginSecret'
    && mutationKind !== 'unbindPluginSecret'
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
  if (mutation.kind === 'replacePluginSecret') {
    const replacementSecret = SavedSecretSchema.safeParse(mutation.secret);
    if (!replacementSecret.success) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_invalid',
        'Plugin SavedSecret replacement is invalid',
      );
    }
    if (secrets.some((candidate) => candidate.id === replacementSecret.data.id)) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_conflict',
        'Plugin SavedSecret identity already exists',
      );
    }
    const targetState = readPluginAccountSecretBindingTarget(settings, mutation.target);
    assertPluginSecretBindingExpectation(
      secrets,
      targetState.binding,
      mutation.expectedSecretId,
      mutation.expectedSecretUpdatedAt,
    );
    const rebound = writePluginAccountSecretBinding({
      settings,
      target: targetState.target,
      binding: Object.freeze({
        pluginId: targetState.target.pluginId,
        custody: 'account',
        localId: targetState.target.localId,
        savedSecretId: replacementSecret.data.id,
        createdForBinding: true,
      }),
    });
    const retained = removeUnreferencedBindingCreatedSecret({
      settings: rebound,
      secrets,
      binding: targetState.binding,
    });
    return Object.freeze({
      settings: Object.freeze({
        ...rebound,
        secrets: Object.freeze([mutation.secret, ...retained]),
      }),
    });
  }
  if (mutation.kind === 'bindPluginSecret') {
    if (typeof mutation.secretId !== 'string' || mutation.secretId.length === 0) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_invalid',
        'Plugin SavedSecret id is invalid',
      );
    }
    const targetState = readPluginAccountSecretBindingTarget(settings, mutation.target);
    assertPluginSecretBindingExpectation(
      secrets,
      targetState.binding,
      mutation.expectedSecretId,
      mutation.expectedSecretUpdatedAt,
    );
    if (!secrets.some((candidate) => candidate.id === mutation.secretId)) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_not_found',
        'The selected Plugin SavedSecret does not exist',
      );
    }
    const rebound = writePluginAccountSecretBinding({
      settings,
      target: targetState.target,
      binding: Object.freeze({
        pluginId: targetState.target.pluginId,
        custody: 'account',
        localId: targetState.target.localId,
        savedSecretId: mutation.secretId,
        createdForBinding: false,
      }),
    });
    const retained = removeUnreferencedBindingCreatedSecret({
      settings: rebound,
      secrets,
      binding: targetState.binding,
    });
    return Object.freeze({
      settings: Object.freeze({
        ...rebound,
        secrets: Object.freeze(retained),
      }),
    });
  }
  if (mutation.kind === 'removePluginSecret') {
    const targetState = readPluginAccountSecretBindingTarget(settings, mutation.target);
    assertPluginSecretBindingExpectation(
      secrets,
      targetState.binding,
      mutation.expectedSecretId,
      mutation.expectedSecretUpdatedAt,
    );
    const unbound = writePluginAccountSecretBinding({
      settings,
      target: targetState.target,
      binding: null,
    });
    const retained = removeUnreferencedBindingCreatedSecret({
      settings: unbound,
      secrets,
      binding: targetState.binding,
    });
    return Object.freeze({
      settings: Object.freeze({
        ...unbound,
        secrets: Object.freeze(retained),
      }),
    });
  }
  if (mutation.kind === 'unbindPluginSecret') {
    const targetState = readPluginAccountSecretBindingTarget(settings, mutation.target);
    assertPluginSecretBindingExpectation(
      secrets,
      targetState.binding,
      mutation.expectedSecretId,
      mutation.expectedSecretUpdatedAt,
    );
    const unbound = writePluginAccountSecretBinding({
      settings,
      target: targetState.target,
      binding: null,
    });
    return Object.freeze({
      settings: Object.freeze({
        ...unbound,
        secrets: Object.freeze(secrets),
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
    assertVoiceCredentialSecretExpectation(
      secrets,
      mutation.expectedSecretId,
      mutation.expectedSecretUpdatedAt,
    );
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
  if (mutation.kind === 'bindVoiceCredentialSavedSecret') {
    const targetState = readVoiceCredentialTarget(settings, mutation.target);
    if (targetState.exactSecretId !== mutation.expectedSecretId) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_conflict',
        'Target-local Voice credential changed',
      );
    }
    assertVoiceCredentialSecretExpectation(
      secrets,
      mutation.expectedSecretId,
      mutation.expectedSecretUpdatedAt,
    );
    if (!secrets.some((candidate) => candidate.id === mutation.secretId)) {
      throw new AccountSettingsSavedSecretMutationError(
        'saved_secret_not_found',
        'The selected SavedSecret does not exist',
      );
    }
    const bound = writeVoiceCredentialTarget({
      settings,
      target: mutation.target,
      state: targetState,
      secretId: mutation.secretId,
      ...(mutation.approvedRecipientContractDigest === undefined
        ? {}
        : {
            approvedRecipientContractDigest:
              mutation.approvedRecipientContractDigest,
          }),
    });
    // The previously bound record is left in place: it is a user-curated
    // SavedSecret the account still owns, not a slot-local value this binding
    // replaced. Deleting it here would destroy a secret the user can still
    // select elsewhere or re-select for this slot.
    return Object.freeze({
      settings: Object.freeze({
        ...bound,
        secrets: Object.freeze([...secrets]),
      }),
    });
  }
  if (mutation.kind === 'approveVoiceCredentialRecipientContract') {
    if (
      !VoiceCredentialBindingV1Schema.shape.approvedRecipientContractDigest
        .safeParse(mutation.approvedRecipientContractDigest).success
    ) {
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
