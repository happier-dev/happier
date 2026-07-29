import { describe, expect, it } from 'vitest';

import { settingsParse } from '@/sync/domains/settings/settings';

describe('settingsParse retired plugin settings compatibility', () => {
    it('opaque-preserves persisted plugin keys without defaulting or canonicalizing them', () => {
        const emptySettings = settingsParse({});
        expect(emptySettings).not.toHaveProperty('claudeRemoteAgentSdkEnabled');
        expect(emptySettings).not.toHaveProperty('codexBackendMode');

        const persistedSettings = settingsParse({
            schemaVersion: 5,
            claudeRemoteAgentSdkEnabled: false,
            codexBackendMode: 'mcp',
        });
        const persistedRecord: Record<string, unknown> = persistedSettings;
        expect(persistedRecord.claudeRemoteAgentSdkEnabled).toBe(false);
        expect(persistedRecord.codexBackendMode).toBe('mcp');
    });
});
