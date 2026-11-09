import { ScmDiffSummaryModelSelectorSchema, ScmDiffSummaryOutputLanguageSchema, type ScmDiffSummaryModelSelector } from '../../scm/diffSummary.js';
import { BackendTargetKeyV2Schema, buildBackendTargetKeyV2, parseBackendTargetKeyV2, readBackendTargetRefV2, type BackendTargetRefV2 } from '../../backends/targets/backendTargetRefV2.js';
import type { ProviderModelDescriptorV1 } from '../../models/descriptor.js';
import type { CapabilitySupport } from '../../providers/capabilities/v1.js';
import { ACCOUNT_SETTING_DEFINITIONS, type AccountSettings } from '../../account/settings/accountSettings.js';
import type { SettingDomainValueV1 } from './settingsOwnerActions.js';
import { ProviderBoundModelRefSchema } from '../../providers/selection/v1.js';
import { ConnectedServiceBindingsV2Schema } from '../../connect/connectedServiceBindings.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { SpawnFailureV1Schema, type SpawnFailureV1 } from '../../machines/processes/spawnFailureV1.js';

/** Read-only observation of the executing machine's admitted summary candidates. */
const ScmDiffSummaryCatalogProfileSchema = lazyZodSchema(() => z.strictObject({
        catalogId: z.string(), title: z.string(),
        modelSelector: z.optional(ScmDiffSummaryModelSelectorSchema),
        structuredOutput: z.optional(z.enum(['supported', 'unsupported', 'unknown'])),
        costTier: z.optional(z.enum(['low', 'standard', 'premium'])),
}));
const ScmDiffSummaryCatalogUnavailableTargetV1Schema = lazyZodSchema(() => z.strictObject({
    backendTargetKey: BackendTargetKeyV2Schema,
    reason: z.enum(['native_sign_in_required', 'native_auth_unavailable', 'account_metadata_unavailable', 'connected_default_unavailable']),
}));
export type ScmDiffSummaryCatalogUnavailableTargetV1 = z.infer<typeof ScmDiffSummaryCatalogUnavailableTargetV1Schema>;
export const ScmDiffSummaryModelCatalogObservationV1Schema = lazyZodSchema(() => z.strictObject({
    profiles: z.array(ScmDiffSummaryCatalogProfileSchema),
    automaticProfiles: z.array(ScmDiffSummaryCatalogProfileSchema),
    discoveryTargetKeys: z.array(BackendTargetKeyV2Schema),
    unavailableReason: z.optional(z.literal('account_metadata_unavailable')),
    unavailableTargets: z.optional(z.array(ScmDiffSummaryCatalogUnavailableTargetV1Schema)),
    probeFailures: z.optional(z.array(z.strictObject({ backendTargetKey: BackendTargetKeyV2Schema, spawnFailure: SpawnFailureV1Schema }))),
}));

export type ScmDiffSummarySettingsV1 = Pick<AccountSettings, 'scm.diffSummary.prefetch' | 'scm.diffSummary.modelProfileOverride'>
    & Partial<Pick<AccountSettings, 'scm.diffSummary.outputLanguage' | 'scm.diffSummary.investigateSurroundingFiles'>>;
export type ScmDiffSummaryCatalogMutationServicesV1<T extends ScmDiffSummarySettingsV1 = ScmDiffSummarySettingsV1> = Readonly<{
    readScmDiffSummaryCatalog?: (settings: T, storedValue: string, options?: Readonly<{
        includeConfigured: boolean;
        discoveryTargetKey?: string;
    }>) => Promise<Readonly<{
        profiles: readonly ScmDiffSummaryCatalogProfile[];
        automaticProfiles?: readonly ScmDiffSummaryCatalogProfile[];
        discoveryTargetKeys?: readonly string[];
        unavailableReason?: 'account_metadata_unavailable';
        unavailableTargets?: readonly ScmDiffSummaryCatalogUnavailableTargetV1[];
        probeFailures?: readonly Readonly<{ backendTargetKey: string; spawnFailure: SpawnFailureV1 }>[];
        isCurrent: (settings: T) => boolean;
    }> | null>;
}>;
export type ScmDiffSummarySettingBindingV1<T extends ScmDiffSummarySettingsV1 = ScmDiffSummarySettingsV1> = Readonly<{
    scope: 'account'; kind: 'owner'; access: 'read_write';
    read(settings: T): unknown;
    parse(value: unknown): Readonly<{ success: true; value: SettingDomainValueV1 }> | Readonly<{ success: false }>;
    mutate(settings: T, value: SettingDomainValueV1): Partial<T> | null;
    prepare(settings: T, value: SettingDomainValueV1, services: ScmDiffSummaryCatalogMutationServicesV1<T>, context?: Readonly<{ signal?: AbortSignal; isCurrent(): boolean }>): Promise<((settings: T) => Partial<T> | null) | null>;
}>;

