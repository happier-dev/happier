import { sameStrictJsonValue } from '../../json/strictJsonValue.js';
import { removeTransferredProfileSourcesV1 } from '../../profiles/read.js';
import { SavedSecretSchema } from '../../profiles/backendProfileSchema.js';
import { readSavedSecretTransferSourceV1 } from './savedSecretMutationOwner.js';
import type { AccountSettingsHistorySavedSecretTransferV1, AccountSettingsHistoryLegacyRoleArtifactTransferV1,
  AccountSettingsHistoryPrivateCatalogRevisionsV1 } from './accountSettingsApiV2.js';
import { LEGACY_ROLE_GUIDANCE_SETTINGS_ROOTS_V1 } from './rolesV1Migration.js';
import type { PromptLibraryCatalogKeyV1 } from '../../prompts/library/promptLibraryRowsV1.js';
import { removeTransferredPromptLibrarySourcesV1 } from '../../prompts/library/promptLibraryCatalogV1.js';
import { removeTransferredProviderConnectionsSourceV1 } from '../../providers/connections/providerConnectionsCatalogV1.js';
import { isCompleteLegacyNotificationChannelSourceV1, readLegacyNotificationChannelInventoryV1 } from './notificationChannelRecordV1.js';
import { hasConfiguredSecretStringValue } from './notificationChannels.js';
import { isCompleteRetainedRemoteHostCatalogV1, readRetainedRemoteHostCatalogV1 } from '../../remoteHosts/remoteHostRecordV1.js';
import { extractRetainedMcpServerCatalogPolicyV1 } from '../../mcp/servers/serverCatalogV1.js';
import {
  ACCOUNT_SETTING_DEFINITIONS,
  ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION,
  isRetiredAccountSettingsRootKey,
  parseRetainedAccountSettingsEntitySourceV1,
  UNSAFE_ACCOUNT_SETTINGS_ROOT_KEYS,
  type AccountSettingKey,
  type AccountSettingsPersistedObject,
} from './accountSettings.js';
import {
  ACCOUNT_SETTINGS_MAX_DOCUMENT_BYTES,
  inspectAccountSettingJsonStructuralBounds,
} from './catalog/accountSettingBounds.js';

/**
 * Why classification-aware restore refused to produce a document. The reasons
 * mirror the ordinary writer's vocabulary; `contentUnreadable` reports a
 * historical snapshot that is not a plain settings record at all.
 */
export type AccountSettingsHistoryRestoreInvalidReasonV1 =
  | 'invalidValue'
  | 'tooLarge'
  | 'tooDeep'
  | 'contentUnreadable';

export type AccountSettingsHistoryRestoreApplicationV1 =
  | Readonly<{
    status: 'applied' | 'unchanged';
    raw: AccountSettingsPersistedObject;
    /** Retained sensitive material still needs destination proof or exact purge. */
    cleanupPending?: true;
  }>
  | Readonly<{
    status: 'invalid';
    reason: AccountSettingsHistoryRestoreInvalidReasonV1;
  }>;

/** Content-free evidence supplied by the admitted destination domain owner. */
export type AccountSettingsHistoryDestinationAuthorityV1 = Readonly<{
  activeTransferredRoots: readonly string[];
  /** Derived from an opened active Profile control, never from source rows. */
  activeTransferredProfileIds?: readonly string[];
  /** Derived from admitted prompt rows/tombstones; surface keys never claim private Profile stacks. */
  activePromptLibraryKeys?: readonly PromptLibraryCatalogKeyV1[];
  savedSecretTransfers?: readonly AccountSettingsHistorySavedSecretTransferV1[];
  /** Complete current source retention, not a historical Role import inventory. */
  legacyRoleArtifactTransfers?: readonly AccountSettingsHistoryLegacyRoleArtifactTransferV1[];
  /** Opened private domain rows or retained tombstones at these exact revisions. */
  activePrivateCatalogRevisions?: AccountSettingsHistoryPrivateCatalogRevisionsV1;
}>;

