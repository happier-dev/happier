import { ACCOUNT_SETTING_DEFINITIONS, resolveNewSessionWizardSectionPresentation, type AccountSettings, type NewSessionWizardSelectionSectionId } from '../../account/settings/accountSettings.js';
import { GlassTintIntensitySchema } from '../../account/settings/glassTint.js';
import type { SettingDomainValueV1 } from './settingsOwnerActions.js';
import { normalizeActionsSettingsV1, setActionApprovalOverride, type ActionSurfaceKey } from '../actionSettings.js';
import { accountNotificationStorageBinding } from './notificationPreferenceMutations.js';
import { z } from 'zod/mini';
import { DEFAULT_AGENT_ID } from '../../agents/defaultAgent.js';
import { readDirectConnectionsEnabled, withDirectConnectionsEnabled, readMachineDirectConnectionChoice, withMachineDirectConnectionChoice } from '../../account/settings/peerMediationPreferencesV1.js';
import { MachineRetentionDefaultsV1Schema, updateMachineRetentionCategoryPreferenceV1, type MachineRetentionCategoryV1 } from '../../account/settings/machineRetentionDefaultsV1.js';
import { UI_FEATURE_REGISTRY, listUiFeatureToggleDefinitions, resolveUiFeatureToggleEnabled, buildUiFeatureToggleChange, buildUiFeatureExperimentsChange } from './featurePreferenceMutations.js';
import { GLASS_PRESETS, GLASS_BLUR_STEPS, GLASS_SURFACE_GROUPS, readGlassTintIntensity, resolveGlassTintSettingsDelta, readGlassMaterials, readGlassPreset, readGlassSurfaceMode, resolveGlassSurfaceModeSettingsDelta, resolveGlassPresetSettingsDelta, resolveGlassIntensitySettingsDelta, resolveGlassSurfaceSettingsDelta, type GlassSurfaceGroup } from './glassPreferenceMutations.js';
import { buildKeyboardShortcutResetDelta, buildKeyboardShortcutSetDelta, buildKeyboardShortcutToggleDelta } from './keyboardPreferenceMutations.js';
import { prepareDefaultProviderStateSharingChangeV1, prepareAgentProviderStateSharingChangeV1, AgentProviderStateSharingChangeV1Schema, type ProviderStateSharingMutationServicesV1 } from './providerStateSharingMutations.js';
import { BackendTargetKeyV2InputSchema } from '../../backends/targets/backendTargetRefV2.js';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import { buildScmGitRepoBackendPreferenceSettingsDelta, getFirstPartyScmBackendQualifiedId, getFirstPartyScmBackendLegacyLocalId, resolveScmGitRepoPreferredBackendId } from '../../scm/backendIdentity.js';
import { ScmDiffAreaSchema } from '../../scm/workingSnapshot.js';
export * from './featurePreferenceMutations.js';
export * from './glassPreferenceMutations.js';
export * from './keyboardPreferenceMutations.js';
export * from './providerStateSharingMutations.js';
import { THINKING_DISPLAY_CHOICES, isThinkingDisplayChoice, resolveThinkingDisplayChoice, resolveThinkingDisplayChoiceDelta,
    normalizeScmRemoteConfirmPolicy, shouldConfirmRemoteOperation, setRemoteConfirmationForKind,
    resolveQuotaGaugeWindowModes, isQuotaGaugeWindowMode, type ConnectedServiceQuotaGaugeWindowMode, readUsagePersonalPaceTarget, setUsagePersonalPaceTarget,
    SESSION_LIST_LAYOUT_CHOICES, resolveSessionListLayoutChoice, resolveSessionListLayoutSettingsDelta,
    resolveSessionListViewOptionSelectionDelta, resolveEffectiveSessionListFolderSortMode } from './accountSettingChoiceReducers.js';

type CoupledSettings = Pick<AccountSettings, 'codingPromptBehaviorV1' | 'usageLimitRecoverySettingsV1' | 'usagePacingTargetsV1'
    | 'scmRemoteConfirmPolicy' | 'attentionDeliveryPolicyV1' | 'sessionThinkingDisplayMode' | 'sessionThinkingInlinePresentation'
    | 'newSessionWizardSectionPresentationV1' | 'sessionProviderUsageGaugeWindowModes' | 'sessionProviderUsageGaugeWindowMode'
    | 'sessionListSectionModeV1' | 'sessionListActiveGroupingV1' | 'sessionListInactiveGroupingV1'
    | 'sessionListOrderingModeV1' | 'sessionFolderViewModeV1' | 'sessionListFolderSortModeV1' | 'sessionListWorkingPlacementModeV1'
    | 'peerMediationPreferencesV1' | 'favoriteProfiles' | 'experiments' | 'featureToggles'
    | 'glassBlurEnabled' | 'glassBlurIntensity' | 'glassTintIntensity' | 'glassSurfaceMaterials' | 'scmCommitMessageGeneratorBackendId'
    | 'machineRetentionDefaultsV1' | 'connectedServicesProviderStateSharingSettingsV1'
    | 'keyboardShortcutDisabledCommandIdsV1' | 'keyboardShortcutOverridesV1' | 'commandPaletteEnabled'
    | 'sessionTerminalHost' | 'sessionUseTmux' | 'sessionTmuxByMachineId' | 'sessionTerminalHostByMachineId'
    | 'sessionTmuxSessionName' | 'sessionTmuxIsolated' | 'sessionTmuxTmpDir' | 'actionsSettingsV1'
    | 'sessionDefaultPermissionModeByTargetKey' | 'backendEnabledByTargetKey' | 'backendCliSourcePreferenceByTargetKey'
    | 'scmGitRepoPreferredBackend' | 'scmGitRepoPreferredBackendQualifiedId' | 'scmDefaultDiffModeByBackend'
    | 'toolViewDetailLevelByToolName' | 'toolViewExpandedDetailLevelByToolName'
    | 'sessionIdleCompactionEnabledByTargetKey' | 'sessionIdleCompactionMinContextTokensByTargetKey' | 'sessionIdleCompactionCacheWindowOverrideMsByTargetKey'>;

