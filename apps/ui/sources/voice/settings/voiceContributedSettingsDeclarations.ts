import { defineSettingsPage, SETTING_VALUE_UNAVAILABLE, parseSettingScalarValue, type SettingDeclaration, type SettingStorageBinding } from '@/components/settings/catalog/settingDeclarations';
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
import type { SettingValue } from '@/components/settings/catalog/settingDeclarations';
import { readBundledSpeechSettingsDescriptorFromEntry } from './panels/bundledSpeech/descriptor';
import { buildQualifiedPluginContributionKey, type PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type { VoiceProviderContribution } from '@happier-dev/protocol/plugins/contributions/voice';

export const voiceSettingsDeclarationRegistry = createDefaultVoiceProviderRegistry();

function voiceSettingsPageIds(roles: readonly string[], conversation: boolean): SettingsPageId[] {
    const pages: SettingsPageId[] = [];
    if (roles.includes('dictation_stt')) pages.push('voiceDictation');
    if (conversation || roles.includes('conversation_stt') || roles.includes('conversation_tts')) pages.push('voiceConversations');
    return pages;
}

export function voiceCredentialSettingAnchor(contribution: PluginContributionIdentityV1, declaration: VoiceProviderContribution,
    field: 'credential' | 'credentialSource'): string | null {
    const page = voiceSettingsPageIds(declaration.roles, declaration.kind === 'conversation')[0];
    return page ? `${page}.provider.${buildQualifiedPluginContributionKey(contribution)}.${field}` : null;
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Only published field/presentation paths can create a binding; Action input never supplies a path. */
function providerFieldBinding(
    entry: VoiceProviderRegistryEntry,
    path: string,
    preparesEndpoint: boolean,
    presentation: RealtimeSettingsFieldDescriptor | undefined,
): SettingStorageBinding | undefined {
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
    const compound = record(defaultValue) || Array.isArray(defaultValue)
        || published?.presentation?.control === 'json'
        || publishedType === 'object' || publishedType === 'array'
        || Array.isArray(publishedType) && publishedType.some((type) => type === 'object' || type === 'array');
    const decode = (value: unknown): unknown => {
        if (!compound) return value;
        if (typeof value !== 'string') return undefined;
        try { return JSON.parse(value) as unknown; } catch { return undefined; }
    };
    const parse = (value: unknown) => {
        const scalar = parseSettingScalarValue(value);
        const candidate = scalar.success ? decode(scalar.value) : undefined;
        return scalar.success && candidate !== undefined
            && updateRealtimeProviderConfig(owner, descriptor.defaultConfig, segments, candidate)
            ? scalar : { success: false as const };
    };
    const mutate = (settings: Settings, value: SettingValue) => {
        const parsed = parse(value);
        if (!parsed.success) return null;
        if (voiceSettingsDeclarationRegistry.get(entry.providerId)?.providerSettings !== descriptor) return null;
        const envelope = settings.voice.providers[entry.providerId];
        if (envelope && envelope.schemaVersion !== descriptor.schemaVersion) return null;
        const config = envelope ? readVoiceProviderSettingsConfig(settings.voice, entry.providerId) : descriptor.defaultConfig;
        if (!config) return null;
        const next = updateRealtimeProviderConfig(owner, config, segments, decode(parsed.value));
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
        parse,
        mutate,
        prepare: preparesEndpoint || presentation && (presentation.kind === 'privacy_opt_in' || presentation.requiresOptIn === true
            || presentation.kind === 'model' && presentation.movingAliasRequiresOptIn === true) ? async (settings, value, _services, context) => {
            const parsed = parse(value);
            if (!parsed.success) return null;
            const { storage } = await import('@/sync/domains/state/storage');
            const scope = storage.getState().settingsScope;
            const isCurrent = () => !context?.signal?.aborted
                && context?.isCurrent() !== false
                && areAccountSettingsScopesEqual(storage.getState().settingsScope, scope)
                && voiceSettingsDeclarationRegistry.get(entry.providerId)?.providerSettings === descriptor;
            if (!isCurrent()) return null;
            if (preparesEndpoint) {
                if (typeof parsed.value !== 'string') return null;
                const { prepareSpeechEndpointSettingChange } = await import('./panels/bundledSpeech/prepareEndpointSettingChange');
                const intent = await prepareSpeechEndpointSettingChange({ entry, settings, value: parsed.value, isCurrent, signal: context?.signal });
                return intent ? (latest) => isCurrent() ? intent(latest) : null : null;
            }
            if (presentation) {
                const { confirmRealtimeProviderSettingChange } = await import('./panels/realtime/confirmRealtimeProviderSettingChange');
                if (!await confirmRealtimeProviderSettingChange({ field: presentation, value: decode(parsed.value), isCurrent, signal: context?.signal })) return null;
            }
            return (settings) => isCurrent() ? mutate(settings, parsed.value) : null;
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
        const declaration = 'declaration' in entry ? entry.declaration : undefined;
        if (!descriptor && !declaration?.credentials) return [];
        const speechSettings = readBundledSpeechSettingsDescriptorFromEntry(entry.providerId, entry);
        const endpointConsent = speechSettings?.endpointConsent;
        const presentationFields = descriptor?.presentation
            ? parseRealtimeSettingsDescriptor(entry.providerId, descriptor.presentation)?.fields.flatMap((field) => [
                field, ...(Array.isArray(field.subfields) ? field.subfields as readonly RealtimeSettingsFieldDescriptor[] : []),
            ]) ?? []
            : [];
        const label = (value: unknown) => entry.source.kind !== 'external' && typeof value === 'string'
            ? String(tLoose(value))
            : localize?.(entry.pluginId, value) ?? resolvePluginLocalizedText({ projection: null, pluginId: entry.pluginId, value });
        const fields: Record<string, SettingDeclaration> = {};
        const add = (path: string, title: unknown, description: unknown, sensitive = false) => {
            fields[`provider.${entry.providerId}.${path}`] = {
                titleKey: 'settingsVoice.providerSectionTitle', title: label(title) || path,
                ...(declaration ? { contribution: { pluginId: entry.pluginId, localId: declaration.id } } : {}),
                ...(description ? { description: label(description) } : {}),
                ...(sensitive ? { sensitive: true, operation: { kind: 'interaction', requiresHumanInteraction: true } as const } : { storage: providerFieldBinding(
                    entry, path, endpointConsent?.baseUrlFieldId === path, presentationFields.find((field) => field.path === path),
                ) }),
            };
        };
        const addCatalogOperations = (path: string, title: unknown) => {
            for (const operation of ['preview', 'stop', 'list', 'retry'] as const) {
                const operationId = { preview: 'preview', stop: 'stopPreview', list: 'listCatalog', retry: 'retryCatalog' }[operation];
                const operationTitle = { preview: 'common.preview', stop: 'common.stop', list: 'common.search', retry: 'common.retry' } as const;
                fields[`provider.${entry.providerId}.${path}.${operationId}`] = {
                    titleKey: 'settingsVoice.providerSectionTitle',
                    title: `${label(title)} · ${String(tLoose(operationTitle[operation]))}`,
                    operation: { kind: 'invoke', requiresHumanInteraction: operation === 'preview', requiresApproval: operation === 'preview', uiConfirmation: 'direct',
                        invoke: async context => {
                            const { invokeVoiceCatalogSettingsOperation } = await import('./voiceCatalogSettingsOperation');
                            return invokeVoiceCatalogSettingsOperation(entry, registry, operation, context);
                        },
                    },
                };
            }
        };
        for (const field of descriptor?.fields ?? []) {
            if (!field.presentation?.control || field.presentation.hidden) continue;
            add(field.id, field.title, field.description, Boolean(field.secret));
        }
        for (const field of descriptor?.presentation?.fields ?? []) {
            // Welcome is the shared Voice Greeting, not provider configuration.
            if (field.kind === 'welcome') continue;
            add(field.path, field.titleKey ?? fields[`provider.${entry.providerId}.${field.path}`]?.title ?? field.path, field.subtitleKey);
            if (entry.kind === 'voice.conversation-provider.v1' && (field.kind === 'voice_catalog' || field.kind === 'remote_voice')) {
                addCatalogOperations(field.path, field.titleKey ?? field.path);
            }
            for (const subfield of 'subfields' in field ? field.subfields ?? [] : []) add(subfield.path, subfield.titleKey ?? subfield.path, subfield.subtitleKey);
        }
        if (entry.kind === 'voice.speech-engine.v1') for (const catalog of entry.declaration?.catalogs ?? []) {
            if (catalog.kind === 'voices') addCatalogOperations(catalog.settingFieldId,
                descriptor?.fields.find(field => field.id === catalog.settingFieldId)?.title ?? catalog.settingFieldId);
        }
        if (descriptor) for (const action of declaration?.settings?.actions ?? []) {
            fields[`provider.${entry.providerId}.action.${action.id}`] = {
                titleKey: 'settingsVoice.providerSectionTitle', title: label(action.title),
                ...(declaration ? { contribution: { pluginId: entry.pluginId, localId: declaration.id } } : {}),
                operation: {
                    kind: 'invoke', requiresHumanInteraction: true, uiConfirmation: 'direct',
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
        if (descriptor?.connectedServicesBinding) {
            const binding = descriptor.connectedServicesBinding;
            fields[`provider.${entry.providerId}.${binding.id}`] = { titleKey: 'settingsVoice.providerSectionTitle', title: label(binding.title), description: binding.description ? label(binding.description) : undefined, sensitive: true,
                operation: { kind: 'invoke', requiresHumanInteraction: false, requiresApproval: false,
                    invoke: async context => (await import('./voiceConnectedServicesSettingsOperation')).invokeVoiceConnectedServicesSettingsOperation(entry, registry, context),
                },
            };
        }
        const credential = descriptor?.presentation?.credential;
        const credentials = declaration?.credentials;
        if (credential?.kind === 'api_key' || credentials?.sources.some((source) => source.kind === 'savedSecret')) fields[`provider.${entry.providerId}.credential`] = {
            titleKey: 'settingsVoice.externalCredentials.apiKeyTitle',
            ...(credential?.kind === 'api_key' && credential.titleKey ? { title: label(credential.titleKey) } : {}), sensitive: true,
            operation: { kind: 'invoke', requiresHumanInteraction: false, requiresApproval: true, uiConfirmation: 'direct',
                invoke: async context => (await import('./voiceSavedSecretSettingsOperation')).invokeVoiceSavedSecretSettingsOperation(entry, registry, context),
            },
        };
        if (credentials?.sources.some((source) => source.kind === 'connectedAccount')) fields[`provider.${entry.providerId}.credentialSource`] = {
            titleKey: 'settingsVoice.realtimeProviders.authentication.title', descriptionKey: 'settingsVoice.realtimeProviders.authentication.subtitle', sensitive: true,
            operation: { kind: 'invoke', requiresHumanInteraction: false, requiresApproval: false,
                invoke: async context => {
                    const { invokeVoiceCredentialSourceSettingsOperation } = await import('./voiceCredentialSourceSettingsOperation');
                    return invokeVoiceCredentialSourceSettingsOperation(entry, registry, context);
                },
            },
        };
        if (declaration) for (const id of Object.keys(fields)) fields[id] = {
            ...fields[id]!, contribution: { pluginId: entry.pluginId, localId: declaration.id },
        };
        const pages = voiceSettingsPageIds(entry.roles, entry.kind === 'voice.conversation-provider.v1');
        // The section carries the service's own name, so search says which service a control belongs to.
        const serviceTitle = declaration ? label(declaration.title) : String(tLoose(entry.selectionOptions?.[0]?.titleKey ?? 'settingsVoice.providerSectionTitle'));
        return pages.map((pageId) => defineSettingsPage({ pageId, sections: { [`provider.${entry.providerId}`]: {
            ...(serviceTitle ? { title: serviceTitle } : {}),
            settings: pageId === 'voiceDictation'
                ? Object.fromEntries(Object.entries(fields).filter(([id]) => !speechSettings?.fields.some(field =>
                    field.kind === 'language' && id === `provider.${entry.providerId}.${field.key}`)))
                : fields,
        } } }));
    });
}
