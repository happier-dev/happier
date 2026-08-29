import { sameStrictJsonValue } from '../../json/strictJsonValue.js';
import {
  ACCOUNT_SETTING_DEFINITIONS,
  ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION,
  isRetiredAccountSettingsRootKey,
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
  }>
  | Readonly<{
    status: 'invalid';
    reason: AccountSettingsHistoryRestoreInvalidReasonV1;
  }>;

function accountSettingDefinition(key: string) {
  return Object.hasOwn(ACCOUNT_SETTING_DEFINITIONS, key)
    ? ACCOUNT_SETTING_DEFINITIONS[key as AccountSettingKey]
    : null;
}

function invalid(reason: AccountSettingsHistoryRestoreInvalidReasonV1):
  AccountSettingsHistoryRestoreApplicationV1 {
  return Object.freeze({ status: 'invalid', reason });
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
): AccountSettingsHistoryRestoreApplicationV1 {
  if (historicalRaw === null || typeof historicalRaw !== 'object' || Array.isArray(historicalRaw)) {
    return invalid('contentUnreadable');
  }
  const historical = historicalRaw as Readonly<Record<string, unknown>>;

  const next: Record<string, unknown> = {};

  // Preference/policy roots: overlay the historical normalized value. Unknown
  // and legacy/transferring/retired roots found only in history never
  // resurrect here. `schemaVersion` is unconditionally replaced below, so a
  // malformed historical copy can never fail the restore.
  for (const [key, historicalValue] of Object.entries(historical)) {
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
  next.schemaVersion = ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION;

  // Validate every known root exactly like the ordinary writer's postcondition:
  // the same structural policy and the same per-key schema, so restore can fail
  // typed before any write instead of persisting a document the writer would
  // reject.
  for (const [key, value] of Object.entries(next)) {
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
