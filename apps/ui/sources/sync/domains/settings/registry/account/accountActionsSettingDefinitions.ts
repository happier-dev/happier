import {
    ActionsSettingsV1Schema,
    DEFAULT_ACTIONS_SETTINGS_V1,
    buildSettingArtifacts,
    defineSettingDefinitions,
} from '@happier-dev/protocol';

function buildActionsSettingsSummaryProperties(value: unknown): Record<string, number> {
    const actions =
        value && typeof value === 'object' && !Array.isArray(value) && 'actions' in (value as Record<string, unknown>)
            ? (value as { actions?: Record<string, {
                enabled?: boolean;
                enabledPlacements?: ReadonlyArray<unknown>;
                disabledSurfaces?: ReadonlyArray<unknown>;
                disabledPlacements?: ReadonlyArray<unknown>;
            }> }).actions ?? {}
            : {};

    let enabledOverrideCount = 0;
    let enabledPlacementCount = 0;
    let disabledSurfaceCount = 0;
    let disabledPlacementCount = 0;

    for (const override of Object.values(actions)) {
        if (!override || typeof override !== 'object') continue;
        if (override.enabled !== undefined) enabledOverrideCount += 1;
        enabledPlacementCount += Array.isArray(override.enabledPlacements) ? override.enabledPlacements.length : 0;
        disabledSurfaceCount += Array.isArray(override.disabledSurfaces) ? override.disabledSurfaces.length : 0;
        disabledPlacementCount += Array.isArray(override.disabledPlacements) ? override.disabledPlacements.length : 0;
    }

    return {
        overrideCount: Object.keys(actions).length,
        enabledOverrideCount,
        enabledPlacementCount,
        disabledSurfaceCount,
        disabledPlacementCount,
    };
}

export const ACCOUNT_ACTIONS_SETTING_DEFINITIONS = defineSettingDefinitions({
    actionsSettingsV1: {
        schema: ActionsSettingsV1Schema,
        default: DEFAULT_ACTIONS_SETTINGS_V1,
        description: 'Global action settings (enablement + surface/placement overrides)',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'person',
            serializeCurrentProperties: buildActionsSettingsSummaryProperties,
        },
    },
});

export const ACCOUNT_ACTIONS_SETTING_ARTIFACTS = buildSettingArtifacts(
    ACCOUNT_ACTIONS_SETTING_DEFINITIONS,
);