export const SCM_DIFF_SUMMARY_SETTING_KEYS = {
    enabled: 'scm.diffSummary.enabled',
    prefetch: 'scm.diffSummary.prefetch',
    modelProfileOverride: 'scm.diffSummary.modelProfileOverride',
    outputLanguage: 'scm.diffSummary.outputLanguage',
    investigateSurroundingFiles: 'scm.diffSummary.investigateSurroundingFiles',
} as const;

export type ScmDiffSummaryCatalogProfile = Readonly<{
    catalogId: string;
    title: string;
    modelSelector?: ScmDiffSummaryModelSelector;
    structuredOutput?: CapabilitySupport;
    costTier?: ProviderModelDescriptorV1['costTier'];
}>;

export type ResolvedScmDiffSummarySettings = Readonly<{
    enabled: boolean;
    prefetch: boolean;
    investigateSurroundingFiles: boolean;
    outputLanguage: string | null;
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
    const selector = decodeScmDiffSummaryModelOverride(catalogId);
    const canonicalId = selector ? encodeScmDiffSummaryModelOverride(selector) : catalogId;
    // Catalog evidence describes the model; credential intent stays with the stored choice.
    const catalogModelId = selector ? encodeScmDiffSummaryModelOverride({ ...selector, connectedServices: undefined }) : canonicalId;
    const profile = catalogProfiles.find((profile) => profile.catalogId === canonicalId || profile.catalogId === catalogModelId);
    return profile ? { ...profile, ...(selector ? { modelSelector: selector } : {}) } : null;
}

const MODEL_SELECTOR_PREFIX = 'model:';
const StoredModelSelectionSchema = createStoredReadSchema(z.intersection(ProviderBoundModelRefSchema,
    z.object({ connectedServices: z.optional(z.nullable(ConnectedServiceBindingsV2Schema)) })));

/** The existing string preference carries the canonical selector, never a display label. */
export function encodeScmDiffSummaryModelOverride(selector: ScmDiffSummaryModelSelector): string {
    const parsed = ScmDiffSummaryModelSelectorSchema.parse(selector);
    const selection = parsed.modelSelection ?? ProviderBoundModelRefSchema.parse({ agentTargetKey: parsed.backendTargetKey,
        providerConnectionId: null, modelId: parsed.modelId ?? 'default' });
    return `${MODEL_SELECTOR_PREFIX}${JSON.stringify({ ...selection,
        ...(parsed.connectedServices !== undefined && (parsed.connectedServices !== null || selection.providerConnectionId !== null)
            ? { connectedServices: parsed.connectedServices } : {}) })}`;
}

export function decodeScmDiffSummaryModelOverride(value: string): ScmDiffSummaryModelSelector | null {
    if (!value.startsWith(MODEL_SELECTOR_PREFIX)) return null;
    try {
        const selection = StoredModelSelectionSchema.parse(JSON.parse(value.slice(MODEL_SELECTOR_PREFIX.length)));
        const { connectedServices, ...modelSelection } = selection;
        return { backendTargetKey: selection.agentTargetKey, modelId: selection.modelId, modelSelection,
            // The retained native picker value is explicit own sign-in. Null is
            // the existing run contract for native auth without Account defaults.
            ...(connectedServices !== undefined ? { connectedServices }
                : selection.providerConnectionId === null ? { connectedServices: null } : {}) };
    }
    catch { return null; }
}

