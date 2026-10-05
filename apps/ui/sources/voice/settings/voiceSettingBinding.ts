import { z } from 'zod';
import { SettingsDeclarationValueV1Schema, resolveVoiceProviderLanguagePreference } from '@happier-dev/protocol';

import type { SettingStorageBinding, SettingScalarValue } from '@/components/settings/catalog/settingDeclarations';
import { SETTING_VALUE_UNAVAILABLE } from '@/components/settings/catalog/settingDeclarations';
import {
    CanonicalVoiceSettingsSchema,
    readVoiceProviderSettingsConfig,
    readLocalConversationVoiceSettings,
    readLocalDirectVoiceSettings,
    writeLocalConversationVoiceSettings,
    writeLocalDirectVoiceSettings,
    VoiceLocalConversationSchema,
    type VoiceLocalConversationSettings,
    type VoiceLocalDirectSettings,
    type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import { applyVoiceWelcomeSelection, resolveVoiceWelcomeSelection } from './welcome';
import { applyVoiceAgentSelection } from './voiceAgentSelection';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { applyVoiceDictationEngineChoice, projectVoiceProviderSelectionRows, selectVoiceProviderOption } from '@/voice/registry/providerSelection';
import type { VoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import { captureConversationLanguagePreferenceOwner, projectConversationLanguagePreference, updateConversationLanguagePreference } from './language/conversationLanguage';

const choiceRegistry = createDefaultVoiceProviderRegistry();
const serviceChoiceSchema = z.object({ providerId: z.string().min(1), optionId: z.string().min(1) }).strict();

function decodeServiceChoice(value: unknown) {
    if (typeof value !== 'string') return null;
    try {
        const parsed = serviceChoiceSchema.safeParse(JSON.parse(value));
        return parsed.success ? parsed.data : null;
    } catch { return null; }
}

/** The selected service and its published billing/mode option are one choice. */
export const voiceServiceChoiceBinding: SettingStorageBinding = {
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

type ScalarPaths<T> = {
    [K in keyof T & string]: T[K] extends string | number | boolean | null | undefined ? K
        : T[K] extends Readonly<Record<string, unknown>> ? `${K}.${ScalarPaths<T[K]>}` : never;
}[keyof T & string];
type VoicePreferencePath = ScalarPaths<Omit<VoiceSettings, 'providers' | 'credentialBindings'>>;

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
    const scalar = parsed.success ? SettingsDeclarationValueV1Schema.safeParse(parsed.data) : null;
    return scalar?.success ? { success: true as const, value: scalar.data } : { success: false as const };
}

/** The shared root preference is writable only by a consumer that declares its meaning. */
export function updateVoiceConversationLanguagePreference(voice: VoiceSettings, value: SettingScalarValue, registry: VoiceProviderRegistry): VoiceSettings | null {
    const parsed = parseScalar(schemaAtPath(CanonicalVoiceSettingsSchema, ['assistantLanguage']), value);
    return parsed.success && (parsed.value === null || typeof parsed.value === 'string')
        ? updateConversationLanguagePreference(voice, parsed.value, registry) : null;
}

export function voiceConversationLanguageBinding(registry: VoiceProviderRegistry = choiceRegistry, capturedVoice?: VoiceSettings): SettingStorageBinding {
    const capturedPreference = capturedVoice && projectConversationLanguagePreference(capturedVoice, registry);
    const mutate = (settings: import('@/sync/domains/settings/settings').Settings, value: SettingScalarValue) => {
        const voice = updateVoiceConversationLanguagePreference(settings.voice, value, registry);
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
            const ownerIsCurrent = captureConversationLanguagePreferenceOwner(settings.voice.providerId, registry);
            return (latest) => !context?.signal?.aborted && context?.isCurrent() !== false
                && ownerIsCurrent(latest.voice)
                ? mutate(latest, value) : null;
        },
    };
}

/** Paths are admitted by typed declarations, never accepted from an Action input. */
export function voiceSettingBinding(path: VoicePreferencePath): SettingStorageBinding {
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
            mutate: (settings, value) => settings.voice.dictation.sttBinding === 'same_as_local'
                ? local.mutate(settings, value) : { voice: replacePath(settings.voice, segments, value) as VoiceSettings },
        };
    }
    const segments = path.split('.');
    const valueSchema = schemaAtPath(CanonicalVoiceSettingsSchema, segments);
    return {
        scope: 'account', kind: 'owner', access: 'read_write',
        read: (settings) => readPath(settings.voice, segments),
        parse: (value) => parseScalar(valueSchema, value),
        mutate: (settings, value) => ({ voice: replacePath(settings.voice, segments, value) as VoiceSettings }),
    };
}

