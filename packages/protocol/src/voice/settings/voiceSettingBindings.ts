import { z } from 'zod';
import { resolveVoiceProviderLanguagePreference } from '../../plugins/contributions/voiceProviders.js';
import { SettingsDeclarationValueV1Schema } from '../../actions/settingsDeclarationActionFamily.js';
import type { SettingDomainValueV1 } from '../../actions/settings/settingsOwnerActions.js';
import type { VoiceSettings, VoiceSettingsOwner, VoiceLocalConversationSettings, VoiceLocalDirectSettings } from './voiceSettings.js';
import { VoiceLocalConversationSchema } from './localConversation.js';
import { applyVoiceWelcomeSelection, resolveVoiceWelcomeSelection } from './welcome.js';
import { applyVoiceAgentSelectionV1, resolveVoiceAgentCatalogSelectionV1, type VoiceAgentCatalogEntryV1 } from './voiceAgentSelection.js';
import { applyVoiceDictationEngineChoice, projectVoiceProviderSelectionRows, selectVoiceProviderOption } from './providerSelection.js';
import type { VoiceSettingsRegistry as VoiceProviderRegistry } from './providerRegistry.js';
import { projectConversationLanguagePreference, updateConversationLanguagePreference } from './conversationLanguage.js';
import type { VoiceSpeechDiagnosticsSettingsV1 } from '../diagnostics.js';

export const VoiceMemoryRestoreChoiceSchema = z.enum(['recent_messages', 'summary_plus_recent', 'provider_resume']);
export type VoiceMemoryRestoreChoice = z.infer<typeof VoiceMemoryRestoreChoiceSchema>;
type CaptureDirection = 'captureSttInput' | 'captureTtsOutput';
const executionMachineChoiceSchema = z.string().trim().min(1);
export function applyVoiceExecutionMachineChoice(voice: VoiceSettings, choice: string): VoiceSettings {
    const machineId = executionMachineChoiceSchema.parse(choice);
    return { ...voice, executionMachine: machineId === 'auto' ? { mode: 'auto', machineId: null }
        : { ...voice.executionMachine, mode: 'fixed', machineId } };
}
export function applyVoiceDiagnosticsCaptureDirection(diagnostics: VoiceSpeechDiagnosticsSettingsV1,
    direction: CaptureDirection, enabled: boolean): VoiceSpeechDiagnosticsSettingsV1 {
    const next = { ...diagnostics, [direction]: enabled };
    return next.captureSttInput || next.captureTtsOutput ? next : { ...next, enabled: false, consentVersion: null };
}

export type VoiceScalarValueV1 = Extract<SettingDomainValueV1, string | number | boolean | null>;
export type VoiceSettingsMutationServicesV1<T> = Readonly<{ readAgentCatalog?: (settings: T) => Promise<Readonly<{ entries: readonly VoiceAgentCatalogEntryV1[]; isCurrent(settings: T): boolean }> | null> }>;
export type VoiceSettingBindingV1<T extends { voice: VoiceSettings }> = Readonly<{
 scope: 'account'; kind: 'owner'; access: 'read_write' | 'read_only' | 'sensitive'; allowedValues?: readonly VoiceScalarValueV1[];
 read(settings: T): unknown;
 parse(value: unknown): Readonly<{success: true; value: SettingDomainValueV1}> | Readonly<{success: false}>;
 mutate(settings: T, value: SettingDomainValueV1): Readonly<{voice: VoiceSettings}> | null;
 prepare?: (settings: T, value: SettingDomainValueV1, services: VoiceSettingsMutationServicesV1<T>, context?: Readonly<{signal?: AbortSignal; isCurrent(): boolean}>) => Promise<((settings: T) => Readonly<{voice: VoiceSettings}> | null) | null>;
}>;
function parseSettingScalarValue(value: unknown) {
 const parsed=SettingsDeclarationValueV1Schema.safeParse(value);
 return parsed.success && (parsed.data === null || typeof parsed.data !== 'object') ? { success: true as const, value: parsed.data } : { success: false as const };
}

