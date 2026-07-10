export const MODEL_OVERRIDE_KEY = 'modelOverrideV1';
export const MODEL_SELECTION_INTENT_KEY = 'modelSelectionIntentV1';

export const PERMISSION_MODE_KEY = 'permissionMode';
export const PERMISSION_MODE_UPDATED_AT_KEY = 'permissionModeUpdatedAt';

export const SESSION_MODE_OVERRIDE_KEY = 'sessionModeOverrideV1';
export const LEGACY_ACP_SESSION_MODE_OVERRIDE_KEY = 'acpSessionModeOverrideV1';

export const SESSION_CONFIG_OPTION_OVERRIDES_KEY = 'sessionConfigOptionOverridesV1';
export const LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY = 'acpConfigOptionOverridesV1';

export function getIntentMetadataKeysForAlias(key: string): readonly string[] {
  switch (key) {
    case SESSION_MODE_OVERRIDE_KEY:
    case LEGACY_ACP_SESSION_MODE_OVERRIDE_KEY:
      return [SESSION_MODE_OVERRIDE_KEY, LEGACY_ACP_SESSION_MODE_OVERRIDE_KEY];
    case SESSION_CONFIG_OPTION_OVERRIDES_KEY:
    case LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY:
      return [SESSION_CONFIG_OPTION_OVERRIDES_KEY, LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY];
    default:
      return [key];
  }
}
