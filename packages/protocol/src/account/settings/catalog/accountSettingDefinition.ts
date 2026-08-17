import type { ZodTypeAny } from 'zod';

import { buildSettingArtifacts } from '../../../settings/registry/buildSettingArtifacts.js';
import type {
  SettingAnalyticsMetadata,
  SettingDefinition,
} from '../../../settings/registry/settingDefinition.js';

export const ACCOUNT_SETTING_CLASSIFICATIONS = [
  'preference',
  'policy',
  'legacy',
  'transferring',
] as const;

export type AccountSettingClassification = typeof ACCOUNT_SETTING_CLASSIFICATIONS[number];

export type AccountSettingCompatibility = Readonly<{
  provenance: string;
  removalCondition: string;
}>;

export type AccountSettingDefinition<TSchema extends ZodTypeAny = ZodTypeAny> =
  SettingDefinition<TSchema> & Readonly<{
    semanticDomain: string;
    classification: AccountSettingClassification;
    maximumSerializedValueBytes: number;
    compatibility?: AccountSettingCompatibility;
  }>;

function assertAccountSettingDefinition(key: string, definition: AccountSettingDefinition): void {
  if (definition.semanticDomain.trim().length === 0) {
    throw new Error(`Account setting \"${key}\" requires a semantic domain`);
  }
  if (!Number.isSafeInteger(definition.maximumSerializedValueBytes) || definition.maximumSerializedValueBytes < 1) {
    throw new Error(`Account setting \"${key}\" requires a positive serialized-byte bound`);
  }
  if ((definition.classification === 'legacy' || definition.classification === 'transferring') && !definition.compatibility) {
    throw new Error(`Account setting \"${key}\" requires compatibility provenance and a removal condition`);
  }
  if (definition.compatibility && (
    definition.compatibility.provenance.trim().length === 0
    || definition.compatibility.removalCondition.trim().length === 0
  )) {
    throw new Error(`Account setting \"${key}\" has incomplete compatibility metadata`);
  }
}

/**
 * The Account snapshot is a Protocol-owned persistence contract. This constructor deliberately
 * accepts only Account-scoped definitions and makes a legacy root's provenance/removal condition
 * explicit, so callers cannot accidentally grow a UI-only parallel schema.
 */
export function defineAccountSettingDefinitions<
  const TDefinitions extends Readonly<Record<string, AccountSettingDefinition>>,
>(
  definitions: TDefinitions,
): TDefinitions {
  for (const [key, definition] of Object.entries(definitions)) {
    assertAccountSettingDefinition(key, definition);
  }
  // `buildSettingArtifacts` validates schemas/defaults and analytics contracts at catalog
  // construction. Its result is intentionally discarded here; callers own one generated
  // artifact instance for the full catalog.
  buildSettingArtifacts(definitions);
  return definitions;
}
