import { describe, expect, it } from 'vitest';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { createVoiceAgentSettingsCatalogReader } from './voiceAgentSettingsCatalog';

describe('Voice settings Agent catalog currentness', () => {
    it('rejects a prepared catalog when the Account disables its selected Agent', async () => {
        // The captured Account/lifetime is the system boundary. Catalog projection,
        // enabled policy and execution-machine resolution remain real.
        const account = {
            serverId: 'test-home',
            accountLifetime: {
                scope: { serverId: 'test-home', accountId: 'test-account' },
                isCurrent: () => true,
                onRetire: () => ({ dispose() {} }),
            },
            assertCurrent() {},
            readLiveSettings: () => settingsDefaults,
        };
        const settings = { ...settingsDefaults, voice: { ...settingsDefaults.voice,
            executionMachine: { ...settingsDefaults.voice.executionMachine, mode: 'fixed' as const, machineId: null },
        } };
        const catalog = await createVoiceAgentSettingsCatalogReader(account)(settings);
        const selected = catalog?.entries.find((entry) => entry.isBuiltIn && entry.backendTargetKey !== null);
        if (!catalog || !selected?.backendTargetKey) throw new Error('Expected the real built-in catalog');
        expect(catalog.isCurrent(settings)).toBe(true);
        expect(catalog.isCurrent({ ...settings, backendEnabledByTargetKey: {
            ...settings.backendEnabledByTargetKey, [selected.backendTargetKey]: false,
        } })).toBe(false);
    });
});