/** The same admitted catalog decides the unset preference in every consumer. */
export function resolveScmDiffSummaryDefaultModelProfile(
    profiles: readonly ScmDiffSummaryCatalogProfile[],
    defaultBackendTarget?: BackendTargetRefV2 | null,
): ScmDiffSummaryCatalogProfile | null {
    const admitted = profiles.filter(profile => profile.costTier === 'low'
        && profile.structuredOutput === 'supported' && profile.modelSelector?.backendTargetKey && profile.modelSelector.modelId);
    const targetKey = defaultBackendTarget ? buildBackendTargetKeyV2(defaultBackendTarget) : null;
    return admitted.find(profile => profile.modelSelector?.backendTargetKey === targetKey) ?? admitted[0] ?? null;
}

export function resolveScmDiffSummaryModelSelection(params: Readonly<{
    storedValue: string; defaultBackendTarget?: BackendTargetRefV2 | null;
    catalogProfiles?: readonly ScmDiffSummaryCatalogProfile[];
}>): Readonly<{ success: true; backendTarget: BackendTargetRefV2; modelSelector: ScmDiffSummaryModelSelector }>
    | Readonly<{ success: false; errorCode: 'SCM_DIFF_SUMMARY_MODEL_UNAVAILABLE' | 'SCM_DIFF_SUMMARY_MODEL_UNSUPPORTED' }> {
    const resolved = resolveScmDiffSummarySettings({ storedSettings: { [SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride]: params.storedValue }, catalogProfiles: params.catalogProfiles ?? [] });
    if (resolved.modelOverrideError) return { success: false, errorCode: resolved.modelOverrideError };
    const override = resolved.modelOverride ?? (!params.storedValue.trim()
        ? resolveScmDiffSummaryDefaultModelProfile(params.catalogProfiles ?? [], params.defaultBackendTarget) : null);
    if (!override || override.structuredOutput !== 'supported') return { success: false, errorCode: 'SCM_DIFF_SUMMARY_MODEL_UNAVAILABLE' };
    const selector = override.modelSelector ?? (override.catalogId.startsWith('profile:')
        ? { profileId: override.catalogId.slice('profile:'.length) } : { backendTargetKey: override.catalogId });
    try {
        const backendTarget = selector.backendTargetKey ? readBackendTargetRefV2(parseBackendTargetKeyV2(selector.backendTargetKey)) : params.defaultBackendTarget;
        return backendTarget ? { success: true, backendTarget, modelSelector: selector } : { success: false, errorCode: 'SCM_DIFF_SUMMARY_MODEL_UNAVAILABLE' };
    } catch { return { success: false, errorCode: 'SCM_DIFF_SUMMARY_MODEL_UNAVAILABLE' }; }
}

export function resolveScmDiffSummarySettings(params: Readonly<{
    storedSettings: Readonly<Record<string, unknown>>;
    catalogProfiles: readonly ScmDiffSummaryCatalogProfile[];
    uiLocale?: string;
}>): ResolvedScmDiffSummarySettings {
    const raw = params.storedSettings[SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride];
    const value = typeof raw === 'string' ? raw.trim() : '';
    const catalogOverride = resolveModelOverride(params.storedSettings, params.catalogProfiles);
    const selector = value ? decodeScmDiffSummaryModelOverride(value) : null;
    const override: ScmDiffSummaryCatalogProfile | null = catalogOverride ?? (selector ? { catalogId: value, title: selector.modelId ?? selector.profileId ?? value, modelSelector: selector } : null);
    const unsupported = override?.structuredOutput === 'unsupported' || override?.structuredOutput === 'unknown';
    const language = [params.storedSettings[SCM_DIFF_SUMMARY_SETTING_KEYS.outputLanguage], params.uiLocale,
        params.storedSettings.preferredLanguage].map(value => ScmDiffSummaryOutputLanguageSchema.safeParse(value))
        .find(parsed => parsed.success);
    return {
        enabled: readBooleanSetting(params.storedSettings, SCM_DIFF_SUMMARY_SETTING_KEYS.enabled, true),
        prefetch: readBooleanSetting(params.storedSettings, SCM_DIFF_SUMMARY_SETTING_KEYS.prefetch, false),
        investigateSurroundingFiles: readBooleanSetting(params.storedSettings, SCM_DIFF_SUMMARY_SETTING_KEYS.investigateSurroundingFiles, false),
        outputLanguage: language?.success ? language.data : null,
        modelOverride: unsupported ? null : override,
        ...(unsupported ? { modelOverrideError: 'SCM_DIFF_SUMMARY_MODEL_UNSUPPORTED' as const }
            : value && !override ? { modelOverrideError: 'SCM_DIFF_SUMMARY_MODEL_UNAVAILABLE' as const } : {}),
    };
}

