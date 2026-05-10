import { describe, expect, it } from 'vitest';

import {
    SCM_DIFF_SUMMARY_SETTING_KEYS,
    resolveScmDiffSummarySettings,
} from './settings';
import { settingsParse } from '@/sync/domains/settings/settings';

describe('SCM diff-summary settings', () => {
    it('defaults prefetch off behind an explicit preference gate', () => {
        const parsed = settingsParse({});

        expect(parsed[SCM_DIFF_SUMMARY_SETTING_KEYS.enabled]).toBe(true);
        expect(parsed[SCM_DIFF_SUMMARY_SETTING_KEYS.prefetch]).toBe(false);
        expect(parsed[SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride]).toBe('');
        expect(resolveScmDiffSummarySettings({ storedSettings: parsed, catalogProfiles: [] })).toEqual({
            enabled: true,
            prefetch: false,
            modelOverride: null,
        });
    });

    it('resolves model overrides through runtime catalog ids only', () => {
        expect(resolveScmDiffSummarySettings({
            storedSettings: {
                [SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride]: 'profile:thorough-summary',
            },
            catalogProfiles: [
                { catalogId: 'profile:fast-summary', title: 'Fast summary' },
                { catalogId: 'profile:thorough-summary', title: 'Thorough summary' },
            ],
        }).modelOverride).toEqual({
            catalogId: 'profile:thorough-summary',
            title: 'Thorough summary',
        });
    });

    it('ignores raw labels that do not resolve to runtime catalog ids', () => {
        expect(resolveScmDiffSummarySettings({
            storedSettings: {
                [SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride]: 'Thorough summary',
                [SCM_DIFF_SUMMARY_SETTING_KEYS.prefetch]: true,
            },
            catalogProfiles: [
                { catalogId: 'profile:thorough-summary', title: 'Thorough summary' },
            ],
        })).toMatchObject({
            prefetch: true,
            modelOverride: null,
        });
    });
});
