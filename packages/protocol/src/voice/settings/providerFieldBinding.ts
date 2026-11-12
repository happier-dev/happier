import { SettingsDeclarationValueV1Schema } from '../../actions/settingsDeclarationActionFamily.js';
import type { SettingDomainValueV1 } from '../../actions/settings/settingsOwnerActions.js';
import type { VoiceSettings, VoiceSettingsOwner } from './voiceSettings.js';
import type { VoiceSettingsRegistry, VoiceSettingsRegistryEntry } from './providerRegistry.js';
import { readRealtimeProviderConfigPath, updateRealtimeProviderConfig } from './providerConfig.js';

function record(value: unknown): value is Readonly<Record<string, unknown>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The declaration-selected provider field binding, shared by App and native Settings Actions. */
export function createVoiceProviderFieldBinding<T extends Readonly<{ voice: VoiceSettings }>>(input: Readonly<{
    entry: VoiceSettingsRegistryEntry; path: string; owner: VoiceSettingsOwner;
    registry: VoiceSettingsRegistry; unavailableValue: unknown;
}>) {
    const { entry, path, owner, registry } = input;
    const descriptor = entry.providerSettings;
    if (!descriptor) return null;
    const segments = path.split('.');
    const field = descriptor.fields.find(field => field.id === path);
    if (field?.secret) return null;
    const schema = field?.schema;
    const schemaType = record(schema) ? schema.type : undefined;
    const defaultValue = readRealtimeProviderConfigPath(descriptor.defaultConfig, segments);
    const compound = record(defaultValue) || Array.isArray(defaultValue) || field?.presentation?.control === 'json'
        || schemaType === 'object' || schemaType === 'array'
        || Array.isArray(schemaType) && schemaType.some(type => type === 'object' || type === 'array');
    const decode = (value: unknown): unknown => {
        if (!compound) return value;
        if (typeof value !== 'string') return undefined;
        try { return JSON.parse(value) as unknown; } catch { return undefined; }
    };
    const configOwner = { parseConfig: (value: unknown) => {
        const parsed = descriptor.parseConfig(value);
        return record(parsed) ? parsed : null;
    } };
    const parse = (value: unknown): Readonly<{ success: true; value: SettingDomainValueV1 }> | Readonly<{ success: false }> => {
        const parsed = SettingsDeclarationValueV1Schema.safeParse(value);
        const candidate = parsed.success ? decode(parsed.data) : undefined;
        return parsed.success && candidate !== undefined && updateRealtimeProviderConfig(configOwner, descriptor.defaultConfig, segments, candidate)
            ? { success: true, value: parsed.data } : { success: false };
    };
    const readConfig = (settings: T) => {
        const envelope = settings.voice.providers[entry.providerId];
        if (envelope && envelope.schemaVersion !== descriptor.schemaVersion) return null;
        return envelope ? owner.readVoiceProviderSettingsConfig(settings.voice, entry.providerId) : descriptor.defaultConfig;
    };
    return {
        scope: 'account' as const, kind: 'owner' as const, access: 'read_write' as const,
        read: (settings: T) => {
            const config = readConfig(settings);
            if (!config) return input.unavailableValue;
            const value = readRealtimeProviderConfigPath(config, segments);
            return compound && value !== undefined ? JSON.stringify(value) : value;
        },
        parse,
        decode,
        mutate: (settings: T, value: SettingDomainValueV1): Readonly<{ voice: VoiceSettings }> | null => {
            const parsed = parse(value);
            if (!parsed.success || registry.get(entry.providerId)?.providerSettings !== descriptor) return null;
            const config = readConfig(settings);
            if (!config) return null;
            const next = updateRealtimeProviderConfig(configOwner, config, segments, decode(parsed.value));
            return next ? { voice: owner.writeVoiceProviderSettingsConfig(settings.voice, entry.providerId, next) } : null;
        },
    };
}