export type PortableAccountSettingBindingV1 = Readonly<{
    scope: 'account'; kind: 'owner'; access: 'read_write' | 'read_only' | 'sensitive';
    allowedValues?: readonly (string | number | boolean | null)[];
    read: (settings: CoupledSettings) => unknown;
    parse: (value: unknown) => Readonly<{ success: true; value: SettingDomainValueV1 }> | Readonly<{ success: false }>;
    mutate: (settings: CoupledSettings, value: SettingDomainValueV1) => Partial<CoupledSettings> | null;
    reset?: (key: unknown) => Readonly<{ success: true; value: SettingDomainValueV1 }> | Readonly<{ success: false }>;
}>;
export type PortableAccountSettingPreparationResultV1 =
    | Readonly<{ status: 'prepared'; mutate: (settings: CoupledSettings) => Partial<CoupledSettings> | null }>
    | Readonly<{ status: 'confirmation_required'; agentIds: readonly string[] }>
    | Readonly<{ status: 'catalog_unavailable' | 'cancelled' | 'invalid_value' }>;
export type PreparedPortableAccountSettingBindingV1 = PortableAccountSettingBindingV1 & Readonly<{
    prepare: (settings: CoupledSettings, value: SettingDomainValueV1, services: ProviderStateSharingMutationServicesV1,
        context?: Readonly<{ signal?: AbortSignal; isCurrent(): boolean }>) => Promise<PortableAccountSettingPreparationResultV1>;
}>;

const boolean = (value: unknown) => typeof value === 'boolean' ? { success: true as const, value } : { success: false as const };
const owner = { scope: 'account', kind: 'owner', access: 'read_write' } as const;
export const scmGitRoutingStorage: PortableAccountSettingBindingV1 = { ...owner,
    read: settings => resolveScmGitRepoPreferredBackendId({ legacyPreference: settings.scmGitRepoPreferredBackend,
        qualifiedPreference: settings.scmGitRepoPreferredBackendQualifiedId }),
    parse: value => typeof value === 'string' && buildScmGitRepoBackendPreferenceSettingsDelta(value)
        ? { success: true, value: value.trim() } : { success: false },
    mutate: (_settings, value) => buildScmGitRepoBackendPreferenceSettingsDelta(value),
};
const ScmBackendDiffIntentSchema = z.strictObject({ backendId: z.string().check(z.trim(), z.minLength(1)), mode: ScmDiffAreaSchema });
function parseScmBackendDiffIntent(value: unknown) {
    const parsed = ScmBackendDiffIntentSchema.safeParse(value);
    if (!parsed.success) return null;
    const record = ACCOUNT_SETTING_DEFINITIONS.scmDefaultDiffModeByBackend.parseMutationValue({ [parsed.data.backendId]: parsed.data.mode });
    return record.success ? parsed.data : null;
}
/** One backend-sized intent, merged over the current Account map by the Settings CAS owner. */
export const scmBackendDefaultDiffStorage = { ...owner,
    read: (settings: Pick<AccountSettings, 'scmDefaultDiffModeByBackend'>) => settings.scmDefaultDiffModeByBackend,
    parse: (value: unknown) => { const parsed = parseScmBackendDiffIntent(value); return parsed ? { success: true as const, value: parsed } : { success: false as const }; },
    mutate: (settings: Pick<AccountSettings, 'scmDefaultDiffModeByBackend'>, value: SettingDomainValueV1) => {
        const parsed = parseScmBackendDiffIntent(value);
        if (!parsed) return null;
        const backendId = getFirstPartyScmBackendQualifiedId(parsed.backendId) ?? parsed.backendId;
        const next = { ...settings.scmDefaultDiffModeByBackend, [backendId]: parsed.mode };
        const legacyId = getFirstPartyScmBackendLegacyLocalId(backendId);
        if (legacyId) delete next[legacyId];
        return { scmDefaultDiffModeByBackend: next };
    },
} satisfies PortableAccountSettingBindingV1;
const ToolDetailOverrideIntentSchema = z.strictObject({ toolName: z.string(), detailLevel: z.string() });
/** A single tool choice is merged into the latest map by the existing Account CAS owner. */
export function toolDetailOverrideStorage(kind: 'collapsed' | 'expanded'): PortableAccountSettingBindingV1 {
    const key = kind === 'collapsed' ? 'toolViewDetailLevelByToolName' : 'toolViewExpandedDetailLevelByToolName';
    function parse(value: unknown) {
        const intent = ToolDetailOverrideIntentSchema.safeParse(value);
        if (!intent.success) return null;
        // The Account's map schema owns both actual tool-key admission and each detail-level enum.
        // Clearing an override still validates its key using a detail level supported by both maps.
        const detailLevel = intent.data.detailLevel === 'default' ? 'summary' : intent.data.detailLevel;
        const record = ACCOUNT_SETTING_DEFINITIONS[key].parseMutationValue({ [intent.data.toolName]: detailLevel });
        if (!record.success || record.data === null || typeof record.data !== 'object' || Array.isArray(record.data)
            || !Object.entries(record.data).some(([toolName, value]: [string, unknown]) =>
                toolName === intent.data.toolName && value === detailLevel)) return null;
        return intent.data;
    }
    return { ...owner,
        read: settings => settings[key],
        parse: value => { const intent = parse(value); return intent ? { success: true, value: intent } : { success: false }; },
        mutate: (settings, value) => {
            const intent = parse(value);
            if (!intent) return null;
            const next: Record<string, string> = { ...settings[key] };
            if (intent.detailLevel === 'default') delete next[intent.toolName];
            else next[intent.toolName] = intent.detailLevel;
            const record = ACCOUNT_SETTING_DEFINITIONS[key].parseMutationValue(next);
            return record.success ? { [key]: record.data } : null;
        },
    };
}
type AgentPreferenceKey = 'sessionDefaultPermissionModeByTargetKey' | 'backendEnabledByTargetKey' | 'backendCliSourcePreferenceByTargetKey'
    | 'sessionIdleCompactionEnabledByTargetKey' | 'sessionIdleCompactionMinContextTokensByTargetKey' | 'sessionIdleCompactionCacheWindowOverrideMsByTargetKey';