/** Settings UI and Actions admit the same catalog-backed scalar intent at the Account CAS owner. */
export function scmDiffSummarySettingBinding<T extends ScmDiffSummarySettingsV1 = ScmDiffSummarySettingsV1>(key: typeof SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride | typeof SCM_DIFF_SUMMARY_SETTING_KEYS.prefetch | typeof SCM_DIFF_SUMMARY_SETTING_KEYS.outputLanguage | typeof SCM_DIFF_SUMMARY_SETTING_KEYS.investigateSurroundingFiles): ScmDiffSummarySettingBindingV1<T> {
    return {
        scope: 'account', kind: 'owner', access: 'read_write',
        read: settings => settings[key],
        parse: value => {
            const parsed = ACCOUNT_SETTING_DEFINITIONS[key].parseMutationValue(value);
            if (!parsed.success || (typeof parsed.data !== 'string' && typeof parsed.data !== 'boolean')) return { success: false };
            if (key === SCM_DIFF_SUMMARY_SETTING_KEYS.outputLanguage && parsed.data !== ''
                && !ScmDiffSummaryOutputLanguageSchema.safeParse(parsed.data).success) return { success: false };
            return { success: true, value: parsed.data };
        },
        // Support comes from the catalog prepare phase; scalar schema alone never admits a model.
        mutate: () => null,
        prepare: async (settings, value, services, context) => {
            const parsed = ACCOUNT_SETTING_DEFINITIONS[key].parseMutationValue(value);
            if (!parsed.success || context?.signal?.aborted || context?.isCurrent() === false) return null;
            if (key === SCM_DIFF_SUMMARY_SETTING_KEYS.investigateSurroundingFiles) {
                return () => context?.signal?.aborted || context?.isCurrent() === false ? null : { [key]: parsed.data } as Partial<T>;
            }
            if (key === SCM_DIFF_SUMMARY_SETTING_KEYS.outputLanguage) {
                if (typeof parsed.data !== 'string' || (parsed.data !== '' && !ScmDiffSummaryOutputLanguageSchema.safeParse(parsed.data).success)) return null;
                return () => context?.signal?.aborted || context?.isCurrent() === false ? null : { [key]: parsed.data } as Partial<T>;
            }
            if (key === SCM_DIFF_SUMMARY_SETTING_KEYS.prefetch && value === false) {
                return () => context?.signal?.aborted || context?.isCurrent() === false ? null : { [key]: false } as Partial<T>;
            }
            if (key === SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride && value === '') {
                return () => context?.signal?.aborted || context?.isCurrent() === false ? null : { [key]: '' } as Partial<T>;
            }
            const storedValue = key === SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride
                ? String(value) : settings[SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride];
            const catalog = await services.readScmDiffSummaryCatalog?.(settings, storedValue);
            const profile = storedValue ? catalog?.profiles.find(candidate => candidate.catalogId === storedValue)
                : resolveScmDiffSummaryDefaultModelProfile(catalog?.profiles ?? []);
            if (!catalog || profile?.structuredOutput !== 'supported'
                || !resolveScmDiffSummaryModelSelection({ storedValue, catalogProfiles: catalog.profiles }).success) return null;
            return current => {
                if (context?.signal?.aborted || context?.isCurrent() === false || !catalog.isCurrent(current)
                    || (key === SCM_DIFF_SUMMARY_SETTING_KEYS.prefetch && current[SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride] !== storedValue)) return null;
                return { [key]: value } as Partial<T>;
            };
        },
    };
}
