import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { projectApprovalReviewInput } from '@happier-dev/protocol/actions/actionApprovalPresentation';
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
const actionId = 'home.settings.set';

function homeSettingsReview(key: string, value: unknown) {
    const spec = getActionSpec(actionId);
    const input = spec.inputSchema.parse({
        expectedRevision: 83,
        values: value === undefined ? {} : { [key]: value },
    });
    return { actionId, actionArgs: projectApprovalReviewInput(spec, input) };
}

async function expectRegistryKeyInTechnicalDetails(screen: Awaited<ReturnType<typeof renderScreen>>, key: string, changed: boolean) {
    expect(screen.getTextContent()).not.toContain(key);
    await screen.pressByTestIdAsync('approvals.technical-details.header');
    if (changed) expect(screen.getTextContent()).toContain(key);
    else expect(screen.getTextContent()).not.toContain(key);
}

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
    ['HAPPIER_SESSION_DISCUSSIONS_RATE_LIMIT_MAX', null],
    ['HAPPIER_SESSION_DISCUSSIONS_RATE_LIMIT_MAX', undefined],
])('shows the registry label for %s with value %s', async (key, value) => {
    await preloadTranslations('fr');
    setPreferredLanguageFromSettings('fr');
    const screen = await renderScreen(<ApprovalReviewFacts actionId={actionId} actionArgs={null}
        preview={homeSettingsReview(key, value)} status="open" serverId={null} testID="home-settings-review" />);
    try {
        const setting = homeServerSettingTitle(key);
        const body = screen.getTextContent();
        if (value === undefined) expect(body).not.toContain(setting);
        else expect(body).toContain(`${setting} ${value === null ? t('homeSettings.row.notSet') : value}`);
        await expectRegistryKeyInTechnicalDetails(screen, key, value !== undefined);
    } finally { await screen.unmount(); }
});

it.each([false, null, undefined])('uses the loaded Home registry to name a dynamic feature switch with value %s without invoking another Action', async value => {
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
    const screen = await renderScreen(<ApprovalReviewFacts actionId={actionId} actionArgs={null}
        preview={homeSettingsReview(key, value)} status="open" serverId={serverId} testID="home-settings-review" />);
    try {
        if (value === undefined) expect(screen.getTextContent()).not.toContain(homeFeatureTitle('workflows'));
        else await vi.waitFor(() => expect(screen.getTextContent()).toContain(
            value === null ? `${homeFeatureTitle('workflows')} ${t('homeSettings.row.notSet')}` : homeFeatureTitle('workflows')));
        await expectRegistryKeyInTechnicalDetails(screen, key, value !== undefined);
        expect(harness.requestsFor('/v1/home/settings/get')).toHaveLength(1);
    } finally { await screen.unmount(); }
});
