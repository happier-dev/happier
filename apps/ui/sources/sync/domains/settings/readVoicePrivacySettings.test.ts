import { describe, expect, it } from 'vitest';

import { readVoicePrivacySettings } from './readVoicePrivacySettings';

describe('readVoicePrivacySettings', () => {
    it('reads privacy without traversing unrelated provider configuration', () => {
        let providerValueReads = 0;
        // A retained provider payload can grow independently of the privacy question.
        // Proxies observe traversal of otherwise ordinary JSON records; the
        // privacy owner and parser remain real (stored JSON rejects accessors).
        const retainedItems = Array.from({ length: 100 }, (_, index) => new Proxy({
            text: `retained provider item ${index}`,
        }, {
            ownKeys(target) {
                providerValueReads += 1;
                return Reflect.ownKeys(target);
            },
        }));
        const privacy = readVoicePrivacySettings({ voice: {
            providers: { 'example.voice/provider': { schemaVersion: 1, config: { retainedItems } } },
            privacy: { shareRecentMessages: true, recentMessagesCount: 7, currentUiContextMode: 'automatic' },
        } });

        expect(privacy).toMatchObject({
            shareRecentMessages: true,
            recentMessagesCount: 7,
            currentUiContextMode: 'automatic',
        });
        expect(providerValueReads).toBe(0);
    });

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

    it('retains the independently parsed current UI context mode while provider-bound share bits fail closed', () => {
        const privacy = readVoicePrivacySettings({
            voice: { privacy: { currentUiContextMode: 'automatic' } },
        });

        expect(privacy.currentUiContextMode).toBe('automatic');
        expect(privacy.shareSessionSummary).toBe(false);
        expect(privacy.shareRecentMessages).toBe(false);
    });

    it('defaults a missing current UI context mode to on demand', () => {
        expect(readVoicePrivacySettings({ voice: { privacy: {} } }).currentUiContextMode)
            .toBe('on_demand');
    });

    it('fails malformed present modes and share bits closed while retaining valid independent fields', () => {
        for (const currentUiContextMode of [undefined, null, 'always', true]) {
            expect(readVoicePrivacySettings({ voice: { privacy: {
                currentUiContextMode,
                shareSessionSummary: 'true',
                shareRecentMessages: true,
                shareToolNames: 1,
                sharePermissionRequests: true,
                shareDeviceInventory: true,
                shareFilePaths: true,
                shareToolArgs: true,
                recentMessagesCount: -2,
            } } })).toEqual({
                currentUiContextMode: 'off',
                shareSessionSummary: false,
                shareRecentMessages: true,
                shareToolNames: false,
                sharePermissionRequests: true,
                shareDeviceInventory: true,
                shareFilePaths: false,
                shareToolArgs: false,
                recentMessagesCount: 0,
            });
        }
        expect(readVoicePrivacySettings({ voice: { privacy: {
            recentMessagesCount: 1.5, currentUiContextMode: 'off', shareToolNames: true,
        } } })).toMatchObject({ recentMessagesCount: 3, currentUiContextMode: 'off', shareToolNames: true });
    });
});