const AgentPreferenceIntentSchema = z.strictObject({ agentTargetKey: BackendTargetKeyV2InputSchema, value: StrictJsonValueSchema });
/** One target-sized intent, revalidated and rebased by the existing Settings CAS owner. */
function agentPreferenceStorage(key: AgentPreferenceKey): PortableAccountSettingBindingV1 {
    function parse(value: unknown) {
        const intent = AgentPreferenceIntentSchema.safeParse(value);
        if (!intent.success) return null;
        if (intent.data.value === null) return { intent: intent.data, record: null };
        const record = ACCOUNT_SETTING_DEFINITIONS[key].parseMutationValue({ [intent.data.agentTargetKey]: intent.data.value });
        return record.success && record.data !== null && typeof record.data === 'object' && !Array.isArray(record.data)
            && Object.entries(record.data).some(([target, value]) => target === intent.data.agentTargetKey && value === intent.data.value)
            ? { intent: intent.data, record: { [intent.data.agentTargetKey]: intent.data.value } } : null;
    }
    return { ...owner, read: settings => settings[key],
        parse: value => { const admitted = parse(value); return admitted ? { success: true, value: admitted.intent } : { success: false }; },
        reset: key => { const target = BackendTargetKeyV2InputSchema.safeParse(key); return target.success
            ? { success: true, value: { agentTargetKey: target.data, value: null } } : { success: false }; },
        mutate: (settings, value) => {
            const admitted = parse(value);
            if (!admitted) return null;
            const next = { ...settings[key], ...admitted.record };
            if (admitted.record === null) delete next[admitted.intent.agentTargetKey];
            return { [key]: next };
        },
    };
}
export const agentDefaultPermissionStorage = agentPreferenceStorage('sessionDefaultPermissionModeByTargetKey');
export const agentEnabledStorage = agentPreferenceStorage('backendEnabledByTargetKey');
export const agentExecutableSourceStorage = agentPreferenceStorage('backendCliSourcePreferenceByTargetKey');
export const agentIdleCompactionStorage = agentPreferenceStorage('sessionIdleCompactionEnabledByTargetKey');
export const agentIdleCompactionMinContextTokensStorage = agentPreferenceStorage('sessionIdleCompactionMinContextTokensByTargetKey');
export const agentIdleCompactionCacheWindowOverrideMsStorage = agentPreferenceStorage('sessionIdleCompactionCacheWindowOverrideMsByTargetKey');
export const sharingPerAgentStorage: PreparedPortableAccountSettingBindingV1 = { ...owner,
    read: settings => settings.connectedServicesProviderStateSharingSettingsV1.byAgentId,
    parse: value => { const parsed = AgentProviderStateSharingChangeV1Schema.safeParse(value);
        return parsed.success ? { success: true, value: parsed.data } : { success: false }; },
    mutate: () => null,
    prepare: async (settings, value, services, context) => {
        const parsed = AgentProviderStateSharingChangeV1Schema.safeParse(value);
        if (!parsed.success) return { status: 'invalid_value' };
        if (context?.signal?.aborted || context?.isCurrent() === false) return { status: 'cancelled' };
        const prepared = await prepareAgentProviderStateSharingChangeV1(settings.connectedServicesProviderStateSharingSettingsV1, parsed.data, services);
        if (prepared.status !== 'prepared') return prepared;
        if (context?.signal?.aborted || context?.isCurrent() === false) return { status: 'cancelled' };
        return { status: 'prepared', mutate: current => {
            if (context?.signal?.aborted || context?.isCurrent() === false) return null;
            const next = prepared.mutate(current.connectedServicesProviderStateSharingSettingsV1);
            return next ? { connectedServicesProviderStateSharingSettingsV1: next } : null;
        } };
    },
};
const instructionsAgentEditsModes = ['off', 'default', 'ask_first', 'allowed'] as const;
function isInstructionsAgentEditsMode(value: unknown): value is typeof instructionsAgentEditsModes[number] {
    return value === 'off' || value === 'default' || value === 'ask_first' || value === 'allowed';
}
/** A scalar intent over one policy surface, rebased by the Account settings owner. */
export const instructionsAgentEditsStorage: PortableAccountSettingBindingV1 = { ...owner, allowedValues: instructionsAgentEditsModes,
    read: settings => {
        const policy = normalizeActionsSettingsV1(settings.actionsSettingsV1);
        const entry = policy.actions['prompt_doc.update'];
        if (entry?.disabledSurfaces.includes('agent')) return 'off';
        if (entry?.approvalRequiredSurfaces.includes('agent')) return 'ask_first';
        return policy.approvalWaivedSurfaces?.['prompt_doc.update']?.includes('agent') ? 'allowed' : 'default';
    },
    parse: value => isInstructionsAgentEditsMode(value) ? { success: true, value } : { success: false },
    mutate: (settings, value) => {
        if (!isInstructionsAgentEditsMode(value)) return null;
        const policy = normalizeActionsSettingsV1(settings.actionsSettingsV1);
        const prior = policy.actions['prompt_doc.update'];
        const disabledSurfaces: ActionSurfaceKey[] = prior?.disabledSurfaces.filter(surface => surface !== 'agent') ?? [];
        if (value === 'off') disabledSurfaces.push('agent');
        const selected = normalizeActionsSettingsV1({ ...policy, actions: { ...policy.actions,
            'prompt_doc.update': { ...prior, disabledSurfaces },
        } });
        return { actionsSettingsV1: setActionApprovalOverride({ settings: selected,
            actionId: 'prompt_doc.update', surface: 'agent',
            approvalRequired: value === 'ask_first' ? true : value === 'allowed' ? false : null,
        }) };
    },
};
export const directConnectionsStorage: PortableAccountSettingBindingV1 = { ...owner,
    read: settings => readDirectConnectionsEnabled(settings.peerMediationPreferencesV1), parse: boolean,
    mutate: (settings, value) => typeof value === 'boolean' ? { peerMediationPreferencesV1: withDirectConnectionsEnabled(settings.peerMediationPreferencesV1, value) } : null,
};
/** The keyed Action and the Machine row share the existing peer-preference mutation and Account CAS. */
const MachineDirectConnectionKeySchema = z.string().check(z.trim(), z.minLength(1), z.refine(value => value !== '__proto__'));
const MachineDirectConnectionChoiceSchema = z.enum(['default', 'direct', 'relay']);
export const machineDirectConnectionStorage = {
    scope: 'account', kind: 'machineDirectConnection', access: 'read_write',
    allowedValues: ['default', 'direct', 'relay'],
    key: MachineDirectConnectionKeySchema,
    value: MachineDirectConnectionChoiceSchema,
    read: (settings: Pick<AccountSettings, 'peerMediationPreferencesV1'>, machineId: string) =>
        readMachineDirectConnectionChoice(settings.peerMediationPreferencesV1, machineId),
    mutate: (settings: Pick<AccountSettings, 'peerMediationPreferencesV1'>, machineId: string, value: unknown) => {
        const key = MachineDirectConnectionKeySchema.safeParse(machineId);
        const choice = MachineDirectConnectionChoiceSchema.safeParse(value);
        if (!key.success || !choice.success) return null;
        return { peerMediationPreferencesV1: withMachineDirectConnectionChoice(settings.peerMediationPreferencesV1, key.data, choice.data) };
    },
} as const;
export const defaultEnvironmentShowFirstStorage: PortableAccountSettingBindingV1 = { ...owner,
    read: settings => settings.favoriteProfiles.includes(''), parse: boolean,
    mutate: (settings, value) => typeof value === 'boolean' ? { favoriteProfiles: value
        ? [...settings.favoriteProfiles.filter(id => id !== ''), ''] : settings.favoriteProfiles.filter(id => id !== '') } : null,
};
export function featureToggleStorage(featureId: keyof typeof UI_FEATURE_REGISTRY): PortableAccountSettingBindingV1 { return { ...owner,
    read: settings => resolveUiFeatureToggleEnabled(settings, featureId), parse: boolean,
    mutate: (settings, value) => typeof value === 'boolean' ? buildUiFeatureToggleChange(settings, featureId, value) : null,
}; }
export const experimentalFeaturesStorage: PortableAccountSettingBindingV1 = { ...owner,
    read: settings => settings.experiments, parse: boolean,
    mutate: (settings, value) => typeof value === 'boolean' ? buildUiFeatureExperimentsChange(settings, value) : null,
};
export const glassPresetStorageBinding: PortableAccountSettingBindingV1 = { ...owner, allowedValues: GLASS_PRESETS,
    read: readGlassPreset,
    parse: value => GLASS_PRESETS.some(preset => preset === value) && typeof value === 'string' ? { success: true, value } : { success: false },
    mutate: (settings, value) => { const preset = GLASS_PRESETS.find(preset => preset === value); return preset ? resolveGlassPresetSettingsDelta(settings, preset) : null; },
};
export const glassIntensityStorageBinding: PortableAccountSettingBindingV1 = { ...owner, allowedValues: ['light', 'regular', 'strong'],
    read: settings => settings.glassBlurIntensity ?? 'regular',
    parse: value => value === 'light' || value === 'regular' || value === 'strong' ? { success: true, value } : { success: false },
    mutate: (settings, value) => value === 'light' || value === 'regular' || value === 'strong' ? resolveGlassIntensitySettingsDelta(settings, value) : null,
};
export const glassTintStorageBinding: PortableAccountSettingBindingV1 = { ...owner,
    read: settings => readGlassTintIntensity(settings.glassTintIntensity),
    parse: value => {
        const parsed = GlassTintIntensitySchema.safeParse(value);
        return parsed.success ? { success: true, value: parsed.data } : { success: false };
    },
    mutate: (settings, value) => {
        const parsed = GlassTintIntensitySchema.safeParse(value);
        return parsed.success ? resolveGlassTintSettingsDelta(settings, parsed.data) : null;
    },
};
export function glassSurfaceStorageBinding(group: GlassSurfaceGroup, field: 'blur' | 'opacity' | 'mode'): PortableAccountSettingBindingV1 {
    if (field === 'mode') return { ...owner, allowedValues: ['glass', 'solid'],
        read: settings => readGlassSurfaceMode(settings, group),
        parse: value => value === 'glass' || value === 'solid' ? { success: true, value } : { success: false },
        mutate: (settings, value) => value === 'glass' || value === 'solid' ? resolveGlassSurfaceModeSettingsDelta(settings, group, value) : null,
    };
    return { ...owner,
    ...(field === 'blur' ? { allowedValues: GLASS_BLUR_STEPS } : {}),
    read: settings => readGlassMaterials(settings)[group][field],
    parse: value => field === 'opacity'
        ? typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? { success: true, value } : { success: false }
        : value === 'off' || value === 'light' || value === 'regular' || value === 'strong' ? { success: true, value } : { success: false },
    mutate: (settings, value) => field === 'opacity'
        ? typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? resolveGlassSurfaceSettingsDelta(settings, group, { opacity: value }) : null
        : value === 'off' || value === 'light' || value === 'regular' || value === 'strong' ? resolveGlassSurfaceSettingsDelta(settings, group, { blur: value }) : null,
}; }
function parseCommitMessageAgent(value: unknown) {
    if (typeof value !== 'string' || !value.trim()) return { success: false as const };
    const parsed = ACCOUNT_SETTING_DEFINITIONS.scmCommitMessageGeneratorBackendId.parseMutationValue(value.trim());
    return parsed.success && typeof parsed.data === 'string' ? { success: true as const, value: parsed.data } : { success: false as const };
}
export const commitMessageAgentStorage: PortableAccountSettingBindingV1 = { ...owner,
    read: settings => settings.scmCommitMessageGeneratorBackendId.trim() || DEFAULT_AGENT_ID,
    parse: parseCommitMessageAgent,
    mutate: (_settings, value) => { const parsed = parseCommitMessageAgent(value); return parsed.success ? { scmCommitMessageGeneratorBackendId: parsed.value } : null; },
};
export const sharingConfigStorage: PortableAccountSettingBindingV1 = { ...owner,
    read: settings => settings.connectedServicesProviderStateSharingSettingsV1.defaults.configMode,
    parse: value => value === 'linked' || value === 'copied' || value === 'isolated' ? { success: true, value } : { success: false },
    mutate: (settings, value) => value === 'linked' || value === 'copied' || value === 'isolated' ? {
        connectedServicesProviderStateSharingSettingsV1: { ...settings.connectedServicesProviderStateSharingSettingsV1,
            defaults: { ...settings.connectedServicesProviderStateSharingSettingsV1.defaults, configMode: value } },
    } : null,
};
/** Shared-state admission remains the catalog-backed consent owner's responsibility. */
export const sharingStateStorage: PreparedPortableAccountSettingBindingV1 = { ...owner,
    read: settings => settings.connectedServicesProviderStateSharingSettingsV1.defaults.stateMode === 'shared', parse: boolean,
    mutate: () => null,
    prepare: async (settings, value, services, context) => {
        if (typeof value !== 'boolean') return { status: 'invalid_value' };
        if (context?.signal?.aborted || context?.isCurrent() === false) return { status: 'cancelled' };
        const prepared = await prepareDefaultProviderStateSharingChangeV1(settings.connectedServicesProviderStateSharingSettingsV1, value, services);
        if (prepared.status !== 'prepared') return prepared;
        if (context?.signal?.aborted || context?.isCurrent() === false) return { status: 'cancelled' };
        return { status: 'prepared', mutate: current => {
            if (context?.signal?.aborted || context?.isCurrent() === false) return null;
            const next = prepared.mutate(current.connectedServicesProviderStateSharingSettingsV1);
            return next ? { connectedServicesProviderStateSharingSettingsV1: next } : null;
        } };
    },
};
export function categoryBinding(category: MachineRetentionCategoryV1): PortableAccountSettingBindingV1 { return { ...owner,
    read: settings => settings.machineRetentionDefaultsV1[category] ?? null,
    parse: value => {
        if (value === null) return { success: true, value };
        const parsed = MachineRetentionDefaultsV1Schema.safeParse({ v: 1, [category]: value });
        const policy = parsed.success ? parsed.data[category] : undefined;
        return policy ? { success: true, value: policy } : { success: false };
    },
    mutate: (settings, value) => {
        if (value === null) return { machineRetentionDefaultsV1: updateMachineRetentionCategoryPreferenceV1(settings.machineRetentionDefaultsV1, category, null) };
        const parsed = MachineRetentionDefaultsV1Schema.safeParse({ v: 1, [category]: value });
        const policy = parsed.success ? parsed.data[category] : undefined;
        return policy ? { machineRetentionDefaultsV1: updateMachineRetentionCategoryPreferenceV1(settings.machineRetentionDefaultsV1, category, policy) } : null;
    },
}; }
export function resolveTerminalHost(params: { settings: Pick<CoupledSettings, 'sessionTerminalHost' | 'sessionUseTmux' | 'sessionTmuxByMachineId' | 'sessionTerminalHostByMachineId'>; machineId: string | null }): 'none' | 'tmux' | 'zellij' | 'herdr' {
    const { settings, machineId } = params;
    const override = machineId && settings.sessionTmuxByMachineId && Object.hasOwn(settings.sessionTmuxByMachineId, machineId)
        ? settings.sessionTmuxByMachineId[machineId] : undefined;
    if (override?.useTmux) return 'tmux';
    const host = machineId && settings.sessionTerminalHostByMachineId && Object.hasOwn(settings.sessionTerminalHostByMachineId, machineId)
        ? settings.sessionTerminalHostByMachineId[machineId] : undefined;
    if (host) return host;
    if (override) return 'none';
    return settings.sessionTerminalHost === 'legacy' ? settings.sessionUseTmux ? 'tmux' : 'none' : settings.sessionTerminalHost ?? 'none';
}
export type MachineTerminalHost = 'none' | 'tmux' | 'zellij' | 'herdr';
export type MachineTerminalHostSettingChange = Readonly<{
    host?: MachineTerminalHost | null;
    tmux?: Readonly<Partial<NonNullable<CoupledSettings['sessionTmuxByMachineId'][string]>>>;
}>;
/** A sparse per-machine intent, rebased by the existing Account Settings CAS writer. */
export function buildMachineTerminalSettingsPatch(params: Readonly<{
    settings: Pick<CoupledSettings, 'sessionTmuxByMachineId' | 'sessionTerminalHostByMachineId' | 'sessionTmuxSessionName' | 'sessionTmuxIsolated' | 'sessionTmuxTmpDir'>;
    machineId: string;
    change: MachineTerminalHostSettingChange;
}>): Pick<CoupledSettings, 'sessionTmuxByMachineId' | 'sessionTerminalHostByMachineId'> {
    const { settings, machineId, change } = params;
    let tmuxByMachineId = { ...settings.sessionTmuxByMachineId };
    let hostByMachineId = { ...settings.sessionTerminalHostByMachineId };
    if (change.host !== undefined) {
        delete hostByMachineId[machineId];
        if (change.host === null) {
            delete tmuxByMachineId[machineId];
        } else {
            const prior = (Object.hasOwn(tmuxByMachineId, machineId) ? tmuxByMachineId[machineId] : undefined) ?? {
                sessionName: settings.sessionTmuxSessionName,
                isolated: settings.sessionTmuxIsolated,
                tmpDir: settings.sessionTmuxTmpDir,
            };
            tmuxByMachineId = { ...tmuxByMachineId, [machineId]: {
                ...prior,
                useTmux: change.host === 'tmux',
            } };
            if (change.host === 'herdr' || change.host === 'zellij') hostByMachineId = { ...hostByMachineId, [machineId]: change.host };
        }
    }
    if (change.tmux) {
        const prior = (Object.hasOwn(tmuxByMachineId, machineId) ? tmuxByMachineId[machineId] : undefined) ?? {
            useTmux: false,
            sessionName: settings.sessionTmuxSessionName,
            isolated: settings.sessionTmuxIsolated,
            tmpDir: settings.sessionTmuxTmpDir,
        };
        tmuxByMachineId = { ...tmuxByMachineId, [machineId]: { ...prior, ...change.tmux } };
    }
    return { sessionTmuxByMachineId: tmuxByMachineId, sessionTerminalHostByMachineId: hostByMachineId };
}
export const terminalHostStorage: PortableAccountSettingBindingV1 = { ...owner, allowedValues: ['none', 'tmux', 'zellij', 'herdr'],
    read: settings => resolveTerminalHost({ settings, machineId: null }),
    parse: value => value === 'none' || value === 'tmux' || value === 'zellij' || value === 'herdr' ? { success: true, value } : { success: false },
    mutate: (_settings, value) => value === 'none' || value === 'tmux' || value === 'zellij' || value === 'herdr' ? { sessionTerminalHost: value, sessionUseTmux: value === 'tmux' } : null,
};
const commandValueSchema = z.strictObject({ enabled: z.boolean(), binding: z.optional(z.nullable(z.string().check(z.trim()))) });
export function commandStorage(commandId: string): PortableAccountSettingBindingV1 { return { ...owner,
    read: settings => ({ enabled: !settings.keyboardShortcutDisabledCommandIdsV1.includes(commandId) && (commandId !== 'commandPalette.open' || settings.commandPaletteEnabled), binding: settings.keyboardShortcutOverridesV1[commandId]?.[0]?.binding ?? null }),
    parse: (value): ReturnType<PortableAccountSettingBindingV1['parse']> => {
        const parsed = commandValueSchema.safeParse(value);
        if (!parsed.success || parsed.data.binding != null && !buildKeyboardShortcutSetDelta({ commandId, binding: parsed.data.binding, disabledCommandIds: [], overrides: {} })) return { success: false };
        if (parsed.data.binding != null && !ACCOUNT_SETTING_DEFINITIONS.keyboardShortcutOverridesV1.parseMutationValue({ [commandId]: [{ binding: parsed.data.binding }] }).success) return { success: false };
        return { success: true, value: parsed.data.binding === undefined
            ? { enabled: parsed.data.enabled } : { enabled: parsed.data.enabled, binding: parsed.data.binding } };
    },
    mutate: (settings, value) => {
        const parsed = commandValueSchema.safeParse(value);
        if (!parsed.success) return null;
        // An enabled-only intent preserves every platform-qualified override rule.
        if (parsed.data.binding === undefined) return buildKeyboardShortcutToggleDelta(settings.keyboardShortcutDisabledCommandIdsV1, commandId, !parsed.data.enabled);
        const current = { commandId, disabledCommandIds: settings.keyboardShortcutDisabledCommandIdsV1, overrides: settings.keyboardShortcutOverridesV1 };
        const bindingDelta = parsed.data.binding === null ? buildKeyboardShortcutResetDelta(current) : buildKeyboardShortcutSetDelta({ ...current, binding: parsed.data.binding });
        if (bindingDelta && !ACCOUNT_SETTING_DEFINITIONS.keyboardShortcutOverridesV1.parseMutationValue(bindingDelta.keyboardShortcutOverridesV1).success) return null;
        return bindingDelta ? { ...bindingDelta, ...buildKeyboardShortcutToggleDelta(bindingDelta.keyboardShortcutDisabledCommandIdsV1, commandId, !parsed.data.enabled) } : null;
    },
}; }

