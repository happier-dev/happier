import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { SERVER_CONFIG } from '@happier-dev/protocol/serverConfig/registry';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { preloadTranslations, setPreferredLanguageFromSettings, t } from '@/text';
import { homeServerSettingTitle } from '@/components/settings/home/governance/homeServerSettingLabels';
import { homeFeatureTitle } from '@/components/settings/home/governance/homeFeatureLabels';
import { refreshHomeSettings, resetHomeSettingsEngineForTests } from '@/sync/engine/home/governance/homeSettingsEngine';
import { getHomeSettingsSnapshot, resetHomeSettingsSnapshotsForTests } from '@/sync/store/home/governance/homeSettingsSnapshots';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';

installApprovalCommonModuleMocks({ text: () => vi.importActual<typeof import('@/text')>('@/text') });
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { ApprovalReviewFacts } = await import('./ApprovalReviewFacts');

afterEach(async () => {
    await harness.reset();
    resetHomeSettingsEngineForTests();
    resetHomeSettingsSnapshotsForTests();
    standardCleanup();
    setPreferredLanguageFromSettings('en');
});

it.each([
    [SERVER_CONFIG.HAPPIER_HOME_DISPLAY_NAME.key, null],
    [SERVER_CONFIG.HAPPIER_HOME_DISPLAY_NAME.key, 'null'],
    [SERVER_CONFIG.HAPPIER_HOME_DISPLAY_NAME.key, undefined],
    ['HAPPIER_SESSION_DISCUSSIONS_RATE_LIMIT_MAX', 300],
    ['HAPPIER_SESSION_DISCUSSIONS_RATE_LIMIT_MAX', undefined],
])('shows the registry label for %s with value %s', async (key, value) => {
    await preloadTranslations('fr');
    setPreferredLanguageFromSettings('fr');
    const actionId = 'home.settings.set';
    const actionArgs = getActionSpec(actionId).inputSchema.parse({ expectedRevision: 1,
        values: value === undefined ? {} : { [key]: value } });
    const screen = await renderScreen(<ApprovalReviewFacts actionId={actionId} actionArgs={actionArgs}
        preview={null} serverId={null} testID="home-settings-review" />);
    try {
        const setting = homeServerSettingTitle(key);
        const body = screen.getTextContent();
        if (value === undefined) expect(body).not.toContain(setting);
        else expect(body).toContain(`${setting} ${value === null ? t('homeSettings.row.notSet') : value}`);
    } finally { await screen.unmount(); }
});

it('uses the loaded Home registry to name a dynamic feature switch without invoking another Action', async () => {
    await harness.reset();
    const serverId = await harness.addHome({ name: 'Review Home', serverUrl: 'https://settings-review.test', accountId: 'reviewer' });
    await preloadTranslations('fr');
    setPreferredLanguageFromSettings('fr');
    const key = 'HAPPIER_FEATURE_WORKFLOWS__ENABLED';
    harness.answer(serverId, 'POST /v1/home/settings/get', { body: {
        revision: 1, startedAt: null, entries: [{
            key, value: true, source: 'default', fixed: false, editable: 'home', apply: 'live',
            declaration: { type: 'boolean', section: 'features', featureId: 'workflows', default: true },
        }],
    } });
    const scope = { serverId, accountId: 'reviewer' };
    await refreshHomeSettings(scope);
    expect(getHomeSettingsSnapshot(scope)?.settings?.entries[0]?.key).toBe(key);
    await harness.requireUiApproval(serverId, 'home.settings.get');
    const actionId = 'home.settings.set';
    const actionArgs = getActionSpec(actionId).inputSchema.parse({ expectedRevision: 1, values: { [key]: false } });
    const screen = await renderScreen(<ApprovalReviewFacts actionId={actionId} actionArgs={actionArgs}
        preview={null} status="open" serverId={serverId} testID="home-settings-review" />);
    try {
        await vi.waitFor(() => expect(screen.getTextContent()).toContain(homeFeatureTitle('workflows')));
        expect(screen.getTextContent()).not.toContain(key);
        expect(harness.requestsFor('/v1/home/settings/get')).toHaveLength(1);
    } finally { await screen.unmount(); }
});
