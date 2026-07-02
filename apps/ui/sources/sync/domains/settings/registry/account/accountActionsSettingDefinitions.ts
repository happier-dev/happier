import {
    ACTION_TOOL_EXPOSURE_SURFACES,
    ActionToolExposureModeSchema,
    ActionsSettingsV1Schema,
    DEFAULT_ACTIONS_SETTINGS_V1,
    buildSettingArtifacts,
    defineSettingDefinitions,
    type ActionToolExposureMode,
    type ActionToolExposureSurface,
} from '@happier-dev/protocol';

type ActionSettingsOverrideLike = Readonly<{
    enabled?: boolean;
    enabledPlacements?: ReadonlyArray<unknown>;
    disabledSurfaces?: ReadonlyArray<unknown>;
    disabledPlacements?: ReadonlyArray<unknown>;
    approvalRequiredSurfaces?: ReadonlyArray<unknown>;
    toolExposureModes?: unknown;
}>;

type NormalizedActionSettingsOverride = Readonly<{
    enabled: boolean | null;
    enabledPlacements: ReadonlyArray<string>;
    disabledSurfaces: ReadonlyArray<string>;
    disabledPlacements: ReadonlyArray<string>;
    approvalRequiredSurfaces: ReadonlyArray<string>;
    toolExposureModes: Partial<Record<ActionToolExposureSurface, ActionToolExposureMode>>;
}>;

const ACTION_TOOL_EXPOSURE_SURFACE_SET = new Set<ActionToolExposureSurface>(ACTION_TOOL_EXPOSURE_SURFACES);

function normalizeStringSet(raw: ReadonlyArray<unknown> | undefined): ReadonlyArray<string> {
    if (!Array.isArray(raw) || raw.length === 0) return [];
    const out = new Set<string>();
    for (const entry of raw) {
        if (typeof entry !== 'string') continue;
        const trimmed = entry.trim();
        if (!trimmed) continue;
        out.add(trimmed);
    }
    return Array.from(out).sort();
}

function normalizeToolExposureModes(raw: unknown): Partial<Record<ActionToolExposureSurface, ActionToolExposureMode>> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return {};
    }

    const next: Partial<Record<ActionToolExposureSurface, ActionToolExposureMode>> = {};
    for (const [surface, mode] of Object.entries(raw as Record<string, unknown>)) {
        if (!ACTION_TOOL_EXPOSURE_SURFACE_SET.has(surface as ActionToolExposureSurface)) continue;
        const parsed = ActionToolExposureModeSchema.safeParse(mode);
        if (!parsed.success) continue;
        next[surface as ActionToolExposureSurface] = parsed.data;
    }
    return next;
}

function normalizeOverride(raw: unknown): NormalizedActionSettingsOverride {
    const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as ActionSettingsOverrideLike) : null;
    const enabled = typeof value?.enabled === 'boolean' ? value.enabled : null;
    return {
        enabled,
        enabledPlacements: normalizeStringSet(value?.enabledPlacements),
        disabledSurfaces: normalizeStringSet(value?.disabledSurfaces),
        disabledPlacements: normalizeStringSet(value?.disabledPlacements),
        approvalRequiredSurfaces: normalizeStringSet(value?.approvalRequiredSurfaces),
        toolExposureModes: normalizeToolExposureModes(value?.toolExposureModes),
    };
}

