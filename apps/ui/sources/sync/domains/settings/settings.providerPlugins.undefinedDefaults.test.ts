import { describe, expect, it, vi } from 'vitest';
import { defineSettingDefinitions } from '@happier-dev/protocol';
import { z } from 'zod';

describe('settingsDefaults provider plugin default guards', () => {
    it('rejects provider settings that try to shadow core-owned settings', async () => {
        vi.resetModules();

        vi.doMock('@/agents/catalog/providerSettingsCatalog', () => ({
            PROVIDER_SETTINGS_DESCRIPTORS: [
                {
                    providerId: 'mock-provider',
                    title: 'Mock provider',
                    icon: { ionName: 'terminal-outline', color: '#000' },
                    settings: defineSettingDefinitions({
                        attachmentsUploadsUploadLocation: {
                            schema: z.string(),
                            default: 'provider-owned',
                            description: 'Invalid provider-owned override',
                            storageScope: 'account',
                        },
                    }),
                    uiSections: [],
                },
            ],
            PROVIDER_SETTINGS_PLUGINS: [
                {
                    providerId: 'mock-provider',
                    title: 'Mock provider',
                    icon: { ionName: 'terminal-outline', color: '#000' },
                    settings: defineSettingDefinitions({
                        attachmentsUploadsUploadLocation: {
                            schema: z.string(),
                            default: 'provider-owned',
                            description: 'Invalid provider-owned override',
                            storageScope: 'account',
                        },
                    }),
                    uiSections: [],
                },
            ],
        }));

        try {
            await expect(import('./settings')).rejects.toThrow(/attachmentsUploadsUploadLocation/);
        } finally {
            vi.unmock('@/agents/catalog/providerSettingsCatalog');
            vi.resetModules();
        }
    });
});
