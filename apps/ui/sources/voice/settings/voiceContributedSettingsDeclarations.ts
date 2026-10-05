import { SettingsDeclarationValueV1Schema } from '@happier-dev/protocol';
import { defineSettingsPage, SETTING_VALUE_UNAVAILABLE, type SettingDeclaration, type SettingStorageBinding } from '@/components/settings/catalog/settingDeclarations';
import type { SettingsPageId } from '@/components/settings/catalog/types';
import { readVoiceProviderSettingsConfig, writeVoiceProviderSettingsConfig } from '@/sync/domains/settings/voiceSettings';
import { resolvePluginLocalizedText, type PluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { tLoose } from '@/text';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import type { VoiceProviderRegistry, VoiceProviderRegistryEntry } from '@/voice/registry/providerRegistry';
import { readRealtimeProviderConfigPath, updateRealtimeProviderConfig } from './panels/realtime/descriptor';
import { parseRealtimeSettingsDescriptor, type RealtimeSettingsFieldDescriptor } from './panels/realtime/descriptor';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import type { Settings } from '@/sync/domains/settings/settings';
import type { SettingScalarValue } from '@/components/settings/catalog/settingDeclarations';
import { readBundledSpeechSettingsDescriptorFromEntry } from './panels/bundledSpeech/descriptor';

export const voiceSettingsDeclarationRegistry = createDefaultVoiceProviderRegistry();

function record(value: unknown): value is Readonly<Record<string, unknown>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Only published field/presentation paths can create a binding; Action input never supplies a path. */
function providerFieldBinding(entry: VoiceProviderRegistryEntry, path: string, preparesEndpoint: boolean): SettingStorageBinding | undefined {
    const descriptor = entry.providerSettings;
    if (!descriptor) return undefined;
    const segments = path.split('.');
    const owner = {
        schemaVersion: descriptor.schemaVersion,
        defaultConfig: descriptor.defaultConfig,
        parseConfig: (value: unknown) => {
            const parsed = descriptor.parseConfig(value);
            return record(parsed) ? parsed : null;
        },
    };
    const defaultValue = readRealtimeProviderConfigPath(descriptor.defaultConfig, segments);
    const published = descriptor.fields.find((field) => field.id === path);
    const publishedSchema = published?.schema;
    const publishedType = record(publishedSchema) ? publishedSchema.type : undefined;
    const presentation = parseRealtimeSettingsDescriptor(entry.providerId, descriptor.presentation)?.fields
        .flatMap((field) => [field, ...(Array.isArray(field.subfields) ? field.subfields as readonly RealtimeSettingsFieldDescriptor[] : [])])
        .find((field) => field.path === path);
    const compound = record(defaultValue) || Array.isArray(defaultValue)
        || published?.presentation?.control === 'json'
        || publishedType === 'object' || publishedType === 'array'
        || Array.isArray(publishedType) && publishedType.some((type) => type === 'object' || type === 'array');
    const decode = (value: unknown): unknown => {
        if (!compound) return value;
        if (typeof value !== 'string') return undefined;
        try { return JSON.parse(value) as unknown; } catch { return undefined; }
    };
    const mutate = (settings: Settings, value: SettingScalarValue) => {
        if (voiceSettingsDeclarationRegistry.get(entry.providerId)?.providerSettings !== descriptor) return null;
        const envelope = settings.voice.providers[entry.providerId];
        if (envelope && envelope.schemaVersion !== descriptor.schemaVersion) return null;
        const config = envelope ? readVoiceProviderSettingsConfig(settings.voice, entry.providerId) : descriptor.defaultConfig;
        if (!config) return null;
        const next = updateRealtimeProviderConfig(owner, config, segments, decode(value));
        return next ? { voice: writeVoiceProviderSettingsConfig(settings.voice, entry.providerId, next) } : null;
    };
    return {
        scope: 'account', kind: 'owner', access: 'read_write',
        read: (settings) => {
            const envelope = settings.voice.providers[entry.providerId];
            if (envelope && envelope.schemaVersion !== descriptor.schemaVersion) return SETTING_VALUE_UNAVAILABLE;
            const config = envelope ? readVoiceProviderSettingsConfig(settings.voice, entry.providerId) : descriptor.defaultConfig;
            if (!config) return SETTING_VALUE_UNAVAILABLE;
            const value = readRealtimeProviderConfigPath(config, segments);
            return compound && value !== undefined ? JSON.stringify(value) : value;
        },
        parse: (value) => {
            const scalar = SettingsDeclarationValueV1Schema.safeParse(value);
            const candidate = decode(value);
            return scalar.success && candidate !== undefined
                && updateRealtimeProviderConfig(owner, descriptor.defaultConfig, segments, candidate)
                ? { success: true, value: scalar.data } : { success: false };
        },
        mutate,
        prepare: preparesEndpoint || presentation && (presentation.kind === 'privacy_opt_in' || presentation.requiresOptIn === true
            || presentation.kind === 'model' && presentation.movingAliasRequiresOptIn === true) ? async (settings, value, _services, context) => {
            const { storage } = await import('@/sync/domains/state/storage');
            const scope = storage.getState().settingsScope;
            const isCurrent = () => !context?.signal?.aborted
                && context?.isCurrent() !== false
                && areAccountSettingsScopesEqual(storage.getState().settingsScope, scope)
                && voiceSettingsDeclarationRegistry.get(entry.providerId)?.providerSettings === descriptor;
            if (!isCurrent()) return null;
            if (preparesEndpoint) {
                if (typeof value !== 'string') return null;
                const { prepareSpeechEndpointSettingChange } = await import('./panels/bundledSpeech/prepareEndpointSettingChange');
                const intent = await prepareSpeechEndpointSettingChange({ entry, settings, value, isCurrent, signal: context?.signal });
                return intent ? (latest) => isCurrent() ? intent(latest) : null : null;
            }
            if (presentation) {
                const { confirmRealtimeProviderSettingChange } = await import('./panels/realtime/confirmRealtimeProviderSettingChange');
                if (!await confirmRealtimeProviderSettingChange({ field: presentation, value: decode(value), isCurrent, signal: context?.signal })) return null;
            }
            return (settings) => isCurrent() ? mutate(settings, value) : null;
        } : undefined,
    };
}

/** Projection of the admitted registry, not a second field catalog or provider-id table. */
export function getVoiceContributedSettingsDeclarations(
    registry: VoiceProviderRegistry = voiceSettingsDeclarationRegistry,
    localize?: PluginLocalizedTextResolver,
) {
    return registry.list().flatMap((entry) => {
        const descriptor = entry.providerSettings;
        if (!descriptor) return [];
        const declaration = 'declaration' in entry ? entry.declaration : undefined;
        const endpointConsent = readBundledSpeechSettingsDescriptorFromEntry(entry.providerId, entry)?.endpointConsent;
        const label = (value: unknown) => entry.source.kind !== 'external' && typeof value === 'string'
            ? String(tLoose(value))
            : localize?.(entry.pluginId, value) ?? resolvePluginLocalizedText({ projection: null, pluginId: entry.pluginId, value });
        const fields: Record<string, SettingDeclaration> = {};
        const add = (path: string, title: unknown, description: unknown, sensitive = false) => {
            fields[`provider.${entry.providerId}.${path}`] = {
                titleKey: 'settingsVoice.providerSectionTitle', title: label(title) || path,
                ...(declaration ? { contribution: { pluginId: entry.pluginId, localId: declaration.id } } : {}),
                ...(description ? { description: label(description) } : {}),
                ...(sensitive ? { sensitive: true, operation: { kind: 'interaction', requiresHumanInteraction: true } as const } : { storage: providerFieldBinding(entry, path, endpointConsent?.baseUrlFieldId === path) }),
            };
        };
        for (const field of descriptor.fields) {
            if (!field.presentation?.control || field.presentation.hidden) continue;
            add(field.id, field.title, field.description, Boolean(field.secret));
        }
        for (const field of descriptor.presentation?.fields ?? []) {
            // Welcome is the shared Voice Greeting, not provider configuration.
            if (field.kind === 'welcome') continue;
            add(field.path, field.titleKey ?? fields[`provider.${entry.providerId}.${field.path}`]?.title ?? field.path, field.subtitleKey);
            if (entry.kind === 'voice.conversation-provider.v1' && (field.kind === 'voice_catalog' || field.kind === 'remote_voice')) {
                for (const operation of ['preview', 'stop'] as const) {
                    fields[`provider.${entry.providerId}.${field.path}.${operation === 'stop' ? 'stopPreview' : 'preview'}`] = {
                        titleKey: 'settingsVoice.providerSectionTitle',
                        title: `${label(field.titleKey ?? field.path)} · ${String(tLoose(operation === 'stop' ? 'common.stop' : 'common.preview'))}`,
                        operation: { kind: 'invoke', requiresHumanInteraction: operation === 'preview', requiresApproval: operation === 'preview',
                            invoke: async context => {
                                const { invokeVoiceCatalogSettingsOperation } = await import('./voiceCatalogSettingsOperation');
                                return invokeVoiceCatalogSettingsOperation(entry, registry, operation, context);
                            },
                        },
                    };
                }
            }
            for (const subfield of 'subfields' in field ? field.subfields ?? [] : []) add(subfield.path, subfield.titleKey ?? subfield.path, subfield.subtitleKey);
        }
        for (const action of declaration?.settings?.actions ?? []) {
            fields[`provider.${entry.providerId}.action.${action.id}`] = {
                titleKey: 'settingsVoice.providerSectionTitle', title: label(action.title),
                ...(declaration ? { contribution: { pluginId: entry.pluginId, localId: declaration.id } } : {}),
                operation: {
                    kind: 'invoke', requiresHumanInteraction: true,
                    invoke: async ({ signal, isCurrent }) => {
                        if (!isCurrent()) return { status: 'unavailable', reason: 'provider_retired' };
                        if (registry.get(entry.providerId)?.providerSettings !== descriptor) return { status: 'unavailable', reason: 'provider_retired' };
                        const { invokeVoiceProviderSettingsAction } = await import('./voiceProviderSettingsActionInvoker');
                        return await invokeVoiceProviderSettingsAction({ providerId: entry.providerId, declaration: action, signal, isCurrent,
                            owner: { schemaVersion: descriptor.schemaVersion, defaultConfig: descriptor.defaultConfig, parseConfig: (value) => { const parsed = descriptor.parseConfig(value); return record(parsed) ? parsed : null; } },
                        });
                    },
                },
            };
        }
        if (descriptor.connectedServicesBinding) {
            const binding = descriptor.connectedServicesBinding;
            fields[`provider.${entry.providerId}.${binding.id}`] = { titleKey: 'settingsVoice.providerSectionTitle', title: label(binding.title), description: binding.description ? label(binding.description) : undefined, sensitive: true, operation: { kind: 'interaction', requiresHumanInteraction: true } };
        }
        const credential = descriptor.presentation?.credential;
        const credentials = declaration?.credentials;
        if (credential?.kind === 'api_key' || credentials?.sources.some((source) => source.kind === 'savedSecret')) fields[`provider.${entry.providerId}.credential`] = {
            titleKey: 'settingsVoice.externalCredentials.apiKeyTitle',
            ...(credential?.kind === 'api_key' && credential.titleKey ? { title: label(credential.titleKey) } : {}), sensitive: true, operation: { kind: 'interaction', requiresHumanInteraction: true },
        };
        if (credentials?.sources.some((source) => source.kind === 'connectedAccount')) fields[`provider.${entry.providerId}.credentialSource`] = {
            titleKey: 'settingsVoice.realtimeProviders.authentication.title', descriptionKey: 'settingsVoice.realtimeProviders.authentication.subtitle', sensitive: true, operation: { kind: 'interaction', requiresHumanInteraction: true },
        };
        if (declaration) for (const id of Object.keys(fields)) fields[id] = {
            ...fields[id]!, contribution: { pluginId: entry.pluginId, localId: declaration.id },
        };
        const pages: SettingsPageId[] = [];
        if (entry.roles.includes('dictation_stt')) pages.push('voiceDictation');
        if (entry.kind === 'voice.conversation-provider.v1' || entry.roles.includes('conversation_stt') || entry.roles.includes('conversation_tts')) pages.push('voiceConversations');
        return pages.map((pageId) => defineSettingsPage({ pageId, sections: { [`provider.${entry.providerId}`]: { settings: fields } } }));
    });
}