export const LEGACY_ROLE_GUIDANCE_HISTORY_ROOTS_V1 = LEGACY_ROLE_GUIDANCE_SETTINGS_ROOTS_V1;
function activeHistoryRoots(authority: AccountSettingsHistoryDestinationAuthorityV1): Set<string> {
  const roots = new Set(authority.activeTransferredRoots.filter(root => root !== 'secrets' && root !== 'inferenceOpenAIKey'
    && !(LEGACY_ROLE_GUIDANCE_HISTORY_ROOTS_V1 as readonly string[]).includes(root)));
  if (authority.legacyRoleArtifactTransfers !== undefined) LEGACY_ROLE_GUIDANCE_HISTORY_ROOTS_V1.forEach(root => roots.add(root));
  return roots;
}

function accountSettingDefinition(key: string) {
  return Object.hasOwn(ACCOUNT_SETTING_DEFINITIONS, key)
    ? ACCOUNT_SETTING_DEFINITIONS[key as AccountSettingKey]
    : null;
}

function invalid(reason: AccountSettingsHistoryRestoreInvalidReasonV1):
  AccountSettingsHistoryRestoreApplicationV1 {
  return Object.freeze({ status: 'invalid', reason });
}

/** Only an exact recognized source item is covered by a transfer identity. */
export function readAccountSettingsHistorySavedSecretIdV1(value: unknown): string | null {
  const parsed = SavedSecretSchema.strict().safeParse(value);
  return parsed.success && sameStrictJsonValue(parsed.data, value) ? parsed.data.id : null;
}