type ScalarPaths<T> = {
    [K in keyof T & string]: T[K] extends string | number | boolean | null | undefined ? K
        : T[K] extends Readonly<Record<string, unknown>> ? `${K}.${ScalarPaths<T[K]>}` : never;
}[keyof T & string];
type VoicePreferencePath = ScalarPaths<Omit<VoiceSettings, 'providers' | 'credentialBindings'>>;
export type LocalConversationPreferencePath = Exclude<ScalarPaths<VoiceLocalConversationSettings>,
    | 'agent.agentId' | 'agent.agentTargetKey' | 'agent.agentProjectionGeneration'
    | 'agent.agentIdentity.pluginId' | 'agent.agentIdentity.localId'>;

export function createVoiceSettingBindingsV1<T extends {voice: VoiceSettings}>(input: Readonly<{
 owner: VoiceSettingsOwner; registry: VoiceProviderRegistry; unavailableValue: unknown;
 captureLanguageOwner?: (providerId: string | null, registry: VoiceProviderRegistry) => ((voice: VoiceSettings) => boolean);
}>) {
 const { owner, registry: choiceRegistry, unavailableValue: SETTING_VALUE_UNAVAILABLE } = input;
 const { CanonicalVoiceSettingsSchema, readVoiceProviderSettingsConfig, readLocalConversationVoiceSettings, readLocalDirectVoiceSettings, writeLocalConversationVoiceSettings, writeLocalDirectVoiceSettings } = owner;
 const captureLanguageOwner = input.captureLanguageOwner ?? ((providerId, registry) => {
   const entry = providerId ? registry.get(providerId) : null;
   return (voice: VoiceSettings) => providerId !== null && voice.providerId === providerId && registry.get(providerId) === entry;
 });
const serviceChoiceSchema = z.object({ providerId: z.string().min(1), optionId: z.string().min(1) }).strict();
const voiceGreetingChoiceSchema = z.enum(['off', 'immediate', 'on_first_turn']);

function decodeServiceChoice(value: unknown) {
    if (typeof value !== 'string') return null;
    try {
        const parsed = serviceChoiceSchema.safeParse(JSON.parse(value));
        return parsed.success ? parsed.data : null;
    } catch { return null; }
}

/** The selected service and its published billing/mode option are one choice. */
const voiceServiceChoiceBinding: VoiceSettingBindingV1<T> = {
    scope: 'account', kind: 'owner', access: 'read_write',
    read: (settings) => {
        if (settings.voice.providerId === null) return null;
        const selected = projectVoiceProviderSelectionRows(settings.voice, choiceRegistry).find((row) => row.selected);
        return selected ? JSON.stringify({ providerId: selected.providerId, optionId: selected.optionId }) : SETTING_VALUE_UNAVAILABLE;
    },
    parse: (value) => {
        if (value === null) return { success: true, value: null };
        const choice = decodeServiceChoice(value);
        const entry = choice && choiceRegistry.get(choice.providerId);
        return choice && entry?.kind === 'voice.conversation-provider.v1'
            && entry.selectionOptions?.some((option) => option.id === choice.optionId)
            ? { success: true, value: JSON.stringify(choice) } : { success: false };
    },
    mutate: (settings, value) => {
        if (value === null) return { voice: { ...settings.voice, providerId: null } };
        const choice = decodeServiceChoice(value);
        const voice = choice && selectVoiceProviderOption(settings.voice, choiceRegistry, choice.providerId, choice.optionId);
        return voice ? { voice } : null;
    },
};



function object(value: unknown): Readonly<Record<string, unknown>> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {};
}

function readPath(value: unknown, path: readonly string[]): unknown {
    return path.reduce((current, segment) => object(current)[segment], value);
}

