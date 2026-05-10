export const SCM_DIFF_SUMMARY_SETTING_KEYS = {
    enabled: 'scm.diffSummary.enabled',
    prefetch: 'scm.diffSummary.prefetch',
    modelProfileOverride: 'scm.diffSummary.modelProfileOverride',
} as const;

export type ScmDiffSummaryCatalogProfile = Readonly<{
    catalogId: string;
    title: string;
}>;

export type ResolvedScmDiffSummarySettings = Readonly<{
    enabled: boolean;
    prefetch: boolean;
    modelOverride: ScmDiffSummaryCatalogProfile | null;
}>;

function readBooleanSetting(settings: Readonly<Record<string, unknown>>, key: string, defaultValue: boolean): boolean {
    const value = settings[key];
    return typeof value === 'boolean' ? value : defaultValue;
}

function resolveModelOverride(
    storedSettings: Readonly<Record<string, unknown>>,
    catalogProfiles: readonly ScmDiffSummaryCatalogProfile[],
): ScmDiffSummaryCatalogProfile | null {
    const raw = storedSettings[SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride];
    if (typeof raw !== 'string') return null;
    const catalogId = raw.trim();
    if (!catalogId) return null;
    return catalogProfiles.find((profile) => profile.catalogId === catalogId) ?? null;
}

export function resolveScmDiffSummarySettings(params: Readonly<{
    storedSettings: Readonly<Record<string, unknown>>;
    catalogProfiles: readonly ScmDiffSummaryCatalogProfile[];
}>): ResolvedScmDiffSummarySettings {
    return {
        enabled: readBooleanSetting(params.storedSettings, SCM_DIFF_SUMMARY_SETTING_KEYS.enabled, true),
        prefetch: readBooleanSetting(params.storedSettings, SCM_DIFF_SUMMARY_SETTING_KEYS.prefetch, false),
        modelOverride: resolveModelOverride(params.storedSettings, params.catalogProfiles),
    };
}