/** Sanitizes one recorded document, not a restore: every unrelated byte value stays recorded. */
export function normalizeTransferredAccountSettingsHistoryV1(
  recordedRaw: unknown,
  authority: AccountSettingsHistoryDestinationAuthorityV1,
): AccountSettingsHistoryRestoreApplicationV1 {
  if (recordedRaw === null || typeof recordedRaw !== 'object' || Array.isArray(recordedRaw)) {
    return invalid('contentUnreadable');
  }
  let recorded = recordedRaw as Readonly<Record<string, unknown>>;
  // SavedSecret migration is per source identity: other personal material can
  // still share this root, so a transferred-root claim never deletes it whole.
  const activeRoots = activeHistoryRoots(authority);
  if (activeRoots.has('providerSettingsV1')) {
    const contraction = removeTransferredProviderConnectionsSourceV1(recorded);
    if (contraction.status !== 'ready') return invalid('invalidValue');
    recorded = contraction.raw;
  }
  if (activeRoots.has('mcpServersSettingsV1') && Object.hasOwn(recorded, 'mcpServersSettingsV1')) {
    const policy = extractRetainedMcpServerCatalogPolicyV1(recorded);
    if (policy.status === 'unavailable') return invalid('invalidValue');
    recorded = policy.raw;
  }
  // Destination authority suppresses restoration, but is not proof that every
  // historical credential has a usable destination. Unknown source bytes must
  // stay recorded until the source owner can characterize and admit them.
  let retainedNotificationSource = false;
  if (activeRoots.has('notificationChannelsV1') && Object.hasOwn(recorded, 'notificationChannelsV1')) {
    const inventory = readLegacyNotificationChannelInventoryV1(recorded);
    const provedSigningSources = new Set(authority.savedSecretTransfers?.flatMap(transfer => 'source' in transfer
      && transfer.source.kind === 'notification-channel-signing-secret' ? [transfer.source.channelId] : []) ?? []);
    const completeSource = inventory.status === 'ready' && isCompleteLegacyNotificationChannelSourceV1(recorded)
      && inventory.channels.every(channel => channel.kind !== 'webhook' || !hasConfiguredSecretStringValue(channel.signingSecret)
        || provedSigningSources.has(channel.id));
    if (!completeSource) {
      activeRoots.delete('notificationChannelsV1');
      retainedNotificationSource = true;
    }
  }
  let retainedRemoteHostSource = false;
  if (activeRoots.has('remoteHostsV1') && Object.hasOwn(recorded, 'remoteHostsV1')) {
    const inventory = readRetainedRemoteHostCatalogV1(recorded.remoteHostsV1);
    const provedSlots = new Set(authority.savedSecretTransfers?.flatMap(transfer => 'source' in transfer
      && transfer.source.kind === 'remote-host-ssh-credential' ? [JSON.stringify([transfer.source.hostId, transfer.source.slot])] : []) ?? []);
    const complete = inventory.status === 'ready' && isCompleteRetainedRemoteHostCatalogV1(recorded.remoteHostsV1)
      && inventory.hosts.every(host => (['password', 'identityPrivateKey'] as const).every(slot =>
        host.ssh[slot === 'password' ? 'passwordEnc' : 'identityPrivateKeyEnc'] == null
        || provedSlots.has(JSON.stringify([host.id, slot]))));
    if (!complete) { activeRoots.delete('remoteHostsV1'); retainedRemoteHostSource = true; }
  }
  const stripped = Object.fromEntries(Object.entries(recorded).filter(([key]) => !activeRoots.has(key)));
  const profilesRemoved = authority.activeTransferredProfileIds === undefined ? stripped
    : removeTransferredProfileSourcesV1(stripped, authority.activeTransferredProfileIds);
  const next = authority.activePromptLibraryKeys === undefined ? profilesRemoved
    : removeTransferredPromptLibrarySourcesV1(profilesRemoved, authority.activePromptLibraryKeys);
  if (authority.savedSecretTransfers?.length && Array.isArray(next.secrets)) {
    const migrated = new Set(authority.savedSecretTransfers.flatMap(transfer => 'savedSecretId' in transfer ? [transfer.savedSecretId] : []));
    next.secrets = next.secrets.filter(entry => {
      // Nested released schemas can strip future fields or supply defaults.
      // Only a losslessly recognized source item is covered by its identity proof.
      const id = readAccountSettingsHistorySavedSecretIdV1(entry);
      return id === null || !migrated.has(id);
    });
  }
  const retainedSecrets = Object.hasOwn(next, 'secrets') && (!Array.isArray(next.secrets) || next.secrets.length > 0);
  if (authority.savedSecretTransfers?.some(transfer => 'source' in transfer && transfer.source.kind === 'legacy-inference-openai-key')
    && readSavedSecretTransferSourceV1({ inferenceOpenAIKey: next.inferenceOpenAIKey }).inferenceCredential) delete next.inferenceOpenAIKey;
  // An unknown raw credential shape is never covered by a characterized source proof.
  const retainedInferenceCredential = next.inferenceOpenAIKey != null && next.inferenceOpenAIKey !== '';
  return Object.freeze({
    status: sameStrictJsonValue(recordedRaw, next) ? 'unchanged' : 'applied',
    raw: Object.freeze(next) as AccountSettingsPersistedObject,
    ...(retainedSecrets || retainedInferenceCredential || retainedNotificationSource || retainedRemoteHostSource ? { cleanupPending: true as const } : {}),
  });
}

/**
 * Merges one opened historical snapshot into the latest raw baseline under the
 * current catalog classification (SET-07):
 *
 *  1. `preference | policy` roots take the historical normalized value, and are
 *     reset (removed) when the historical snapshot omits them;
 *  2. `legacy` roots keep the latest baseline value unchanged — an older or
 *     absent historical copy never rewinds them;
 *  3. `transferring` and retired roots are stripped from the restored document
 *     and can never be resurrected from history;
 *  4. unknown supported-future keys keep only their latest-baseline value.
 *
 * The merged document is set to the current schema version, validated against
 * the same per-root and document bounds the ordinary CAS writer enforces, and
 * returned for the caller's ordinary whole-document write. Restore never
 * decrements the version and never writes by itself.
 */