function replacePath(value: unknown, path: readonly string[], next: unknown): unknown {
    const [key, ...rest] = path;
    if (!key) return next;
    const current = object(value);
    return { ...current, [key]: replacePath(current[key], rest, next) };
}

function unwrap(schema: z.core.$ZodType): z.core.$ZodType {
    if (schema instanceof z.ZodDefault || schema instanceof z.ZodPrefault) return unwrap(schema.unwrap());
    if (schema instanceof z.ZodCatch) return unwrap(schema.removeCatch());
    if (schema instanceof z.ZodPipe) return unwrap(schema.out);
    return schema;
}

function schemaAtPath(root: z.core.$ZodType, segments: readonly string[]): z.core.$ZodType {
    let schema = root;
    for (const segment of segments) {
        const parent = unwrap(schema);
        if (!(parent instanceof z.ZodObject) || !parent.shape[segment]) throw new Error(`Unknown Voice preference: ${segments.join('.')}`);
        schema = parent.shape[segment];
    }
    return unwrap(schema);
}

function parseScalar(schema: z.core.$ZodType, value: unknown) {
    const parsed = z.safeParse(schema, value);
    return parsed.success ? parseSettingScalarValue(parsed.data) : { success: false as const };
}

/** The shared root preference is writable only by a consumer that declares its meaning. */
function updateVoiceConversationLanguagePreference(voice: VoiceSettings, value: VoiceScalarValueV1, registry: VoiceProviderRegistry): VoiceSettings | null {
    const parsed = parseScalar(schemaAtPath(CanonicalVoiceSettingsSchema, ['assistantLanguage']), value);
    return parsed.success && (parsed.value === null || typeof parsed.value === 'string')
        ? updateConversationLanguagePreference(voice, parsed.value, registry) : null;
}

function voiceConversationLanguageBinding(registry: VoiceProviderRegistry = choiceRegistry, capturedVoice?: VoiceSettings): VoiceSettingBindingV1<T> {
    const capturedPreference = capturedVoice && projectConversationLanguagePreference(capturedVoice, registry);
    const mutate = (settings: T, value: SettingDomainValueV1) => {
        const parsed = parseScalar(schemaAtPath(CanonicalVoiceSettingsSchema, ['assistantLanguage']), value);
        const voice = parsed.success && updateVoiceConversationLanguagePreference(settings.voice, parsed.value, registry);
        return voice ? { voice } : null;
    };
    return {
        scope: 'account', kind: 'owner', access: 'read_write',
        read: (settings) => {
            const preference = projectConversationLanguagePreference(settings.voice, registry);
            if (preference.kind === 'unavailable') return SETTING_VALUE_UNAVAILABLE;
            if (preference.kind !== 'single_language') return settings.voice.assistantLanguage;
            const language = resolveVoiceProviderLanguagePreference(settings.voice.assistantLanguage, preference.supportedLanguageCodes);
            return settings.voice.assistantLanguage !== null && language === null ? SETTING_VALUE_UNAVAILABLE : language;
        },
        parse: (value) => {
            const parsed = parseScalar(schemaAtPath(CanonicalVoiceSettingsSchema, ['assistantLanguage']), value);
            if (!parsed.success || capturedPreference?.kind === 'unavailable') return { success: false };
            if (capturedPreference?.kind !== 'single_language') return parsed;
            if (parsed.value !== null && typeof parsed.value !== 'string') return { success: false };
            const language = resolveVoiceProviderLanguagePreference(parsed.value, capturedPreference.supportedLanguageCodes);
            return parsed.value !== null && language === null ? { success: false } : { success: true, value: language };
        },
        mutate,
        prepare: async (settings, value, _services, context) => {
            if (capturedVoice && capturedVoice.providerId !== settings.voice.providerId) return null;
            if (!mutate(settings, value)) return null;
            const ownerIsCurrent = captureLanguageOwner(settings.voice.providerId, registry);
            return (latest) => !context?.signal?.aborted && context?.isCurrent() !== false
                && ownerIsCurrent(latest.voice)
                ? mutate(latest, value) : null;
        },
    };
}