export const responseOptionsStorage: PortableAccountSettingBindingV1 = { ...owner,
    read: settings => settings.codingPromptBehaviorV1.responseOptions === 'agent', parse: boolean,
    mutate: (settings, value) => typeof value === 'boolean' ? { codingPromptBehaviorV1: { ...settings.codingPromptBehaviorV1, responseOptions: value ? 'agent' : 'disabled' } } : null,
};
export const autoWaitStorage: PortableAccountSettingBindingV1 = { ...owner,
    read: settings => settings.usageLimitRecoverySettingsV1.mode === 'auto_wait', parse: boolean,
    mutate: (settings, value) => typeof value === 'boolean' ? { usageLimitRecoverySettingsV1: { ...settings.usageLimitRecoverySettingsV1, mode: value ? 'auto_wait' : 'ask' } } : null,
};
export const personalPaceTargetStorage: PortableAccountSettingBindingV1 = { ...owner,
    read: settings => readUsagePersonalPaceTarget(settings.usagePacingTargetsV1),
    parse: value => value === null || typeof value === 'number' && Number.isFinite(value) && value >= 0 ? { success: true, value } : { success: false },
    mutate: (settings, value) => value === null || typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? { usagePacingTargetsV1: setUsagePersonalPaceTarget(settings.usagePacingTargetsV1, value) } : null,
};
export function remoteConfirmationStorage(kind: 'pull' | 'push'): PortableAccountSettingBindingV1 { return { ...owner,
    read: settings => shouldConfirmRemoteOperation(normalizeScmRemoteConfirmPolicy(settings.scmRemoteConfirmPolicy), kind), parse: boolean,
    mutate: (settings, value) => typeof value === 'boolean' ? { scmRemoteConfirmPolicy: setRemoteConfirmationForKind(normalizeScmRemoteConfirmPolicy(settings.scmRemoteConfirmPolicy), kind, value) } : null,
}; }
export function presentationStorage(sectionId: NewSessionWizardSelectionSectionId): PortableAccountSettingBindingV1 { return { ...owner,
    read: settings => resolveNewSessionWizardSectionPresentation(settings.newSessionWizardSectionPresentationV1, sectionId),
    parse: value => value === 'auto' || value === 'list' || value === 'dropdown' ? { success: true, value } : { success: false },
    mutate: (settings, value) => {
        if (value !== 'auto' && value !== 'list' && value !== 'dropdown') return null;
        const next = { ...settings.newSessionWizardSectionPresentationV1 };
        if (value === 'auto') delete next[sectionId]; else next[sectionId] = value;
        return { newSessionWizardSectionPresentationV1: next };
    },
}; }
export const thinkingDisplayStorageBinding: PortableAccountSettingBindingV1 = { ...owner, allowedValues: THINKING_DISPLAY_CHOICES,
    read: resolveThinkingDisplayChoice,
    parse: value => isThinkingDisplayChoice(value) ? { success: true, value } : { success: false },
    mutate: (_settings, value) => isThinkingDisplayChoice(value) ? resolveThinkingDisplayChoiceDelta(value) : null,
};
function isGaugeWindowModes(value: unknown): value is ConnectedServiceQuotaGaugeWindowMode[] {
    return Array.isArray(value) && value.every((mode: unknown) => typeof mode === 'string' && isQuotaGaugeWindowMode(mode));
}
export const gaugeWindowStorage: PortableAccountSettingBindingV1 = { ...owner,
    read: settings => resolveQuotaGaugeWindowModes(settings.sessionProviderUsageGaugeWindowModes, settings.sessionProviderUsageGaugeWindowMode),
    parse: value => {
        const parsed = ACCOUNT_SETTING_DEFINITIONS.sessionProviderUsageGaugeWindowModes.parseMutationValue(value);
        return parsed.success && isGaugeWindowModes(parsed.data) ? { success: true, value: resolveQuotaGaugeWindowModes(parsed.data) } : { success: false };
    },
    mutate: (_settings, value) => {
        const parsed = ACCOUNT_SETTING_DEFINITIONS.sessionProviderUsageGaugeWindowModes.parseMutationValue(value);
        return parsed.success && (parsed.data === null || isGaugeWindowModes(parsed.data)) ? { sessionProviderUsageGaugeWindowModes: parsed.data } : null;
    },
};
export const sessionListLayoutStorageBinding: PortableAccountSettingBindingV1 = { ...owner, allowedValues: SESSION_LIST_LAYOUT_CHOICES,
    read: resolveSessionListLayoutChoice,
    parse: value => typeof value === 'string' && SESSION_LIST_LAYOUT_CHOICES.some(choice => choice === value) ? { success: true, value } : { success: false },
    mutate: (settings, value) => value === 'projects' || value === 'recent_activity' || value === 'active_inactive' ? resolveSessionListLayoutSettingsDelta(value, settings) : null,
};
type ListChoiceKey = 'sessionListOrderingModeV1' | 'sessionFolderViewModeV1' | 'sessionListFolderSortModeV1' | 'sessionListActiveGroupingV1' | 'sessionListInactiveGroupingV1' | 'sessionListWorkingPlacementModeV1';
export function listChoiceStorage(key: ListChoiceKey, prefix: string): PortableAccountSettingBindingV1 { return { ...owner,
    read: settings => key === 'sessionListFolderSortModeV1' ? resolveEffectiveSessionListFolderSortMode({ orderingMode: settings.sessionListOrderingModeV1, folderSortMode: settings.sessionListFolderSortModeV1 }) : settings[key],
    parse: value => {
        const parsed = ACCOUNT_SETTING_DEFINITIONS[key].parseMutationValue(value);
        return parsed.success && typeof parsed.data === 'string' ? { success: true, value: parsed.data } : { success: false };
    },
    mutate: (settings, value) => typeof value === 'string' ? resolveSessionListViewOptionSelectionDelta(`${prefix}:${value}`, settings) : null,
}; }

