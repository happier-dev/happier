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
import { resolveLlmTaskRunnerV1, type LlmTaskRunnerCandidateV1, type LlmTaskRunnerUnavailableAgentV1 } from '../../llm/tasks/llmTaskRunnerSelection.js';
import { isLlmTaskRunnerAutoV1, LlmTaskRunnerChoiceV1Schema, type LlmTaskRunnerChoiceV1, type LlmTaskRunnerConfigV1 } from '../../llm/tasks/llmTaskRunnerConfigV1.js';
import { SpawnFailureV1Schema, type SpawnFailureV1 } from '../../machines/processes/spawnFailureV1.js';

/** Read-only observation of the executing machine's admitted summary candidates. */
const ScmDiffSummaryCatalogProfileSchema = lazyZodSchema(() => z.strictObject({
        catalogId: z.string(), title: z.string(),
        modelSelector: z.optional(ScmDiffSummaryModelSelectorSchema),
        structuredOutput: z.optional(z.enum(['supported', 'unsupported', 'unknown'])),
        costTier: z.optional(z.enum(['low', 'standard', 'premium'])),
        effortValues: z.optional(z.array(z.string())),
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

export type ScmDiffSummarySettingsV1 = Pick<AccountSettings, 'scm.diffSummary.prefetch' | 'scm.diffSummary.runnerV1'>
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
    /** The summary runner choice (LlmTaskRunnerChoiceV1); null is Auto. */
    runner: 'scm.diffSummary.runnerV1',
    outputLanguage: 'scm.diffSummary.outputLanguage',
    investigateSurroundingFiles: 'scm.diffSummary.investigateSurroundingFiles',
} as const;

export type ScmDiffSummaryCatalogProfile = Readonly<{
    catalogId: string;
    title: string;
    modelSelector?: ScmDiffSummaryModelSelector;
    structuredOutput?: CapabilitySupport;
    costTier?: ProviderModelDescriptorV1['costTier'];
    /** The model's own effort values, lowest first as its catalog declares them. */
    effortValues?: readonly string[];
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

/** The stored summary runner; anything but an explicit runner is Auto. */
export function readScmDiffSummaryRunnerChoice(storedSettings: Readonly<Record<string, unknown>>): LlmTaskRunnerConfigV1 | null {
    const parsed = LlmTaskRunnerChoiceV1Schema.safeParse(storedSettings[SCM_DIFF_SUMMARY_SETTING_KEYS.runner] ?? null);
    return parsed.success && !isLlmTaskRunnerAutoV1(parsed.data) ? parsed.data : null;
}

/** An explicit runner as the summary run's selector: model, connected route and effort. */
export function projectScmDiffSummaryModelSelector(runner: LlmTaskRunnerConfigV1): ScmDiffSummaryModelSelector {
    return { backendTargetKey: runner.modelSelection.agentTargetKey, modelId: runner.modelSelection.modelId, modelSelection: runner.modelSelection,
        ...(runner.connectedServices !== undefined ? { connectedServices: runner.connectedServices } : {}),
        ...(runner.sessionConfigOptionOverrides ? { sessionConfigOptionOverrides: runner.sessionConfigOptionOverrides } : {}) };
}

/** The catalog profile id an explicit runner names; '' for Auto. Catalog identity, not storage. */
export function readScmDiffSummaryRunnerCatalogId(runner: LlmTaskRunnerConfigV1 | null): string {
    return runner ? encodeScmDiffSummaryModelOverride(projectScmDiffSummaryModelSelector(runner)) : '';
}

function resolveModelOverride(
    runner: LlmTaskRunnerConfigV1 | null,
    catalogProfiles: readonly ScmDiffSummaryCatalogProfile[],
): ScmDiffSummaryCatalogProfile | null {
    if (!runner) return null;
    const selector = projectScmDiffSummaryModelSelector(runner);
    const canonicalId = encodeScmDiffSummaryModelOverride(selector);
    // Catalog evidence describes the model; credential intent stays with the stored choice.
    const catalogModelId = encodeScmDiffSummaryModelOverride({ ...selector, connectedServices: undefined });
    const profile = catalogProfiles.find((profile) => profile.catalogId === canonicalId || profile.catalogId === catalogModelId);
    return profile ? { ...profile, modelSelector: selector } : null;
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

/** The machine's automatic model catalog, as background-task runner candidates. */
export function projectLlmTaskRunnerCandidatesFromCatalog(catalog: Readonly<{
    profiles: readonly ScmDiffSummaryCatalogProfile[];
    unavailableTargets?: readonly ScmDiffSummaryCatalogUnavailableTargetV1[];
}>): Readonly<{ candidates: readonly (LlmTaskRunnerCandidateV1 & Readonly<{ profile: ScmDiffSummaryCatalogProfile }>)[];
    unavailableAgents: readonly LlmTaskRunnerUnavailableAgentV1[] }> {
    const candidates = catalog.profiles.flatMap(profile => {
        const selector = profile.modelSelector;
        if (!selector?.backendTargetKey || !selector.modelId) return [];
        return [{ profile, title: profile.title, costTier: profile.costTier, structuredOutput: profile.structuredOutput,
            ...(profile.effortValues?.length ? { effortValues: profile.effortValues } : {}),
            modelSelection: selector.modelSelection ?? { agentTargetKey: selector.backendTargetKey, providerConnectionId: null, modelId: selector.modelId },
            ...(selector.connectedServices !== undefined ? { connectedServices: selector.connectedServices } : {}) }];
    });
    const unavailableAgents = (catalog.unavailableTargets ?? []).map(target => ({ agentTargetKey: target.backendTargetKey,
        reason: UNAVAILABLE_TARGET_REASONS[target.reason] }));
    return { candidates, unavailableAgents };
}
const UNAVAILABLE_TARGET_REASONS = {
    native_sign_in_required: 'sign_in_required',
    native_auth_unavailable: 'auth_unavailable',
    account_metadata_unavailable: 'account_metadata_unavailable',
    connected_default_unavailable: 'connected_default_unavailable',
} as const satisfies Record<ScmDiffSummaryCatalogUnavailableTargetV1['reason'], LlmTaskRunnerUnavailableAgentV1['reason']>;

/** Auto for the unset preference: the background-task runner owner picks among the admitted catalog. */
export function resolveScmDiffSummaryDefaultModelProfile(
    profiles: readonly ScmDiffSummaryCatalogProfile[],
    sessionBackendTarget?: BackendTargetRefV2 | null,
): ScmDiffSummaryCatalogProfile | null {
    const { candidates } = projectLlmTaskRunnerCandidatesFromCatalog({ profiles });
    const resolved = resolveLlmTaskRunnerV1({ task: 'scm_diff_summary', choice: null, candidates,
        sessionAgentTargetKey: sessionBackendTarget ? buildBackendTargetKeyV2(sessionBackendTarget) : null });
    return resolved.ok && resolved.source === 'auto' ? resolved.candidate.profile : null;
}

export function resolveScmDiffSummaryModelSelection(params: Readonly<{
    /** The stored or per-run choice; null or Auto resolves through the task-runner owner. */
    runner: LlmTaskRunnerChoiceV1 | null; defaultBackendTarget?: BackendTargetRefV2 | null;
    catalogProfiles?: readonly ScmDiffSummaryCatalogProfile[];
}>): Readonly<{ success: true; backendTarget: BackendTargetRefV2; modelSelector: ScmDiffSummaryModelSelector }>
    | Readonly<{ success: false; errorCode: 'SCM_DIFF_SUMMARY_MODEL_UNAVAILABLE' | 'SCM_DIFF_SUMMARY_MODEL_UNSUPPORTED' }> {
    const explicit = params.runner && !isLlmTaskRunnerAutoV1(params.runner) ? params.runner : null;
    const resolved = resolveScmDiffSummarySettings({ storedSettings: { [SCM_DIFF_SUMMARY_SETTING_KEYS.runner]: explicit }, catalogProfiles: params.catalogProfiles ?? [] });
    if (resolved.modelOverrideError) return { success: false, errorCode: resolved.modelOverrideError };
    const override = resolved.modelOverride ?? (!explicit
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
    const runner = readScmDiffSummaryRunnerChoice(params.storedSettings);
    const catalogOverride = resolveModelOverride(runner, params.catalogProfiles);
    const selector = runner ? projectScmDiffSummaryModelSelector(runner) : null;
    const override: ScmDiffSummaryCatalogProfile | null = catalogOverride ?? (runner && selector
        ? { catalogId: readScmDiffSummaryRunnerCatalogId(runner), title: runner.modelSelection.modelId, modelSelector: selector } : null);
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
            : runner && !override ? { modelOverrideError: 'SCM_DIFF_SUMMARY_MODEL_UNAVAILABLE' as const } : {}),
    };
}

/** Settings UI and Actions admit the same catalog-backed intent at the Account CAS owner. */
export function scmDiffSummarySettingBinding<T extends ScmDiffSummarySettingsV1 = ScmDiffSummarySettingsV1>(key: typeof SCM_DIFF_SUMMARY_SETTING_KEYS.runner | typeof SCM_DIFF_SUMMARY_SETTING_KEYS.prefetch | typeof SCM_DIFF_SUMMARY_SETTING_KEYS.outputLanguage | typeof SCM_DIFF_SUMMARY_SETTING_KEYS.investigateSurroundingFiles): ScmDiffSummarySettingBindingV1<T> {
    const unchanged = (context?: Readonly<{ signal?: AbortSignal; isCurrent(): boolean }>) => context?.signal?.aborted || context?.isCurrent() === false;
    return {
        scope: 'account', kind: 'owner', access: 'read_write',
        read: settings => settings[key],
        parse: value => {
            const parsed = ACCOUNT_SETTING_DEFINITIONS[key].parseMutationValue(value);
            if (!parsed.success) return { success: false };
            if (key === SCM_DIFF_SUMMARY_SETTING_KEYS.runner) return { success: true, value: parsed.data as SettingDomainValueV1 };
            if (typeof parsed.data !== 'string' && typeof parsed.data !== 'boolean') return { success: false };
            if (key === SCM_DIFF_SUMMARY_SETTING_KEYS.outputLanguage && parsed.data !== ''
                && !ScmDiffSummaryOutputLanguageSchema.safeParse(parsed.data).success) return { success: false };
            return { success: true, value: parsed.data };
        },
        // Support comes from the catalog prepare phase; the schema alone never admits a model.
        mutate: () => null,
        prepare: async (settings, value, services, context) => {
            const parsed = ACCOUNT_SETTING_DEFINITIONS[key].parseMutationValue(value);
            if (!parsed.success || unchanged(context)) return null;
            if (key === SCM_DIFF_SUMMARY_SETTING_KEYS.investigateSurroundingFiles) {
                return () => unchanged(context) ? null : { [key]: parsed.data } as Partial<T>;
            }
            if (key === SCM_DIFF_SUMMARY_SETTING_KEYS.outputLanguage) {
                if (typeof parsed.data !== 'string' || (parsed.data !== '' && !ScmDiffSummaryOutputLanguageSchema.safeParse(parsed.data).success)) return null;
                return () => unchanged(context) ? null : { [key]: parsed.data } as Partial<T>;
            }
            if (key === SCM_DIFF_SUMMARY_SETTING_KEYS.prefetch && value === false) {
                return () => unchanged(context) ? null : { [key]: false } as Partial<T>;
            }
            const runner = key === SCM_DIFF_SUMMARY_SETTING_KEYS.runner
                ? readScmDiffSummaryRunnerChoice({ [key]: parsed.data }) : readScmDiffSummaryRunnerChoice(settings);
            // Auto is stored as Auto: the executing machine's owner decides at run time.
            if (key === SCM_DIFF_SUMMARY_SETTING_KEYS.runner && !runner) {
                return () => unchanged(context) ? null : { [key]: parsed.data } as Partial<T>;
            }
            const catalog = await services.readScmDiffSummaryCatalog?.(settings, readScmDiffSummaryRunnerCatalogId(runner));
            const profile = runner ? resolveModelOverride(runner, catalog?.profiles ?? [])
                : resolveScmDiffSummaryDefaultModelProfile(catalog?.profiles ?? []);
            if (!catalog || profile?.structuredOutput !== 'supported'
                || !resolveScmDiffSummaryModelSelection({ runner, catalogProfiles: catalog.profiles }).success) return null;
            const runnerId = readScmDiffSummaryRunnerCatalogId(runner);
            return current => {
                if (unchanged(context) || !catalog.isCurrent(current)
                    || (key === SCM_DIFF_SUMMARY_SETTING_KEYS.prefetch && readScmDiffSummaryRunnerCatalogId(readScmDiffSummaryRunnerChoice(current)) !== runnerId)) return null;
                return { [key]: parsed.data } as Partial<T>;
            };
        },
    };
}
