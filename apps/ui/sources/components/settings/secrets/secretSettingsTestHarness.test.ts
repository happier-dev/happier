import { describe, expect, it, onTestFinished, vi } from 'vitest';
import 'fake-indexeddb/auto';

vi.mock('socket.io-client', async original => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(original));

const { createSecretSettingsTestHarness } = await import('./secretSettingsTestHarness');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { storage } = await import('@/sync/domains/state/storage');

describe('Secret Settings Account HTTP fixture', () => {
    it('publishes a newer parsed Account revision through scoped settings reconciliation', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ secrets: [] }) });
        onTestFinished(account.dispose);
        const before = storage.getState();
        const next = settingsParse({ ...account.persistedSettings, analyticsOptOut: !before.settings.analyticsOptOut });
        expect(next.voiceSettingsV1).not.toBe(before.settings.voiceSettingsV1);
        expect(next.secrets).not.toBe(before.settings.secrets);
        const version = (before.settingsVersion ?? 0) + 1;

        account.replaceSettings(next, { version });

        const after = storage.getState();
        expect(after.settingsScope).toBe(before.settingsScope);
        expect(after.settingsVersion).toBe(version);
        expect(after.settings.analyticsOptOut).toBe(next.analyticsOptOut);
        expect(after.settings.voiceSettingsV1).toBe(before.settings.voiceSettingsV1);
        expect(after.settings.secrets).toBe(before.settings.secrets);
        expect(account.persistedSettings.analyticsOptOut).toBe(next.analyticsOptOut);

        // Same-version replacement is an explicit fixture setup operation,
        // rather than an incoming server revision, and must remain available.
        account.replaceSettings(settingsParse({ ...next, analyticsOptOut: before.settings.analyticsOptOut }));
        expect(storage.getState().settingsVersion).toBe(version);
        expect(storage.getState().settings.analyticsOptOut).toBe(before.settings.analyticsOptOut);
        expect(account.persistedSettings.analyticsOptOut).toBe(before.settings.analyticsOptOut);
    });
});
