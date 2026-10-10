import { ACCOUNT_SETTING_DEFINITIONS, resolveNewSessionWizardSectionPresentation, type AccountSettings, type NewSessionWizardSelectionSectionId } from '../../account/settings/accountSettings.js';
import type { SettingDomainValueV1 } from './settingsOwnerActions.js';
import { normalizeActionsSettingsV1, setActionApprovalOverride, type ActionSurfaceKey } from '../actionSettings.js';
import { accountNotificationStorageBinding } from './notificationPreferenceMutations.js';
import { z } from 'zod';
import { DEFAULT_AGENT_ID } from '../../agents/defaultAgent.js';
import { readDirectConnectionsEnabled, withDirectConnectionsEnabled } from '../../account/settings/peerMediationPreferencesV1.js';
import { MachineRetentionDefaultsV1Schema, updateMachineRetentionCategoryPreferenceV1, type MachineRetentionCategoryV1 } from '../../account/settings/machineRetentionDefaultsV1.js';
import { UI_FEATURE_REGISTRY, listUiFeatureToggleDefinitions, resolveUiFeatureToggleEnabled, buildUiFeatureToggleChange, buildUiFeatureExperimentsChange } from './featurePreferenceMutations.js';
import { GLASS_PRESETS, GLASS_BLUR_STEPS, readGlassMaterials, readGlassPreset, resolveGlassPresetSettingsDelta, resolveGlassIntensitySettingsDelta, resolveGlassSurfaceSettingsDelta, type GlassSurfaceGroup } from './glassPreferenceMutations.js';
import { buildKeyboardShortcutResetDelta, buildKeyboardShortcutSetDelta, buildKeyboardShortcutToggleDelta } from './keyboardPreferenceMutations.js';
import { prepareDefaultProviderStateSharingChangeV1, type ProviderStateSharingMutationServicesV1 } from './providerStateSharingMutations.js';
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
    | 'glassBlurEnabled' | 'glassBlurIntensity' | 'glassSurfaceMaterials' | 'scmCommitMessageGeneratorBackendId'
    | 'machineRetentionDefaultsV1' | 'connectedServicesProviderStateSharingSettingsV1'
    | 'keyboardShortcutDisabledCommandIdsV1' | 'keyboardShortcutOverridesV1' | 'commandPaletteEnabled'
    | 'sessionTerminalHost' | 'sessionUseTmux' | 'sessionTmuxByMachineId' | 'sessionTerminalHostByMachineId' | 'actionsSettingsV1'>;

export type PortableAccountSettingBindingV1 = Readonly<{
    scope: 'account'; kind: 'owner'; access: 'read_write' | 'read_only' | 'sensitive';
    allowedValues?: readonly (string | number | boolean | null)[];
    read: (settings: CoupledSettings) => unknown;
    parse: (value: unknown) => Readonly<{ success: true; value: SettingDomainValueV1 }> | Readonly<{ success: false }>;
    mutate: (settings: CoupledSettings, value: SettingDomainValueV1) => Partial<CoupledSettings> | null;
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
export function glassSurfaceStorageBinding(group: GlassSurfaceGroup, field: 'blur' | 'opacity'): PortableAccountSettingBindingV1 { return { ...owner,
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
    const override = machineId ? settings.sessionTmuxByMachineId?.[machineId] : undefined;
    if (override?.useTmux) return 'tmux';
    const host = machineId ? settings.sessionTerminalHostByMachineId?.[machineId] : undefined;
    if (host) return host;
    if (override) return 'none';
    return settings.sessionTerminalHost === 'legacy' ? settings.sessionUseTmux ? 'tmux' : 'none' : settings.sessionTerminalHost ?? 'none';
}
export const terminalHostStorage: PortableAccountSettingBindingV1 = { ...owner, allowedValues: ['none', 'tmux', 'zellij', 'herdr'],
    read: settings => resolveTerminalHost({ settings, machineId: null }),
    parse: value => value === 'none' || value === 'tmux' || value === 'zellij' || value === 'herdr' ? { success: true, value } : { success: false },
    mutate: (_settings, value) => value === 'none' || value === 'tmux' || value === 'zellij' || value === 'herdr' ? { sessionTerminalHost: value, sessionUseTmux: value === 'tmux' } : null,
};
const commandValueSchema = z.object({ enabled: z.boolean(), binding: z.string().trim().nullable() }).strict();
export function commandStorage(commandId: string): PortableAccountSettingBindingV1 { return { ...owner,
    read: settings => ({ enabled: !settings.keyboardShortcutDisabledCommandIdsV1.includes(commandId) && (commandId !== 'commandPalette.open' || settings.commandPaletteEnabled), binding: settings.keyboardShortcutOverridesV1[commandId]?.[0]?.binding ?? null }),
    parse: value => {
        const parsed = commandValueSchema.safeParse(value);
        if (!parsed.success || parsed.data.binding !== null && !buildKeyboardShortcutSetDelta({ commandId, binding: parsed.data.binding, disabledCommandIds: [], overrides: {} })) return { success: false };
        if (parsed.data.binding !== null && !ACCOUNT_SETTING_DEFINITIONS.keyboardShortcutOverridesV1.parseMutationValue({ [commandId]: [{ binding: parsed.data.binding }] }).success) return { success: false };
        return { success: true, value: parsed.data };
    },
    mutate: (settings, value) => {
        const parsed = commandValueSchema.safeParse(value);
        if (!parsed.success) return null;
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
        case 'glassSurfaceStorageBinding': {
            const group = (['chrome', 'sidebar', 'content', 'floating'] as const).find(group => group === args[0]);
            return group && (args[1] === 'blur' || args[1] === 'opacity') ? glassSurfaceStorageBinding(group, args[1]) : null;
        }
        case 'sourceControl.commitMessageAgent': return commitMessageAgentStorage;
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
