import { describe, expect, it } from 'vitest';

import { resolveVoiceStartAdmission } from './resolveVoiceStartAdmission';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { BUILT_IN_VOICE_UI_ENTRIES } from '@/voice/registry/builtInEntries';
import { createVoiceProviderRegistry, projectVoiceProviderSettings } from '@/voice/registry/providerRegistry';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { settingsParse } from '@/sync/domains/settings/settings';
import { resolveVoiceProviderIdForBindingScope } from '@/voice/settings/resolveVoiceProviderId';
import { saveAndUseAccountVoiceCredential } from '@/voice/credentials/accountVoiceCredential';

const settings = voiceSettingsParse({ providerId: 'local_conversation', providers: {
    local_conversation: { schemaVersion: 1, config: { conversationMode: 'agent' } },
} });

function registry(supportedPlatforms: readonly ('web' | 'ios' | 'android')[]) {
    return createVoiceProviderRegistry({
        builtIn: BUILT_IN_VOICE_UI_ENTRIES.map((entry) => entry.providerId === 'local_conversation'
            ? { ...entry, supportedPlatforms }
            : entry),
    });
}

describe('resolveVoiceStartAdmission', () => {
    it('keeps Grok setup required across catalog hydration when no credential is selected', () => {
        const registry = createDefaultVoiceProviderRegistry();
        const providerId = 'happier.voice.xai/realtime-grok';
        const entry = registry.get(providerId);
        if (!entry?.providerSettings) throw new Error('Grok declaration unavailable');
        const settings = settingsParse({ voice: { providerId, providers: {
            [providerId]: { schemaVersion: entry.providerSettings.schemaVersion, config: entry.providerSettings.defaultConfig },
        } } });
        expect(projectVoiceProviderSettings(entry, settings.voice.providers[providerId])).toMatchObject({ status: 'ready' });
        expect(resolveVoiceProviderIdForBindingScope(settings.voice, 'global', registry)).toBe(providerId);
        expect(entry.supportedPlatforms).toContain('web');
        const project = (connectedPurposes: null | { v: 1; bindings: [] }) => resolveVoiceStartAdmission({
            bindingScope: 'global', daemonLocalVoiceUnavailable: false, globalStartAuthorized: true,
            providerId, platform: 'web', providerSettings: registry.get(providerId)?.providerSettings ?? null,
            registry, startSessionId: null, voiceSettings: settings.voice,
            credentialContext: { settings, connectedPurposes },
        });
        expect(project(null).canStart).toBe(false);
        expect(project({ v: 1, bindings: [] }).canStart).toBe(false);
        if (entry.kind !== 'voice.conversation-provider.v1' || !entry.declaration?.credentials) throw new Error('Grok credential declaration unavailable');
        const configured = saveAndUseAccountVoiceCredential({ settings,
            contribution: { pluginId: entry.pluginId, localId: entry.declaration.id },
            credentialSlotId: entry.declaration.credentials.slot.id, currentDeclaration: entry.declaration,
            expectedSettingsVersion: 0, expectedSecretId: null, expectedSecretUpdatedAt: null,
            value: 'test-credential', generateId: () => 'grok-test-secret', now: 1,
        }).settings;
        expect(resolveVoiceStartAdmission({ bindingScope: 'global', daemonLocalVoiceUnavailable: false,
            globalStartAuthorized: true, providerId, platform: 'web', providerSettings: entry.providerSettings,
            registry, startSessionId: null, voiceSettings: configured.voice,
            credentialContext: { settings: configured, connectedPurposes: { v: 1, bindings: [] } },
        }).canStart).toBe(true);
    });
    it('fails start admission before runtime lookup when the selected provider does not support this platform', () => {
        expect(resolveVoiceStartAdmission({
            bindingScope: 'global',
            daemonLocalVoiceUnavailable: false,
            globalStartAuthorized: true,
            platform: 'ios',
            providerId: 'local_conversation',
            providerSettings: null,
            registry: registry(['web']),
            startSessionId: null,
            voiceSettings: settings,
        }).canStart).toBe(false);
    });

    it('admits the same selected provider on a declared platform', () => {
        expect(resolveVoiceStartAdmission({
            bindingScope: 'global',
            daemonLocalVoiceUnavailable: false,
            globalStartAuthorized: true,
            platform: 'web',
            providerId: 'local_conversation',
            providerSettings: null,
            registry: registry(['web']),
            startSessionId: null,
            voiceSettings: settings,
        }).canStart).toBe(true);
    });
});
