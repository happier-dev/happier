export const SESSION_MODES_STATE_KEY = 'sessionModesV1';
export const LEGACY_ACP_SESSION_MODES_STATE_KEY = 'acpSessionModesV1';

export const SESSION_MODE_OVERRIDE_KEY = 'sessionModeOverrideV1';
export const LEGACY_ACP_SESSION_MODE_OVERRIDE_KEY = 'acpSessionModeOverrideV1';

export const SESSION_MODELS_STATE_KEY = 'sessionModelsV1';
export const LEGACY_ACP_SESSION_MODELS_STATE_KEY = 'acpSessionModelsV1';

export const SESSION_CONFIG_OPTIONS_STATE_KEY = 'sessionConfigOptionsV1';
export const LEGACY_ACP_CONFIG_OPTIONS_STATE_KEY = 'acpConfigOptionsV1';

export const SESSION_CONFIG_OPTION_OVERRIDES_KEY = 'sessionConfigOptionOverridesV1';
export const LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY = 'acpConfigOptionOverridesV1';

export function getMetadataKeysForAlias(key: string): readonly string[] {
    switch (key) {
        case SESSION_MODES_STATE_KEY:
        case LEGACY_ACP_SESSION_MODES_STATE_KEY:
            return [SESSION_MODES_STATE_KEY, LEGACY_ACP_SESSION_MODES_STATE_KEY];
        case SESSION_MODE_OVERRIDE_KEY:
        case LEGACY_ACP_SESSION_MODE_OVERRIDE_KEY:
            return [SESSION_MODE_OVERRIDE_KEY, LEGACY_ACP_SESSION_MODE_OVERRIDE_KEY];
        case SESSION_MODELS_STATE_KEY:
        case LEGACY_ACP_SESSION_MODELS_STATE_KEY:
            return [SESSION_MODELS_STATE_KEY, LEGACY_ACP_SESSION_MODELS_STATE_KEY];
        case SESSION_CONFIG_OPTIONS_STATE_KEY:
        case LEGACY_ACP_CONFIG_OPTIONS_STATE_KEY:
            return [SESSION_CONFIG_OPTIONS_STATE_KEY, LEGACY_ACP_CONFIG_OPTIONS_STATE_KEY];
        case SESSION_CONFIG_OPTION_OVERRIDES_KEY:
        case LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY:
            return [SESSION_CONFIG_OPTION_OVERRIDES_KEY, LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY];
        default:
            return [key];
    }
}

export function readMetadataAliasValue<T>(metadata: Record<string, unknown> | null | undefined, ...keys: readonly string[]): T | undefined {
    if (!metadata) return undefined;
    for (const key of keys) {
        if (key in metadata) return metadata[key] as T;
    }
    return undefined;
}