/** Paths are admitted by typed declarations, never accepted from an Action input. */
function voiceSettingBinding(path: VoicePreferencePath): VoiceSettingBindingV1<T> {
    if (path === 'providerId') return voiceServiceChoiceBinding;
    if (path === 'assistantLanguage') return voiceConversationLanguageBinding();
    if (path === 'dictation.stt.provider') return {
        scope: 'account', kind: 'owner', access: 'read_write',
        read: (settings) => settings.voice.dictation.sttBinding === 'same_as_local' ? 'same_as_local' : settings.voice.dictation.stt.provider,
        parse: (value) => {
            if (typeof value !== 'string') return { success: false };
            const entry = choiceRegistry.get(value);
            return value === 'same_as_local' || entry?.kind === 'voice.speech-engine.v1' && entry.roles.includes('dictation_stt')
                ? { success: true, value } : { success: false };
        },
        mutate: (settings, value) => {
            const voice = typeof value === 'string' && applyVoiceDictationEngineChoice(settings.voice, choiceRegistry, value);
            return voice ? { voice } : null;
        },
    };
    if (path.startsWith('dictation.stt.')) {
        const local = voiceLocalConversationBinding(path.slice('dictation.'.length) as LocalConversationPreferencePath);
        if (!('kind' in local) || local.kind !== 'owner') throw new Error('Expected the local speech owner');
        const segments = path.split('.');
        const valueSchema = schemaAtPath(CanonicalVoiceSettingsSchema, segments);
        return {
            scope: 'account', kind: 'owner', access: 'read_write',
            read: (settings) => settings.voice.dictation.sttBinding === 'same_as_local' ? local.read(settings) : readPath(settings.voice, segments),
            parse: (value) => parseScalar(valueSchema, value),
            mutate: (settings, value) => {
                const parsed = parseScalar(valueSchema, value);
                return !parsed.success ? null : settings.voice.dictation.sttBinding === 'same_as_local'
                    ? local.mutate(settings, parsed.value) : { voice: replacePath(settings.voice, segments, parsed.value) as VoiceSettings };
            },
        };
    }
    const segments = path.split('.');
    const valueSchema = schemaAtPath(CanonicalVoiceSettingsSchema, segments);
    return {
        scope: 'account', kind: 'owner', access: 'read_write',
        read: (settings) => readPath(settings.voice, segments),
        parse: (value) => parseScalar(valueSchema, value),
        mutate: (settings, value) => {
            const parsed = parseScalar(valueSchema, value);
            return parsed.success ? { voice: replacePath(settings.voice, segments, parsed.value) as VoiceSettings } : null;
        },
    };
}



function canEditLocalConversation(voice: VoiceSettings): boolean {
    return !voice.providers.local_conversation || readVoiceProviderSettingsConfig(voice, 'local_conversation') !== null;
}

function localPreferenceOwner(voice: VoiceSettings, path: LocalConversationPreferencePath) {
    const sharedSpeechPath = path.startsWith('stt.') || path.startsWith('tts.')
        || path.startsWith('handsFree.') || path === 'networkTimeoutMs';
    const direct = sharedSpeechPath && voice.providerId === 'local_direct';
    const editable = direct
        ? !voice.providers.local_direct || readVoiceProviderSettingsConfig(voice, 'local_direct') !== null
        : canEditLocalConversation(voice);
    return { direct, editable };
}

