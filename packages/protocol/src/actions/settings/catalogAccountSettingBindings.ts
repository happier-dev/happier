import type { PortableSettingDeclarationV1 } from './settingsDeclarations.js';
import type { SettingDomainValueV1 } from './settingsOwnerActions.js';
import { scmDiffSummarySettingBinding, SCM_DIFF_SUMMARY_SETTING_KEYS, type ScmDiffSummarySettingsV1,
    type ScmDiffSummaryCatalogMutationServicesV1 } from './scmDiffSummarySettings.js';
import { createVoiceSettingBindingsV1, type VoiceSettingsMutationServicesV1 } from '../../voice/settings/voiceSettingBindings.js';
import type { VoiceSettingsOwner, VoiceSettings } from '../../voice/settings/voiceSettings.js';
import type { VoiceSettingsRegistry } from '../../voice/settings/providerRegistry.js';

export const PORTABLE_SETTING_VALUE_UNAVAILABLE = Symbol('setting_value_unavailable');
export type CatalogAccountSettingsV1 = ScmDiffSummarySettingsV1 & Readonly<{ voice: unknown }>;
export type PortableCatalogAccountSettingBindingV1<T extends CatalogAccountSettingsV1> = Readonly<{
    scope: 'account'; kind: 'owner'; access: 'read_write' | 'read_only' | 'sensitive';
    allowedValues?: readonly (string | number | boolean | null)[];
    read(settings: T): unknown;
    parse(value: unknown): Readonly<{ success: true; value: SettingDomainValueV1 }> | Readonly<{ success: false }>;
    mutate(settings: T, value: SettingDomainValueV1): Partial<T> | null;
    prepare?: (settings: T, value: SettingDomainValueV1,
        services: ScmDiffSummaryCatalogMutationServicesV1<T> & VoiceSettingsMutationServicesV1<T>,
        context?: Readonly<{ signal?: AbortSignal; isCurrent(): boolean }>) => Promise<((settings: T) => Partial<T> | null) | null>;
}>;
export type PortableVoiceSettingsBindingContextV1 = Readonly<{
    owner: VoiceSettingsOwner;
    registry: VoiceSettingsRegistry;
    unavailableValue?: unknown;
    isCurrent?(): boolean;
    captureLanguageOwner?: (providerId: string | null, registry: VoiceSettingsRegistry) => ((voice: VoiceSettings) => boolean);
}>;

/** Declaration owner/options choose the canonical reducer; no consumer knows a Voice storage path. */
export function readPortableCatalogAccountSettingBindingV1<T extends CatalogAccountSettingsV1>(
    declaration: PortableSettingDeclarationV1, voiceContext?: PortableVoiceSettingsBindingContextV1,
): PortableCatalogAccountSettingBindingV1<T> | null {
    const storage = declaration.storage;
    if (storage?.scope !== 'account' || storage.kind !== 'owner') return null;
    const argument = storage.options?.[0];
    if (storage.owner === 'scmDiffSummarySettingBinding') {
        return argument === SCM_DIFF_SUMMARY_SETTING_KEYS.prefetch || argument === SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride
            ? { ...scmDiffSummarySettingBinding<T>(argument), access: storage.access } : null;
    }
    if (!voiceContext) return null;
    const bindings = createVoiceSettingBindingsV1<T & { voice: VoiceSettings }>({ ...voiceContext,
        unavailableValue: voiceContext.unavailableValue ?? PORTABLE_SETTING_VALUE_UNAVAILABLE });
    let binding: ReturnType<typeof bindings.voiceSettingBinding> | undefined;
    try {
        switch (storage.owner) {
            case 'voiceSettingBinding':
                if (typeof argument === 'string') binding = bindings.voiceSettingBinding(argument as Parameters<typeof bindings.voiceSettingBinding>[0]);
                break;
            case 'voiceLocalConversationBinding':
                if (typeof argument === 'string') binding = bindings.voiceLocalConversationBinding(argument as Parameters<typeof bindings.voiceLocalConversationBinding>[0]);
                break;
            case 'voiceGreetingBinding': binding = bindings.voiceGreetingBinding; break;
            case 'voiceExecutionMachineBinding': binding = bindings.voiceExecutionMachineBinding; break;
            case 'voiceAgentSelectionBinding': binding = bindings.voiceAgentSelectionBinding; break;
            case 'voiceCustomAgentBinding': binding = bindings.voiceCustomAgentBinding; break;
            case 'voiceMemoryRestoreBinding': binding = bindings.voiceMemoryRestoreBinding; break;
            case 'voiceDiagnosticsCaptureBinding':
                if (argument === 'captureSttInput' || argument === 'captureTtsOutput') binding = bindings.voiceDiagnosticsCaptureBinding(argument);
                break;
        }
    } catch { return null; }
    if (!binding) return null;
    const selected = binding;
    const { prepare: prepareSelected, ...selectedProjection } = selected;
    const normalize = (settings: T): T & { voice: VoiceSettings } => ({ ...settings, voice: voiceContext.owner.voiceSettingsParse(settings.voice) });
    const delta = (value: Readonly<{ voice: VoiceSettings }> | null): Partial<T> | null => value as Partial<T> | null;
    return {
        ...selectedProjection, access: storage.access,
        read: settings => selected.read(normalize(settings)),
        mutate: (settings, value) => voiceContext.isCurrent?.() === false ? null : delta(selected.mutate(normalize(settings), value)),
        ...(prepareSelected ? { prepare: async (settings: T, value: SettingDomainValueV1,
            services: ScmDiffSummaryCatalogMutationServicesV1<T> & VoiceSettingsMutationServicesV1<T>,
            context?: Readonly<{ signal?: AbortSignal; isCurrent(): boolean }>) => {
            if (voiceContext.isCurrent?.() === false) return null;
            const prepared = await prepareSelected(normalize(settings), value, services, context);
            return prepared ? (current: T) => voiceContext.isCurrent?.() === false ? null : delta(prepared(normalize(current))) : null;
        } } : {}),
    };
}