export function readPortableAccountSettingBindingV1(declaration: Readonly<{
    storage?: Readonly<{ owner?: string; options?: unknown; key?: string }>;
}>): PortableAccountSettingBindingV1 | PreparedPortableAccountSettingBindingV1 | null {
    const storage = declaration.storage;
    const args: readonly unknown[] = Array.isArray(storage?.options) ? storage.options : [];
    switch (storage?.owner) {
        case 'instructionsAgentEditsStorage': return instructionsAgentEditsStorage;
        case 'account.directConnections': return directConnectionsStorage;
        case 'profiles.defaultEnvironment.showFirst': return defaultEnvironmentShowFirstStorage;
        case 'features.experimentalFeatures': return experimentalFeaturesStorage;
        case 'featureToggle': {
            const definition = listUiFeatureToggleDefinitions().find(definition => definition.featureId === args[0]);
            return definition ? featureToggleStorage(definition.featureId) : null;
        }
        case 'glassPresetStorageBinding': return glassPresetStorageBinding;
        case 'glassIntensityStorageBinding': return glassIntensityStorageBinding;
        case 'glassTintStorageBinding': return glassTintStorageBinding;
        case 'glassSurfaceStorageBinding': {
            const group = GLASS_SURFACE_GROUPS.find(group => group === args[0]);
            return group && (args[1] === 'blur' || args[1] === 'opacity' || args[1] === 'mode') ? glassSurfaceStorageBinding(group, args[1]) : null;
        }
        case 'sourceControl.commitMessageAgent': return commitMessageAgentStorage;
        case 'agents.defaultPermission': return agentDefaultPermissionStorage;
        case 'agents.idleCompaction': return agentIdleCompactionStorage;
        case 'agents.idleCompaction.minContextTokens': return agentIdleCompactionMinContextTokensStorage;
        case 'agents.idleCompaction.cacheWindowOverrideMs': return agentIdleCompactionCacheWindowOverrideMsStorage;
        case 'agents.enabled': return agentEnabledStorage;
        case 'agents.executableSource': return agentExecutableSourceStorage;
        case 'connectedServicesAgentSignIn.sharingPerAgent': return sharingPerAgentStorage;
        case 'connectedServicesAgentSignIn.sharingConfig': return sharingConfigStorage;
        case 'connectedServicesAgentSignIn.sharingState': return sharingStateStorage;
        case 'terminalHostStorage': return terminalHostStorage;
        case 'categoryBinding': {
            const category = (['local', 'running-only', 'stopped-billed', 'unknown'] as const).find(category => category === args[0]);
            return category ? categoryBinding(category) : null;
        }
        case 'commandStorage': return typeof args[0] === 'string' && args[0] ? commandStorage(args[0]) : null;
        case 'responseOptionsStorage': return responseOptionsStorage;
        case 'autoWaitStorage': return autoWaitStorage;
        case 'personalPaceTargetStorage': return personalPaceTargetStorage;
        case 'thinkingDisplayStorageBinding': return thinkingDisplayStorageBinding;
        case 'gaugeWindowStorage': return gaugeWindowStorage;
        case 'sessionListLayoutStorageBinding': return sessionListLayoutStorageBinding;
        case 'accountNotificationStorageBinding': {
            const id = (['ready', 'permission_request', 'user_action_request', 'follow_update', 'connected_service_account_switch',
                'connected_service_quota_blocked', 'connected_service_quota_recovered', 'pushEnabled', 'mutePhoneWhenComputerFocused',
                'readyPreview', 'requestPreview', 'soundPreset', 'quietHours'] as const).find(key => key === args[0]);
            return id ? accountNotificationStorageBinding(id) : null;
        }
        case 'scmGitRoutingStorage': return scmGitRoutingStorage;
        case 'scmBackendDefaultDiffStorage': return scmBackendDefaultDiffStorage;
        case 'toolDetailOverrideStorage': return args[0] === 'collapsed' || args[0] === 'expanded' ? toolDetailOverrideStorage(args[0]) : null;
        case 'remoteConfirmationStorage': return args[0] === 'pull' || args[0] === 'push' ? remoteConfirmationStorage(args[0]) : null;
        case 'presentationStorage': {
            const section = (['profiles', 'backends', 'models', 'machines', 'paths', 'permissions'] as const).find(key => key === args[0]);
            return section ? presentationStorage(section) : null;
        }
        case 'listChoiceStorage': {
            const key = (['sessionListOrderingModeV1', 'sessionFolderViewModeV1', 'sessionListFolderSortModeV1', 'sessionListActiveGroupingV1', 'sessionListInactiveGroupingV1', 'sessionListWorkingPlacementModeV1'] as const).find(key => key === args[0]);
            return key && typeof args[1] === 'string' ? listChoiceStorage(key, args[1]) : null;
        }
        default: return null;
    }
}
