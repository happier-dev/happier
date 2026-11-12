import { BUILT_IN_SETTINGS_DECLARATIONS_V1, readBuiltInSettingDeclarationV1, type PortableSettingDeclarationV1 } from './settingsDeclarations.js';
import { VoiceProviderSettingsPresentationSchema, type VoiceProviderSettingsPresentationField } from '../../plugins/contributions/voiceProviders.js';
import type { VoiceSettingsRegistry, VoiceSettingsRegistryEntry } from '../../voice/settings/providerRegistry.js';
import type { PluginContributionIdentityV1 } from '../../plugins/contributionIdentity.js';

export type SettingsCatalogDeclarationV1 = PortableSettingDeclarationV1 & Readonly<{
    contribution?: PluginContributionIdentityV1;
    providerFieldPresentation?: VoiceProviderSettingsPresentationField | NonNullable<VoiceProviderSettingsPresentationField['subfields']>[number];
}>;

export function voiceSettingsPageIds(roles: readonly string[], conversation: boolean): ('voiceDictation' | 'voiceConversations')[] {
    const pages: ('voiceDictation' | 'voiceConversations')[] = [];
    if (roles.includes('dictation_stt')) pages.push('voiceDictation');
    if (conversation || roles.includes('conversation_stt') || roles.includes('conversation_tts')) pages.push('voiceConversations');
    return pages;
}

/** One catalog for host preferences and the currently loaded plugin declarations.
 * Hosts attach executable bindings and localized labels; they do not select fields again.
 */
export function getSettingsDeclarationCatalogV1(registry: VoiceSettingsRegistry, localize?: (entry: VoiceSettingsRegistryEntry, value: unknown) => string): readonly SettingsCatalogDeclarationV1[] {
    return [...BUILT_IN_SETTINGS_DECLARATIONS_V1, ...registry.list().flatMap(entry => projectContributedDeclarations(entry, localize))];
}

export function readSettingsCatalogDeclarationV1(catalog: readonly SettingsCatalogDeclarationV1[], anchor: string): SettingsCatalogDeclarationV1 | null {
    // Retain built-in aliases and the mounted editor's private declaration, excluded from discovery.
    return catalog.find(item => item.anchor === anchor) ?? readBuiltInSettingDeclarationV1(anchor);
}