export type LocalConversationPreferencePath = Exclude<ScalarPaths<VoiceLocalConversationSettings>,
    | 'agent.agentId' | 'agent.agentTargetKey' | 'agent.agentProjectionGeneration'
    | 'agent.agentIdentity.pluginId' | 'agent.agentIdentity.localId'>;

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
export function updateVoiceLocalConversationSetting(
    voice: VoiceSettings, path: LocalConversationPreferencePath, value: SettingScalarValue,
): VoiceSettings | null {
    const segments = path.split('.');
    const parsed = parseScalar(schemaAtPath(VoiceLocalConversationSchema, segments), value);
    const { direct, editable } = localPreferenceOwner(voice, path);
    if (!editable || !parsed.success) return null;
    return direct
        ? writeLocalDirectVoiceSettings(voice, replacePath(readLocalDirectVoiceSettings(voice), segments, parsed.value) as VoiceLocalDirectSettings)
        : writeLocalConversationVoiceSettings(voice, replacePath(readLocalConversationVoiceSettings(voice), segments, parsed.value) as VoiceLocalConversationSettings);
}

export function voiceLocalConversationBinding(path: LocalConversationPreferencePath): SettingStorageBinding {
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
            const voice = updateVoiceLocalConversationSetting(settings.voice, path, value);
            return voice ? { voice } : null;
        },
    };
}

export const voiceGreetingBinding: SettingStorageBinding = {
    scope: 'account', kind: 'owner', access: 'read_write', allowedValues: ['off', 'immediate', 'on_first_turn'],
    read: (settings) => resolveVoiceWelcomeSelection(settings.voice.welcome),
    parse: (value) => {
        const parsed = z.enum(['off', 'immediate', 'on_first_turn']).safeParse(value);
        return parsed.success ? { success: true, value: parsed.data } : { success: false };
    },
    mutate: (settings, value: SettingScalarValue) => ({
        voice: applyVoiceWelcomeSelection(settings.voice, z.enum(['off', 'immediate', 'on_first_turn']).parse(value)),
    }),
};

export const voiceAgentSelectionBinding: SettingStorageBinding = {
    scope: 'account', kind: 'owner', access: 'read_write',
    read: (settings) => canEditLocalConversation(settings.voice)
        ? readLocalConversationVoiceSettings(settings.voice).agent.agentId : SETTING_VALUE_UNAVAILABLE,
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
        const entry = catalog.entries.find((candidate) => candidate.agentId === value);
        if (!entry || entry.enabled === false) return null;
        return (current) => catalog.isCurrent(current) && canEditLocalConversation(current.voice)
            ? { voice: applyVoiceAgentSelection(current.voice, { kind: 'catalog', entry }) }
            : null;
    },
};

/** The inline custom-id editor is a distinct intent, not a failed catalog lookup. */
export const voiceCustomAgentBinding: SettingStorageBinding = {
    scope: 'account', kind: 'owner', access: 'read_write',
    read: (settings) => canEditLocalConversation(settings.voice)
        ? readLocalConversationVoiceSettings(settings.voice).agent.agentId : SETTING_VALUE_UNAVAILABLE,
    parse: (value) => {
        const parsed = parseScalar(schemaAtPath(VoiceLocalConversationSchema, ['agent', 'agentId']), value);
        return parsed.success && typeof parsed.value === 'string' && parsed.value.trim()
            ? { success: true, value: parsed.value.trim() } : { success: false };
    },
    mutate: (settings, value) => canEditLocalConversation(settings.voice) && typeof value === 'string'
        ? { voice: applyVoiceAgentSelection(settings.voice, { kind: 'custom', agentId: value }) } : null,
};