/** Rendered controls and declaration Actions apply the same admitted field to the same adapter. */
function updateVoiceLocalConversationSetting(
    voice: VoiceSettings, path: LocalConversationPreferencePath, value: VoiceScalarValueV1,
): VoiceSettings | null {
    const segments = path.split('.');
    const parsed = parseScalar(schemaAtPath(VoiceLocalConversationSchema, segments), value);
    const { direct, editable } = localPreferenceOwner(voice, path);
    if (!editable || !parsed.success) return null;
    return direct
        ? writeLocalDirectVoiceSettings(voice, replacePath(readLocalDirectVoiceSettings(voice), segments, parsed.value) as VoiceLocalDirectSettings)
        : writeLocalConversationVoiceSettings(voice, replacePath(readLocalConversationVoiceSettings(voice), segments, parsed.value) as VoiceLocalConversationSettings);
}

function voiceLocalConversationBinding(path: LocalConversationPreferencePath): VoiceSettingBindingV1<T> {
    const segments = path.split('.');
    const valueSchema = schemaAtPath(VoiceLocalConversationSchema, segments);
    return {
        scope: 'account', kind: 'owner', access: 'read_write',
        read: (settings) => {
            const { direct, editable } = localPreferenceOwner(settings.voice, path);
            return editable ? readPath(direct ? readLocalDirectVoiceSettings(settings.voice) : readLocalConversationVoiceSettings(settings.voice), segments)
                : SETTING_VALUE_UNAVAILABLE;
        },
        parse: (value) => parseScalar(valueSchema, value),
        mutate: (settings, value) => {
            const parsed = parseScalar(valueSchema, value);
            const voice = parsed.success && updateVoiceLocalConversationSetting(settings.voice, path, parsed.value);
            return voice ? { voice } : null;
        },
    };
}

const voiceGreetingBinding: VoiceSettingBindingV1<T> = {
    scope: 'account', kind: 'owner', access: 'read_write', allowedValues: ['off', 'immediate', 'on_first_turn'],
    read: (settings) => resolveVoiceWelcomeSelection(settings.voice.welcome),
    parse: (value) => {
        const parsed = voiceGreetingChoiceSchema.safeParse(value);
        return parsed.success ? { success: true, value: parsed.data } : { success: false };
    },
    mutate: (settings, value) => {
        const parsed = voiceGreetingChoiceSchema.safeParse(value);
        return parsed.success ? { voice: applyVoiceWelcomeSelection(settings.voice, parsed.data) } : null;
    },
};

const voiceAgentSelectionBinding: VoiceSettingBindingV1<T> = {
    scope: 'account', kind: 'owner', access: 'read_write',
    read: (settings) => canEditLocalConversation(settings.voice)
        ? readLocalConversationVoiceSettings(settings.voice).agent.agentTargetKey
            ?? readLocalConversationVoiceSettings(settings.voice).agent.agentId : SETTING_VALUE_UNAVAILABLE,
    parse: (value) => {
        const parsed = z.string().trim().min(1).safeParse(value);
        return parsed.success ? { success: true, value: parsed.data } : { success: false };
    },
    // Catalog choices are prepared through the exact Account/machine owner below, never inferred.
    mutate: () => null,
    prepare: async (settings, value, services) => {
        if (typeof value !== 'string' || !canEditLocalConversation(settings.voice)) return null;
        const catalog = await services.readAgentCatalog?.(settings);
        if (!catalog) return null;
        const entry = resolveVoiceAgentCatalogSelectionV1(catalog.entries, value);
        if (!entry || entry.enabled === false) return null;
        return (current) => catalog.isCurrent(current) && canEditLocalConversation(current.voice)
            ? { voice: applyVoiceAgentSelectionV1(current.voice, { kind: 'catalog', entry }, owner) }
            : null;
    },
};

/** The inline custom-id editor is a distinct intent, not a failed catalog lookup. */
const voiceCustomAgentBinding: VoiceSettingBindingV1<T> = {
    scope: 'account', kind: 'owner', access: 'read_write',
    read: (settings) => canEditLocalConversation(settings.voice)
        ? readLocalConversationVoiceSettings(settings.voice).agent.agentId : SETTING_VALUE_UNAVAILABLE,
    parse: (value) => {
        const parsed = parseScalar(schemaAtPath(VoiceLocalConversationSchema, ['agent', 'agentId']), value);
        return parsed.success && typeof parsed.value === 'string' && parsed.value.trim()
            ? { success: true, value: parsed.value.trim() } : { success: false };
    },
    mutate: (settings, value) => canEditLocalConversation(settings.voice) && typeof value === 'string'
        ? { voice: applyVoiceAgentSelectionV1(settings.voice, { kind: 'custom', agentId: value }, owner) } : null,
};