function areOverridesEqual(a: NormalizedActionSettingsOverride, b: NormalizedActionSettingsOverride): boolean {
    if (a.enabled !== b.enabled) return false;
    if (a.enabledPlacements.length !== b.enabledPlacements.length) return false;
    if (a.disabledSurfaces.length !== b.disabledSurfaces.length) return false;
    if (a.disabledPlacements.length !== b.disabledPlacements.length) return false;
    if (a.approvalRequiredSurfaces.length !== b.approvalRequiredSurfaces.length) return false;
    for (let i = 0; i < a.enabledPlacements.length; i += 1) {
        if (a.enabledPlacements[i] !== b.enabledPlacements[i]) return false;
    }
    for (let i = 0; i < a.disabledSurfaces.length; i += 1) {
        if (a.disabledSurfaces[i] !== b.disabledSurfaces[i]) return false;
    }
    for (let i = 0; i < a.disabledPlacements.length; i += 1) {
        if (a.disabledPlacements[i] !== b.disabledPlacements[i]) return false;
    }
    for (let i = 0; i < a.approvalRequiredSurfaces.length; i += 1) {
        if (a.approvalRequiredSurfaces[i] !== b.approvalRequiredSurfaces[i]) return false;
    }
    for (const surface of ACTION_TOOL_EXPOSURE_SURFACES) {
        if (a.toolExposureModes[surface] !== b.toolExposureModes[surface]) return false;
    }
    return true;
}

function countAddedStrings(current: ReadonlyArray<string>, base: ReadonlyArray<string>): number {
    if (current.length === 0) return 0;
    if (base.length === 0) return current.length;
    const baseSet = new Set(base);
    let count = 0;
    for (const entry of current) {
        if (!baseSet.has(entry)) count += 1;
    }
    return count;
}

function countToolExposureOverrides(
    current: Partial<Record<ActionToolExposureSurface, ActionToolExposureMode>>,
    base: Partial<Record<ActionToolExposureSurface, ActionToolExposureMode>>,
): number {
    let count = 0;
    for (const surface of ACTION_TOOL_EXPOSURE_SURFACES) {
        const mode = current[surface];
        if (mode === base[surface]) continue;
        count += 1;
    }
    return count;
}

function buildActionsSettingsSummaryProperties(value: unknown): Record<string, number> {
    const actions =
        value && typeof value === 'object' && !Array.isArray(value) && 'actions' in (value as Record<string, unknown>)
            ? (value as { actions?: Record<string, {
                enabled?: boolean;
                enabledPlacements?: ReadonlyArray<unknown>;
                disabledSurfaces?: ReadonlyArray<unknown>;
                disabledPlacements?: ReadonlyArray<unknown>;
                approvalRequiredSurfaces?: ReadonlyArray<unknown>;
                toolExposureModes?: unknown;
            }> }).actions ?? {}
            : {};

    const defaultActions = DEFAULT_ACTIONS_SETTINGS_V1.actions ?? {};

    let enabledOverrideCount = 0;
    let enabledPlacementCount = 0;
    let disabledSurfaceCount = 0;
    let disabledPlacementCount = 0;
    let approvalRequiredSurfaceCount = 0;
    let toolExposureOverrideCount = 0;
    let overrideCount = 0;

    for (const [actionId, rawOverride] of Object.entries(actions)) {
        const normalized = normalizeOverride(rawOverride);
        const normalizedDefault = normalizeOverride((defaultActions as Record<string, unknown>)[actionId]);

        const isOverride = !areOverridesEqual(normalized, normalizedDefault);
        if (!isOverride) continue;
        overrideCount += 1;

        if (normalized.enabled !== null && normalized.enabled !== normalizedDefault.enabled) {
            enabledOverrideCount += 1;
        }
        enabledPlacementCount += countAddedStrings(normalized.enabledPlacements, normalizedDefault.enabledPlacements);
        disabledSurfaceCount += countAddedStrings(normalized.disabledSurfaces, normalizedDefault.disabledSurfaces);
        disabledPlacementCount += countAddedStrings(normalized.disabledPlacements, normalizedDefault.disabledPlacements);
        approvalRequiredSurfaceCount += countAddedStrings(normalized.approvalRequiredSurfaces, normalizedDefault.approvalRequiredSurfaces);
        toolExposureOverrideCount += countToolExposureOverrides(normalized.toolExposureModes, normalizedDefault.toolExposureModes);
    }

    return {
        overrideCount,
        enabledOverrideCount,
        enabledPlacementCount,
        disabledSurfaceCount,
        disabledPlacementCount,
        approvalRequiredSurfaceCount,
        toolExposureOverrideCount,
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
