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
  decodedJsonBytes: 4 * 1024 * 1024,
  readDiagnostics: 256,
} as const);