function resolveVoiceMemoryRestoreChoice(voice: VoiceSettings): VoiceMemoryRestoreChoice {
    const agent = readLocalConversationVoiceSettings(voice).agent;
    return agent.resumabilityMode === 'provider_resume' ? 'provider_resume' : agent.replay.strategy;
}
function applyVoiceMemoryRestoreChoice(voice: VoiceSettings, choice: VoiceMemoryRestoreChoice): VoiceSettings {
    const config = readLocalConversationVoiceSettings(voice);
    const agent = choice === 'provider_resume' ? { ...config.agent, resumabilityMode: 'provider_resume' as const }
        : { ...config.agent, resumabilityMode: 'replay' as const, replay: { ...config.agent.replay, strategy: choice } };
    return writeLocalConversationVoiceSettings(voice, { ...config, agent });
}
const voiceMemoryRestoreBinding: VoiceSettingBindingV1<T> = {
    scope: 'account', kind: 'owner', access: 'read_write', allowedValues: VoiceMemoryRestoreChoiceSchema.options,
    read: settings => canEditLocalConversation(settings.voice) ? resolveVoiceMemoryRestoreChoice(settings.voice) : SETTING_VALUE_UNAVAILABLE,
    parse: value => {
        const parsed = VoiceMemoryRestoreChoiceSchema.safeParse(value);
        return parsed.success ? { success: true, value: parsed.data } : { success: false };
    },
    mutate: (settings, value) => !canEditLocalConversation(settings.voice) ? null
        : { voice: applyVoiceMemoryRestoreChoice(settings.voice, VoiceMemoryRestoreChoiceSchema.parse(value)) },
};
const voiceExecutionMachineBinding: VoiceSettingBindingV1<T> = {
    scope: 'account', kind: 'owner', access: 'read_write',
    read: settings => settings.voice.executionMachine.mode === 'fixed' ? settings.voice.executionMachine.machineId : 'auto',
    parse: value => {
        const parsed = executionMachineChoiceSchema.safeParse(value);
        return parsed.success ? { success: true, value: parsed.data } : { success: false };
    },
    mutate: (settings, value) => ({ voice: applyVoiceExecutionMachineChoice(settings.voice, executionMachineChoiceSchema.parse(value)) }),
};
function voiceDiagnosticsCaptureBinding(direction: CaptureDirection): VoiceSettingBindingV1<T> {
    return { scope: 'account', kind: 'owner', access: 'read_write',
        read: settings => owner.readVoiceDiagnosticsSettings(settings.voice)[direction],
        parse: value => typeof value === 'boolean' ? { success: true, value } : { success: false },
        mutate: (settings, value) => typeof value !== 'boolean' ? null : { voice: owner.writeVoiceDiagnosticsSettings(settings.voice,
            applyVoiceDiagnosticsCaptureDirection(owner.readVoiceDiagnosticsSettings(settings.voice), direction, value)) },
    };
}
return { voiceServiceChoiceBinding, voiceConversationLanguageBinding, voiceSettingBinding, voiceLocalConversationBinding, voiceGreetingBinding, voiceAgentSelectionBinding, voiceCustomAgentBinding, updateVoiceConversationLanguagePreference, updateVoiceLocalConversationSetting,
    voiceMemoryRestoreBinding, resolveVoiceMemoryRestoreChoice, applyVoiceMemoryRestoreChoice, voiceExecutionMachineBinding, voiceDiagnosticsCaptureBinding };
}
