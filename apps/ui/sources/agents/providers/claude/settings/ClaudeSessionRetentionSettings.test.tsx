import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';

await vi.hoisted(async () => {
    const { installSettingsViewCommonModuleMocks } = await import('@/components/settings/settingsViewTestHelpers');
    installSettingsViewCommonModuleMocks({
        // Preserve the real store, selectors, settings hooks and domain mutators.
        storage: importOriginal => importOriginal(),
        text: () => vi.importActual('@/text'),
    });
});

// FlashList is an external native engine; retain the real settings and status logic beneath it.
vi.mock('@shopify/flash-list', async () => {
    const { createCapturingFlashListMock } = await import('@/dev/testkit/mocks/flashList');
    return createCapturingFlashListMock().module;
});

const { getStorage } = await import('@/sync/domains/state/storage');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
const { t } = await import('@/text');
const { CLAUDE_PROVIDER_SETTINGS_PLUGIN } = await import('./plugin');

async function renderRetention() {
    const Section = CLAUDE_PROVIDER_SETTINGS_PLUGIN.ExtraSectionsComponent;
    const screen = await renderSettingsView(Section ? <Section providerId="claude" /> : <React.Fragment />);
    await act(async () => { await vi.dynamicImportSettled(); });
    return screen;
}

describe('Claude session retention settings', () => {
    afterEach(standardCleanup);
    beforeEach(() => {
        getStorage().getState().replaceSettings({ ...settingsDefaults, claudeSessionRetentionV1: null }, 0);
        getStorage().getState().applyMachines([], true);
    });

    it('expires mounted machine presence after the canonical grace without another machine update', async () => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(new Date('2026-11-07T12:00:00Z'));
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_MACHINE_ONLINE_GRACE_MS', '60000');
        try {
            getStorage().getState().applyMachines([createMachineFixture({ active: false, activeAt: Date.now() })], true);
            const screen = await renderRetention();
            await act(async () => { screen.pressRow('claude-session-retention-machines'); });
            expect(screen.findByTestId('claude-session-retention-machine-machine-1')).not.toBeNull();
            expect(screen.getTextContent()).not.toContain(t('settingsProviders.sessionRetention.offline'));
            await act(async () => { await vi.advanceTimersByTimeAsync(60_001); });
            expect(screen.getTextContent()).toContain(t('settingsProviders.sessionRetention.offline'));
        } finally {
            vi.unstubAllEnvs();
            vi.useRealTimers();
        }
    });
});