function projectContributedDeclarations(entry: VoiceSettingsRegistryEntry, localize?: (entry: VoiceSettingsRegistryEntry, value: unknown) => string): SettingsCatalogDeclarationV1[] {
    const descriptor = entry.providerSettings;
    const declaration = entry.declaration;
    if (!declaration || !entry.pluginId || !descriptor && !declaration.credentials) return [];
    const contribution = { pluginId: entry.pluginId, localId: declaration.id };
    const presentation = descriptor?.presentation ? VoiceProviderSettingsPresentationSchema.safeParse(descriptor.presentation) : null;
    const fields = new Map<string, Omit<SettingsCatalogDeclarationV1, 'anchor' | 'pageId' | 'sectionId'>>();
    const text = (value: unknown, fallback = '') => localize ? localize(entry, value) || fallback : typeof value === 'string' ? value
        : value && typeof value === 'object' && 'fallback' in value && typeof value.fallback === 'string' ? value.fallback : fallback;
    const add = (path: string, title: unknown, description?: unknown,
        providerFieldPresentation?: SettingsCatalogDeclarationV1['providerFieldPresentation']) => {
        const id = `provider.${entry.providerId}.${path}`;
        const sensitive = Boolean(descriptor?.fields.find(field => field.id === path)?.secret);
        fields.set(id, { titleKey: 'settingsVoice.providerSectionTitle', title: text(title, path),
            ...(description ? { description: text(description) } : {}), contribution, sensitive, targetKinds: [],
            ...(providerFieldPresentation ? { providerFieldPresentation } : {}),
            ...(sensitive ? { storage: { scope: 'account', kind: 'owner', access: 'sensitive' },
                operation: { kind: 'interaction', requiresHumanInteraction: true } }
                : { storage: { scope: 'account', kind: 'owner', access: 'read_write',
                    owner: 'voiceProviderFieldBinding', options: [entry.providerId, path] } }),
        });
    };
    const operation = (path: string, title: unknown, owner: string, options: readonly string[],
        metadata: Pick<NonNullable<SettingsCatalogDeclarationV1['operation']>, 'requiresHumanInteraction' | 'requiresApproval' | 'uiConfirmation'>,
        sensitive = false, description?: unknown) => fields.set(`provider.${entry.providerId}.${path}`, {
        titleKey: 'settingsVoice.providerSectionTitle', title: text(title, path), contribution, sensitive, targetKinds: [],
        ...(description ? { description: text(description) } : {}),
        ...(sensitive ? { storage: { scope: 'account', kind: 'owner', access: 'sensitive' } as const } : {}),
        operation: { kind: 'invoke', owner, options: [entry.providerId, ...options], ...metadata },
    });
    const catalog = (path: string, title: unknown) => {
        for (const [id, action, label] of [['preview', 'preview', 'common.preview'], ['stopPreview', 'stop', 'common.stop'],
            ['listCatalog', 'list', 'common.search'], ['retryCatalog', 'retry', 'common.retry']] as const) {
            operation(`${path}.${id}`, `${text(title, path)} · ${text(label)}`, 'voiceCatalogSettingsOperation', [path, action],
                { requiresHumanInteraction: action === 'preview', requiresApproval: action === 'preview', uiConfirmation: 'direct' });
        }
    };
    for (const field of descriptor?.fields ?? []) {
        if (field.presentation?.control && !field.presentation.hidden) add(field.id, field.title, field.description);
    }
    if (presentation?.success) for (const field of presentation.data.fields) {
        if (field.kind === 'welcome') continue;
        add(field.path, field.titleKey ?? fields.get(`provider.${entry.providerId}.${field.path}`)?.title ?? field.path, field.subtitleKey, field);
        if (entry.kind === 'voice.conversation-provider.v1' && (field.kind === 'voice_catalog' || field.kind === 'remote_voice')) catalog(field.path, field.titleKey ?? field.path);
        for (const subfield of field.subfields ?? []) add(subfield.path, subfield.titleKey ?? subfield.path, subfield.subtitleKey, subfield);
    }
    if (declaration.kind === 'speech') for (const item of declaration.catalogs ?? []) {
        if (item.kind === 'voices') catalog(item.settingFieldId, descriptor?.fields.find(field => field.id === item.settingFieldId)?.title ?? item.settingFieldId);
    }
    if (descriptor) for (const action of declaration.settings?.actions ?? []) {
        operation(`action.${action.id}`, action.title, 'voiceProviderSettingsAction', [action.id],
            { requiresHumanInteraction: true, uiConfirmation: 'direct' });
    }
    if (descriptor?.connectedServicesBinding) {
        const binding = descriptor.connectedServicesBinding;
        operation(binding.id, binding.title, 'voiceConnectedServicesSettingsOperation', [],
            { requiresHumanInteraction: false, requiresApproval: false }, true, binding.description);
    }
    const credentials = declaration.credentials;
    if (descriptor?.presentation?.credential.kind === 'api_key' || credentials?.sources.some(source => source.kind === 'savedSecret')) {
        operation('credential', descriptor?.presentation?.credential.titleKey ?? 'settingsVoice.externalCredentials.apiKeyTitle',
            'voiceSavedSecretSettingsOperation', [], { requiresHumanInteraction: false, requiresApproval: true, uiConfirmation: 'direct' }, true);
    }
    if (credentials?.sources.some(source => source.kind === 'connectedAccount')) {
        operation('credentialSource', 'settingsVoice.realtimeProviders.authentication.title', 'voiceCredentialSourceSettingsOperation', [],
            { requiresHumanInteraction: false, requiresApproval: false }, true,
            'settingsVoice.realtimeProviders.authentication.subtitle');
    }
    return voiceSettingsPageIds(entry.roles, entry.kind === 'voice.conversation-provider.v1').flatMap(pageId =>
        [...fields].flatMap(([id, field]) => {
            // Speech invocation takes Dictation recognition language from its single host preference.
            if (pageId === 'voiceDictation' && declaration.kind === 'speech' && id === `provider.${entry.providerId}.language`) return [];
            return [{ ...field, pageId, anchor: `${pageId}.${id}`, sectionId: `${pageId}.provider.${entry.providerId}` }];
        }));
}
