import { ACCOUNT_SETTINGS_MAX_PROVIDER_SUBTREE_BYTES } from '../../account/settings/catalog/accountSettingBounds.js';

export const PROVIDER_SETTINGS_LIMITS_V1 = Object.freeze({
  connectionTombstones: 256,
  experimentalBindingConfirmations: 2_048,
  manualModelsPerConnection: 500,
  manualModelsTotal: 5_000,
  modelVisibilityExceptions: 20_000,
  credentialSlotsPerScope: 8,
  defaultsByAgentTargetKey: 2_048,
  migrationCompletedSources: 2_048,
  migrationPendingCustomProfiles: 2_048,
  migrationPendingConflicts: 2_048,
  // The Provider subtree is persisted inside the Account Settings document, so the
  // advertised maximum must be the ceiling that document can actually hold. A larger
  // advertised allowance produces writes Provider validation accepts and the canonical
  // Account write path then refuses.
  decodedJsonBytes: ACCOUNT_SETTINGS_MAX_PROVIDER_SUBTREE_BYTES,
  readDiagnostics: 256,
} as const);
