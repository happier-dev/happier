import { describe, expect, it, vi } from 'vitest';

describe('settingsDefaults provider plugin default guards', () => {
    it('does not allow provider defaults to overwrite known defaults with undefined', async () => {
        vi.resetModules();

        vi.doMock('@/agents/providers/_registry/providerSettingsRegistry', () => ({
            PROVIDER_SETTINGS_PLUGINS: [
                {
                    providerId: 'mock-provider',
                    settingsShape: {},
                    settingsDefaults: {
                        // This key is owned by core settings, not provider plugins.
                        // A bad plugin (or a leaky mock) must not be able to wipe it out.
                        attachmentsUploadsUploadLocation: undefined,
                    },
                },
            ],
        }));

        const { settingsDefaults, settingsParse } = await import('./settings');

        expect((settingsDefaults as any).attachmentsUploadsUploadLocation).toBe('workspace');
        expect((settingsParse({}) as any).attachmentsUploadsUploadLocation).toBe('workspace');
    });
});

