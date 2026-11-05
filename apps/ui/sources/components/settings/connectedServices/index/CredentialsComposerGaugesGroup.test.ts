import { describe, expect, it } from 'vitest';

import { t } from '@/text';

import { presentComposerGaugesSummary } from './CredentialsComposerGaugesGroup';

describe('presentComposerGaugesSummary (the Credentials row that leads to the composer gauge preferences)', () => {
    it('says only that the gauges are hidden when the composer shows none', () => {
        expect(presentComposerGaugesSummary({ visibility: 'hidden', windows: ['weekly'], legacyWindow: undefined, routingHints: true }))
            .toBe(t('connectedServicesCollection.composerGaugesHidden'));
    });

    it('names the chosen windows in menu order and routing hints only while they are on', () => {
        const on = presentComposerGaugesSummary({ visibility: 'auto', windows: ['weekly', 'daily'], legacyWindow: undefined, routingHints: true });
        expect(on.split(' · ')).toEqual([
            t('connectedServicesCollection.composerGaugesShown'),
            `${t('settingsSession.providerUsageGauge.windowDailyTitle')} + ${t('settingsSession.providerUsageGauge.windowWeeklyTitle')}`,
            t('connectedServicesCollection.composerRoutingHintsOn'),
        ]);
        const off = presentComposerGaugesSummary({ visibility: 'auto', windows: ['weekly'], legacyWindow: undefined, routingHints: false });
        expect(off.split(' · ')).toEqual([
            t('connectedServicesCollection.composerGaugesShown'),
            t('settingsSession.providerUsageGauge.windowWeeklyTitle'),
        ]);
    });
});