export function applyAccountSettingsHistoryRestoreV1(
  latestRaw: Readonly<Record<string, unknown>>,
  historicalRaw: unknown,
  authority?: AccountSettingsHistoryDestinationAuthorityV1,
): AccountSettingsHistoryRestoreApplicationV1 {
  if (historicalRaw === null || typeof historicalRaw !== 'object' || Array.isArray(historicalRaw)) {
    return invalid('contentUnreadable');
  }
  let historical = historicalRaw as Readonly<Record<string, unknown>>;
  if (authority) {
    // Extract each recorded genuine policy before entity contraction removes
    // its old container; never substitute the latest document's preference.
    const prepared = normalizeTransferredAccountSettingsHistoryV1(historical, authority);
    if (prepared.status === 'invalid') return prepared;
    historical = prepared.raw;
  }
  const activeRoots = authority ? activeHistoryRoots(authority) : new Set<string>();

  const next: Record<string, unknown> = {};

  // Preference/policy roots: overlay the historical normalized value. Unknown
  // and legacy/transferring/retired roots found only in history never
  // resurrect here. `schemaVersion` is unconditionally replaced below, so a
  // malformed historical copy can never fail the restore.
  for (const [key, historicalValue] of Object.entries(historical)) {
    if (activeRoots.has(key)) continue;
    if (UNSAFE_ACCOUNT_SETTINGS_ROOT_KEYS.has(key)) continue;
    if (key === 'schemaVersion') continue;
    const definition = accountSettingDefinition(key);
    if (!definition) continue;
    if (definition.classification === 'legacy' || definition.classification === 'transferring') {
      continue;
    }
    const parsed = definition.parseMutationValue(historicalValue);
    if (!parsed.success) return invalid(parsed.reason);
    next[key] = parsed.data;
  }

  // Carry the latest baseline forward under the same classification rules.
  for (const [key, latestValue] of Object.entries(latestRaw)) {
    if (activeRoots.has(key)) continue;
    if (UNSAFE_ACCOUNT_SETTINGS_ROOT_KEYS.has(key)) continue;
    if (isRetiredAccountSettingsRootKey(key)) continue;
    const definition = accountSettingDefinition(key);
    if (!definition) {
      // Supported-future root: preserve the latest value only.
      if (!Object.hasOwn(next, key)) next[key] = latestValue;
      continue;
    }
    if (definition.classification === 'transferring') continue;
    if (definition.classification === 'legacy') {
      next[key] = latestValue;
      continue;
    }
    // preference/policy: the historical value is already in place; a key the
    // historical snapshot omits stays absent (reset).
  }

  // The restored document is current: a historical schemaVersion never rewinds it.
  if (authority) {
    const application = normalizeTransferredAccountSettingsHistoryV1(next, authority);
    if (application.status === 'invalid') return application;
    for (const key of Object.keys(next)) delete next[key];
    Object.assign(next, application.raw);
  }
  next.schemaVersion = ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION;

  // Validate every known root exactly like the ordinary writer's postcondition:
  // the same structural policy and the same per-key schema, so restore can fail
  // typed before any write instead of persisting a document the writer would
  // reject.
  for (const [key, value] of Object.entries(next)) {
    const retainedSource = parseRetainedAccountSettingsEntitySourceV1(key, value);
    if (retainedSource) {
      if (!retainedSource.success) return invalid(retainedSource.reason);
      continue;
    }
    const definition = accountSettingDefinition(key);
    if (!definition) continue;
    if (definition.structuralBoundsOwner !== 'domainOwned') {
      const structuralIssue = inspectAccountSettingJsonStructuralBounds(value);
      if (structuralIssue) return invalid(structuralIssue.reason);
    }
    const parsed = definition.parseMutationValue(value);
    if (!parsed.success) return invalid(parsed.reason);
  }

  // The same document byte ceiling the ordinary whole-document CAS enforces.
  try {
    const serialized = JSON.stringify(next);
    if (serialized === undefined
      || new TextEncoder().encode(serialized).byteLength > ACCOUNT_SETTINGS_MAX_DOCUMENT_BYTES) {
      return invalid('tooLarge');
    }
  } catch {
    return invalid('invalidValue');
  }

  return Object.freeze({
    status: sameStrictJsonValue(latestRaw, next) ? 'unchanged' : 'applied',
    raw: Object.freeze(next) as AccountSettingsPersistedObject,
  });
}
