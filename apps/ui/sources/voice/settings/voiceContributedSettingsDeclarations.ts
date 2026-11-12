import { getSettingsDeclarationCatalogV1, voiceSettingsPageIds } from '@happier-dev/protocol/actions/settings/settingsDeclarationCatalog';
import { createVoiceProviderFieldBinding } from '@happier-dev/protocol/voice/settings/providerFieldBinding';
import { defineSettingsPage, SETTING_VALUE_UNAVAILABLE, type SettingDeclaration, type SettingStorageBinding } from '@/components/settings/catalog/settingDeclarations';
import type { SettingsPageId } from '@/components/settings/catalog/types';
import { voiceSettingsOwner } from '@/sync/domains/settings/voiceSettings';
import { resolvePluginLocalizedText, type PluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { tLoose } from '@/text';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import type { VoiceProviderRegistry, VoiceProviderRegistryEntry } from '@/voice/registry/providerRegistry';
import { parseRealtimeSettingsDescriptor, type RealtimeSettingsFieldDescriptor } from './panels/realtime/descriptor';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import type { Settings } from '@/sync/domains/settings/settings';
import { readBundledSpeechSettingsDescriptorFromEntry } from './panels/bundledSpeech/descriptor';
import { buildQualifiedPluginContributionKey, type PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type { VoiceProviderContribution } from '@happier-dev/protocol/plugins/contributions/voice';

export const voiceSettingsDeclarationRegistry = createDefaultVoiceProviderRegistry();

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
    registry: VoiceProviderRegistry,
): SettingStorageBinding | undefined {
    const descriptor = entry.providerSettings;
    if (!descriptor) return undefined;
    const binding = createVoiceProviderFieldBinding<Settings>({ entry, path, owner: voiceSettingsOwner,
        registry, unavailableValue: SETTING_VALUE_UNAVAILABLE });
    if (!binding) return undefined;
    const { decode, ...storage } = binding;
    const { parse, mutate } = storage;
    return {
        ...storage,
        prepare: preparesEndpoint || presentation && (presentation.kind === 'privacy_opt_in' || presentation.requiresOptIn === true
            || presentation.kind === 'model' && presentation.movingAliasRequiresOptIn === true) ? async (settings, value, _services, context) => {
            const parsed = parse(value);
            if (!parsed.success) return null;
            const { storage } = await import('@/sync/domains/state/storage');
            const scope = storage.getState().settingsScope;
            const isCurrent = () => !context?.signal?.aborted
                && context?.isCurrent() !== false
                && areAccountSettingsScopesEqual(storage.getState().settingsScope, scope)
                && registry.get(entry.providerId)?.providerSettings === descriptor;
            if (!isCurrent()) return null;
            if (preparesEndpoint) {
                if (typeof parsed.value !== 'string') return null;
                const { prepareSpeechEndpointSettingChange } = await import('./panels/bundledSpeech/prepareEndpointSettingChange');
                const intent = await prepareSpeechEndpointSettingChange({ entry, settings, value: parsed.value, isCurrent, signal: context?.signal });
                return intent ? (latest) => isCurrent() ? intent(latest) : null : null;
            }
            if (presentation) {
                const { confirmRealtimeProviderSettingChange } = await import('./panels/realtime/confirmRealtimeProviderSettingChange');
                const normalized = parseRealtimeSettingsDescriptor(entry.providerId, descriptor.presentation)?.fields.flatMap(field => [field, ...(field.subfields as readonly RealtimeSettingsFieldDescriptor[] | undefined ?? [])]).find(field => field.path === path);
                if (!normalized || !await confirmRealtimeProviderSettingChange({ field: normalized, value: decode(parsed.value), isCurrent, signal: context?.signal })) return null;
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
    const label = (entry: Pick<VoiceProviderRegistryEntry, 'providerId'>, value: unknown) => {
        const current = registry.get(entry.providerId);
        return current?.source.kind !== 'external' && typeof value === 'string'
            ? String(tLoose(value))
            : localize?.(current?.pluginId ?? '', value) ?? resolvePluginLocalizedText({ projection: null, pluginId: current?.pluginId ?? '', value });
    };
    const catalog = getSettingsDeclarationCatalogV1(registry, label);
    const speechDeclarations = new Map(registry.list().map(entry => [entry.providerId, readBundledSpeechSettingsDescriptorFromEntry(entry.providerId, entry)]));
    const pages = new Map<string, { pageId: SettingsPageId; section: string; title: string; fields: Record<string, SettingDeclaration> }>();
    for (const row of catalog) {
        if (!row.contribution || row.pageId !== 'voiceDictation' && row.pageId !== 'voiceConversations') continue;
        const providerId = row.storage?.owner === 'voiceProviderFieldBinding' ? row.storage.options?.[0] : row.operation?.options?.[0];
        // Secret scalar fields have no executable binding; their contribution identifies their provider.
        const entry = registry.get(typeof providerId === 'string' ? providerId : buildQualifiedPluginContributionKey(row.contribution));
        if (!entry) continue;
        const descriptor = entry.providerSettings;
        const path = row.storage?.options?.[1];
        const field: { -readonly [K in keyof SettingDeclaration]: SettingDeclaration[K] } = { titleKey: 'settingsVoice.providerSectionTitle', title: row.title,
            ...(row.description ? { description: row.description } : {}), contribution: row.contribution,
            ...(row.sensitive ? { sensitive: true } : {}),
        };
        if (descriptor && typeof path === 'string') {
            const speech = speechDeclarations.get(entry.providerId);
            // Normalize UI consent details only when the person invokes a field requiring consent.
            const raw = row.providerFieldPresentation;
            const requiresConsent = raw && (raw.kind === 'privacy_opt_in' || raw.requiresOptIn === true
                || raw.kind === 'model' && raw.movingAliasRequiresOptIn === true);
            const presentation = requiresConsent ? { ...raw, pathSegments: path.split('.') } : undefined;
            field.storage = providerFieldBinding(entry, path, speech?.endpointConsent?.baseUrlFieldId === path, presentation, registry);
        }
        const operation = row.operation;
        if (operation) field.operation = operation.kind === 'interaction'
            ? { kind: 'interaction', requiresHumanInteraction: true }
            : { kind: 'invoke', requiresHumanInteraction: operation.requiresHumanInteraction,
                ...(operation.requiresApproval === undefined ? {} : { requiresApproval: operation.requiresApproval }),
                ...(operation.uiConfirmation ? { uiConfirmation: operation.uiConfirmation } : {}),
                invoke: async context => {
                    switch (operation.owner) {
                        case 'voiceCatalogSettingsOperation': {
                            const action = operation.options?.[2];
                            if (action !== 'preview' && action !== 'stop' && action !== 'list' && action !== 'retry') return { status: 'unavailable', reason: 'provider_retired' };
                            return (await import('./voiceCatalogSettingsOperation')).invokeVoiceCatalogSettingsOperation(entry, registry, action, context);
                        }
                        case 'voiceProviderSettingsAction': {
                            const action = entry.declaration?.settings?.actions?.find(action => action.id === operation.options?.[1]);
                            if (!descriptor || !action || !context.isCurrent() || registry.get(entry.providerId)?.providerSettings !== descriptor) return { status: 'unavailable', reason: 'provider_retired' };
                            return (await import('./voiceProviderSettingsActionInvoker')).invokeVoiceProviderSettingsAction({ providerId: entry.providerId, declaration: action,
                                signal: context.signal, isCurrent: context.isCurrent,
                                owner: { schemaVersion: descriptor.schemaVersion, defaultConfig: descriptor.defaultConfig, parseConfig: value => {
                                    const parsed = descriptor.parseConfig(value); return record(parsed) ? parsed : null;
                                } },
                            });
                        }
                        case 'voiceConnectedServicesSettingsOperation': return (await import('./voiceConnectedServicesSettingsOperation')).invokeVoiceConnectedServicesSettingsOperation(entry, registry, context);
                        case 'voiceSavedSecretSettingsOperation': return (await import('./voiceSavedSecretSettingsOperation')).invokeVoiceSavedSecretSettingsOperation(entry, registry, context);
                        case 'voiceCredentialSourceSettingsOperation': return (await import('./voiceCredentialSourceSettingsOperation')).invokeVoiceCredentialSourceSettingsOperation(entry, registry, context);
                        default: return { status: 'unavailable', reason: 'provider_retired' };
                    }
                },
            };
        const key = `${row.pageId}.${entry.providerId}`;
        const page = pages.get(key) ?? { pageId: row.pageId, section: `provider.${entry.providerId}`,
            title: entry.declaration ? label(entry, entry.declaration.title) : '', fields: {} };
        page.fields[row.anchor.slice(row.pageId.length + 1)] = field;
        pages.set(key, page);
    }
    return [...pages.values()].map(page => defineSettingsPage({ pageId: page.pageId,
        sections: { [page.section]: { title: page.title, settings: page.fields } } }));
}
