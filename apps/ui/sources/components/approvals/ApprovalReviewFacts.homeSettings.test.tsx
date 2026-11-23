import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { SERVER_CONFIG } from '@happier-dev/protocol/serverConfig/registry';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { preloadTranslations, setPreferredLanguageFromSettings, t } from '@/text';
import { homeServerSettingTitle } from '@/components/settings/home/governance/homeServerSettingLabels';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';

installApprovalCommonModuleMocks({ text: () => vi.importActual<typeof import('@/text')>('@/text') });
const { ApprovalReviewFacts } = await import('./ApprovalReviewFacts');

afterEach(() => { standardCleanup(); setPreferredLanguageFromSettings('en'); });

it.each([null, 'null', undefined])('shows the Home name change for a value of %s', async value => {
    await preloadTranslations('fr');
    setPreferredLanguageFromSettings('fr');
    const actionId = 'home.settings.set';
    const key = SERVER_CONFIG.HAPPIER_HOME_DISPLAY_NAME.key;
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
