import { describe, expect, it } from 'vitest';
import { ACCOUNT_SETTING_ARTIFACTS } from '@happier-dev/protocol';

import { settingsDefaults, settingsParse } from '../../settings';
import { ACCOUNT_SETTING_ANALYTICS_ARTIFACTS } from './accountSettingAnalytics';

describe('Protocol transcript Account settings with UI analytics presentation', () => {
    it('defines transcript message selection and send-to-session settings with safe defaults', () => {
        expect(ACCOUNT_SETTING_ARTIFACTS.definitions.transcriptMessageSelectionEnabled.default).toBe(true);
        expect(ACCOUNT_SETTING_ARTIFACTS.shape.transcriptMessageSelectionEnabled.safeParse(false).success).toBe(true);
        expect(ACCOUNT_SETTING_ARTIFACTS.definitions.transcriptMessageSendToSessionEnabled.default).toBe(false);
        expect(ACCOUNT_SETTING_ARTIFACTS.shape.transcriptMessageSendToSessionEnabled.safeParse(true).success).toBe(true);
    });

    it('defines the template as a bounded string with bucketed analytics only', () => {
        const definition = ACCOUNT_SETTING_ARTIFACTS.definitions.transcriptMessageSendToSessionTemplate;
        const analytics = ACCOUNT_SETTING_ANALYTICS_ARTIFACTS.definitions
            .transcriptMessageSendToSessionTemplate
            .analytics;

        expect(definition.default).toBe('{{MESSAGES}}');
        expect(definition.schema.safeParse('x'.repeat(2_000)).success).toBe(true);
        expect(definition.schema.safeParse('x'.repeat(2_001)).success).toBe(false);
        expect(analytics?.valueKind).toBe('bucket');
        expect(analytics?.privacy).toBe('bucketed');
        const serializeCurrent = analytics?.serializeCurrent as ((value: unknown) => string) | undefined;
        expect(serializeCurrent?.('x'.repeat(129))).toBe('medium');
        expect(serializeCurrent?.(undefined)).toBe('small');
    });

    it('defines the bulk copy format enum', () => {
        const definition = ACCOUNT_SETTING_ARTIFACTS.definitions.transcriptBulkCopyFormat;

        expect(definition.default).toBe('markdown_labeled');
        expect(definition.schema.safeParse('markdown_labeled').success).toBe(true);
        expect(definition.schema.safeParse('plain').success).toBe(true);
        expect(definition.schema.safeParse('html').success).toBe(false);
        expect(ACCOUNT_SETTING_ANALYTICS_ARTIFACTS.definitions.transcriptBulkCopyFormat.analytics?.valueKind).toBe('enum');
    });

    it('keeps predecessor renderer values opaque without exposing an active setting', () => {
        expect(ACCOUNT_SETTING_ARTIFACTS.definitions).not.toHaveProperty('transcriptListImplementation');
        expect(settingsDefaults).not.toHaveProperty('transcriptListImplementation');

        for (const legacyValue of ['flash_v2', 'flatlist_legacy']) {
            const parsed = settingsParse({
                transcriptListImplementation: legacyValue,
            }) as typeof settingsDefaults & { transcriptListImplementation?: unknown };

            expect(parsed.transcriptListImplementation).toBe(legacyValue);
        }
    });
});
