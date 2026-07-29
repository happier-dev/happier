import { describe, expect, it } from 'vitest';

import { readVoicePrivacySettings } from './readVoicePrivacySettings';

describe('readVoicePrivacySettings', () => {
    it('fails every provider-bound share bit closed when privacy settings are absent or malformed', () => {
        for (const settings of [null, { voice: { privacy: {} } }, { voice: { privacy: 'invalid' } }]) {
            expect(readVoicePrivacySettings(settings)).toMatchObject({
                shareSessionSummary: false,
                shareRecentMessages: false,
                shareToolNames: false,
                sharePermissionRequests: false,
                shareDeviceInventory: false,
                shareFilePaths: false,
                shareToolArgs: false,
            });
        }
    });

    it('requires an explicitly present true bit before sharing permission requests', () => {
        expect(readVoicePrivacySettings(null).sharePermissionRequests).toBe(false);
        expect(readVoicePrivacySettings({ voice: { privacy: {} } }).sharePermissionRequests).toBe(false);
        expect(readVoicePrivacySettings({
            voice: { privacy: { sharePermissionRequests: true } },
        }).sharePermissionRequests).toBe(true);
    });
});
