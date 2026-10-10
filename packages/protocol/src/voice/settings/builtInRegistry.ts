import { VoiceLocalConversationSchema } from './localConversation.js';
import { VoiceLocalDirectSchema } from './localDirect.js';
import type { VoiceProviderSettingsProjection, VoiceSettingsRegistryEntry } from './providerRegistry.js';
import type { SessionVoiceDeclarationV1 } from '../../sessions/instructions/sessionVoicePreferenceV1.js';

export const BUILT_IN_LOCAL_NEURAL_VOICE_PROVIDER_ID = 'happier.voice.builtin/local-neural';
/** Only the existing Kokoro voice is Session-selectable; engine/model/speed remain Account settings. */
export const BUILT_IN_LOCAL_NEURAL_VOICE_DECLARATION: SessionVoiceDeclarationV1 = {
    kind: 'speech',
    settings: { schemaVersion: 1, fields: [{ id: 'voiceId', title: 'Voice',
        schema: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
        default: null, presentation: { control: 'select' } }] },
    catalogs: [{ kind: 'voices', settingFieldId: 'voiceId', allowCustom: false }],
};

type SettingsSchema = Readonly<{ safeParse(value: unknown): Readonly<{ success: boolean }> }>;
function projectVersionOneSettings(envelope: Readonly<{ schemaVersion: number; config: unknown }> | null,
    schema: SettingsSchema): VoiceProviderSettingsProjection {
    if (!envelope) return { status: 'needs_migration', modeId: null };
    if (envelope.schemaVersion > 1) return { status: 'unsupported_version', modeId: null };
    if (envelope.schemaVersion < 1) return { status: 'needs_migration', modeId: null };
    return schema.safeParse(envelope.config).success ? { status: 'ready', modeId: null } : { status: 'invalid', modeId: null };
}
const platforms = ['web', 'ios', 'android'] as const;
const entries = {
    local_conversation: { kind: 'voice.conversation-provider.v1', providerId: 'local_conversation',
        roles: ['conversation_stt', 'conversation_tts', 'vad', 'endpointing'],
        requirements: ['server_feature', 'runtime', 'model', 'execution_machine', 'endpoint', 'credential'], supportedPlatforms: platforms,
        selectionOptions: [{ id: 'local', modeId: null, order: 30, titleKey: 'settingsVoice.mode.local', subtitleKey: 'settingsVoice.mode.localSubtitle' }],
        projectSettings: (envelope: Readonly<{ schemaVersion: number; config: unknown }> | null) => projectVersionOneSettings(envelope, VoiceLocalConversationSchema),
    },
    // Compatibility-only adapter: no released picker offers a separate direct-session selection.
    local_direct: { kind: 'voice.conversation-provider.v1', providerId: 'local_direct',
        roles: ['conversation_stt', 'conversation_tts', 'vad', 'endpointing'], requirements: ['execution_machine'], supportedPlatforms: platforms,
        projectSettings: (envelope: Readonly<{ schemaVersion: number; config: unknown }> | null) => projectVersionOneSettings(envelope, VoiceLocalDirectSchema),
    },
    device: { kind: 'voice.speech-engine.v1', providerId: 'device', roles: ['dictation_stt', 'conversation_stt', 'conversation_tts'], requirements: [], supportedPlatforms: platforms },
    local_neural: { kind: 'voice.speech-engine.v1', providerId: 'local_neural', roles: ['dictation_stt', 'conversation_stt', 'conversation_tts'], requirements: ['runtime', 'model'], supportedPlatforms: platforms,
        sessionVoice: { providerContributionId: BUILT_IN_LOCAL_NEURAL_VOICE_PROVIDER_ID, declaration: BUILT_IN_LOCAL_NEURAL_VOICE_DECLARATION } },
    host_turn_detection: { kind: 'voice.turn-support.v1', providerId: 'host_turn_detection', roles: ['vad', 'endpointing'], requirements: ['runtime'], supportedPlatforms: platforms },
} as const satisfies Readonly<Record<string, VoiceSettingsRegistryEntry>>;

export function readBuiltInVoiceSettingsRegistryEntry<K extends keyof typeof entries>(providerId: K): typeof entries[K] {
    return entries[providerId];
}
export const BUILT_IN_VOICE_SETTINGS_REGISTRY_ENTRIES: readonly VoiceSettingsRegistryEntry[] = Object.freeze(Object.values(entries));
