import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExternalVoiceProviderSettingsDescriptor } from '@happier-dev/protocol/voice/settings/externalProviderSettings';
import type { VoiceProviderRegistryEntry } from '@/voice/registry/providerRegistry';
import { commitExternalVoiceProviderRegistration, removeExternalVoiceProviderRegistration } from '@/voice/registry/externalVoiceProviderRegistrations';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { settingsParse } from '@/sync/domains/settings/settings';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
// Catalog reads never play audio; Expo is the native playback boundary.
vi.mock('expo-audio', () => ({ AudioModule: { setAudioModeAsync: async () => {} } }));
const { invokeVoiceCatalogSettingsOperation } = await import('./voiceCatalogSettingsOperation');
const token = {};
afterEach(() => removeExternalVoiceProviderRegistration(token));

describe('Voice catalog Settings operation failures', () => {
    it.each(['list', 'retry'] as const)('preserves the provider credential cause on %s', async operation => {
        const entry: VoiceProviderRegistryEntry = {
            kind: 'voice.conversation-provider.v1', pluginId: 'test.voice', providerId: 'test.voice/catalog',
            settingsSectionId: 'test.voice/catalog', roles: [], requirements: [], supportedPlatforms: ['web'],
            source: { kind: 'external', pluginId: 'test.voice', localId: 'catalog' },
            providerSettings: createExternalVoiceProviderSettingsDescriptor(undefined),
        };
        const cause = Object.assign(new Error('Credential required'), {
            code: 'credential_unavailable', details: { credentialSlotId: 'api_key' },
        });
        // The public plugin callback is the external provider boundary; host catalog logic remains real.
        commitExternalVoiceProviderRegistration({ token, pluginId: entry.pluginId, localId: 'catalog',
            providerId: entry.providerId, descriptor: entry, adapter: null,
            settingsOperations: { async listCatalog() { throw cause; } },
        });
        const result = await invokeVoiceCatalogSettingsOperation(entry, createDefaultVoiceProviderRegistry(), operation, {
            isCurrent: () => true, readSettings: async () => settingsParse({}),
            mutateSettings: async () => { throw new Error('Catalog reads cannot write Settings'); },
        }).catch(error => ({ ok: false, ...normalizeActionExecutorThrownError(error) }));
        expect(result).toMatchObject({ ok: false, errorCode: cause.code, error: cause.message, details: cause.details });
    });
});
