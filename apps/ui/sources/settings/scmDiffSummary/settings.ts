import { ScmDiffSummaryModelSelectorSchema, type ScmDiffSummaryModelSelector } from '@happier-dev/protocol/scm/diffSummary';
import { parseBackendTargetKeyV2, readBackendTargetRefV2, type BackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { CapabilitySupport } from '@happier-dev/protocol/providers/capabilities/v1';
import { ACCOUNT_SETTING_DEFINITIONS } from '@happier-dev/protocol/account/settings/accountSettings';
import type { SettingStorageBinding } from '@/components/settings/catalog/settingDeclarations';

export const SCM_DIFF_SUMMARY_SETTING_KEYS = {
    enabled: 'scm.diffSummary.enabled',
    prefetch: 'scm.diffSummary.prefetch',
    modelProfileOverride: 'scm.diffSummary.modelProfileOverride',
} as const;

export type ScmDiffSummaryCatalogProfile = Readonly<{
    catalogId: string;
    title: string;
    modelSelector?: ScmDiffSummaryModelSelector;
    structuredOutput?: CapabilitySupport;
}>;

export type ResolvedScmDiffSummarySettings = Readonly<{
    enabled: boolean;
    prefetch: boolean;
    modelOverride: ScmDiffSummaryCatalogProfile | null;
    modelOverrideError?: 'SCM_DIFF_SUMMARY_MODEL_UNSUPPORTED' | 'SCM_DIFF_SUMMARY_MODEL_UNAVAILABLE';
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

const MODEL_SELECTOR_PREFIX = 'model:';

/** The existing string preference carries the canonical selector, never a display label. */
export function encodeScmDiffSummaryModelOverride(selector: ScmDiffSummaryModelSelector): string {
    return `${MODEL_SELECTOR_PREFIX}${JSON.stringify(ScmDiffSummaryModelSelectorSchema.parse(selector))}`;
}

export function decodeScmDiffSummaryModelOverride(value: string): ScmDiffSummaryModelSelector | null {
    if (!value.startsWith(MODEL_SELECTOR_PREFIX)) return null;
    try { return ScmDiffSummaryModelSelectorSchema.parse(JSON.parse(value.slice(MODEL_SELECTOR_PREFIX.length))); }
    catch { return null; }
}

export function resolveScmDiffSummaryModelSelection(params: Readonly<{
    storedValue: string; defaultBackendTarget?: BackendTargetRefV2 | null;
    catalogProfiles?: readonly ScmDiffSummaryCatalogProfile[];
}>): Readonly<{ success: true; backendTarget: BackendTargetRefV2; modelSelector: ScmDiffSummaryModelSelector }>
    | Readonly<{ success: false; errorCode: 'SCM_DIFF_SUMMARY_MODEL_UNAVAILABLE' | 'SCM_DIFF_SUMMARY_MODEL_UNSUPPORTED' }> {
    const resolved = resolveScmDiffSummarySettings({ storedSettings: { [SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride]: params.storedValue }, catalogProfiles: params.catalogProfiles ?? [] });
    if (resolved.modelOverrideError) return { success: false, errorCode: resolved.modelOverrideError };
    const override = resolved.modelOverride;
    const selector = override?.modelSelector ?? (override?.catalogId.startsWith('profile:')
        ? { profileId: override.catalogId.slice('profile:'.length) } : override ? { backendTargetKey: override.catalogId } : { modelId: 'default' });
    try {
        const backendTarget = selector.backendTargetKey ? readBackendTargetRefV2(parseBackendTargetKeyV2(selector.backendTargetKey)) : params.defaultBackendTarget;
        return backendTarget ? { success: true, backendTarget, modelSelector: selector } : { success: false, errorCode: 'SCM_DIFF_SUMMARY_MODEL_UNAVAILABLE' };
    } catch { return { success: false, errorCode: 'SCM_DIFF_SUMMARY_MODEL_UNAVAILABLE' }; }
}

export function resolveScmDiffSummarySettings(params: Readonly<{
    storedSettings: Readonly<Record<string, unknown>>;
    catalogProfiles: readonly ScmDiffSummaryCatalogProfile[];
}>): ResolvedScmDiffSummarySettings {
    const raw = params.storedSettings[SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride];
    const value = typeof raw === 'string' ? raw.trim() : '';
    const catalogOverride = resolveModelOverride(params.storedSettings, params.catalogProfiles);
    const selector = value ? decodeScmDiffSummaryModelOverride(value) : null;
    const override: ScmDiffSummaryCatalogProfile | null = catalogOverride ?? (selector ? { catalogId: value, title: selector.modelId ?? selector.profileId ?? value, modelSelector: selector } : null);
    const unsupported = override?.structuredOutput === 'unsupported' || override?.structuredOutput === 'unknown';
    return {
        enabled: readBooleanSetting(params.storedSettings, SCM_DIFF_SUMMARY_SETTING_KEYS.enabled, true),
        prefetch: readBooleanSetting(params.storedSettings, SCM_DIFF_SUMMARY_SETTING_KEYS.prefetch, false),
        modelOverride: unsupported ? null : override,
        ...(unsupported ? { modelOverrideError: 'SCM_DIFF_SUMMARY_MODEL_UNSUPPORTED' as const }
            : value && !override ? { modelOverrideError: 'SCM_DIFF_SUMMARY_MODEL_UNAVAILABLE' as const } : {}),
    };
}

/** Settings UI and Actions admit the same catalog-backed scalar intent at the Account CAS owner. */
export function scmDiffSummarySettingBinding(key: typeof SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride | typeof SCM_DIFF_SUMMARY_SETTING_KEYS.prefetch): SettingStorageBinding {
    return {
        scope: 'account', kind: 'owner', access: 'read_write',
        read: settings => settings[key],
        parse: value => {
            const parsed = ACCOUNT_SETTING_DEFINITIONS[key].parseMutationValue(value);
            if (!parsed.success || (typeof parsed.data !== 'string' && typeof parsed.data !== 'boolean')) return { success: false };
            return { success: true, value: parsed.data };
        },
        // Support comes from the catalog prepare phase; scalar schema alone never admits a model.
        mutate: () => null,
        prepare: async (settings, value, services, context) => {
            if (key === SCM_DIFF_SUMMARY_SETTING_KEYS.prefetch && value === false) {
                return () => context?.isCurrent() === false ? null : { [key]: false };
            }
            const storedValue = key === SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride
                ? String(value) : settings[SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride];
            const catalog = await services.readScmDiffSummaryCatalog?.(settings, storedValue);
            const profile = catalog?.profiles.find(candidate => candidate.catalogId === storedValue);
            if (!catalog || profile?.structuredOutput !== 'supported'
                || !resolveScmDiffSummaryModelSelection({ storedValue, catalogProfiles: catalog.profiles }).success) return null;
            return current => {
                if (context?.isCurrent() === false || !catalog.isCurrent(current)
                    || (key === SCM_DIFF_SUMMARY_SETTING_KEYS.prefetch && current[SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride] !== storedValue)) return null;
                return { [key]: value };
            };
        },
    };
}
