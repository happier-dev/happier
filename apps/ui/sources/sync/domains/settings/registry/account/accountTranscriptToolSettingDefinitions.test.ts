import { describe, expect, it } from 'vitest';

import { ACCOUNT_TRANSCRIPT_TOOL_SETTING_DEFINITIONS } from './accountTranscriptToolSettingDefinitions';

describe('ACCOUNT_TRANSCRIPT_TOOL_SETTING_DEFINITIONS message actions', () => {
    it('defines transcript message selection and send-to-session settings with safe defaults', () => {
        expect(ACCOUNT_TRANSCRIPT_TOOL_SETTING_DEFINITIONS.transcriptMessageSelectionEnabled.default).toBe(true);
        expect(ACCOUNT_TRANSCRIPT_TOOL_SETTING_DEFINITIONS.transcriptMessageSelectionEnabled.schema.safeParse(false).success).toBe(true);
        expect(ACCOUNT_TRANSCRIPT_TOOL_SETTING_DEFINITIONS.transcriptMessageSendToSessionEnabled.default).toBe(false);
        expect(ACCOUNT_TRANSCRIPT_TOOL_SETTING_DEFINITIONS.transcriptMessageSendToSessionEnabled.schema.safeParse(true).success).toBe(true);
    });

    it('defines the template as a bounded string with bucketed analytics only', () => {
        const definition = ACCOUNT_TRANSCRIPT_TOOL_SETTING_DEFINITIONS.transcriptMessageSendToSessionTemplate;

        expect(definition.default).toBe('{{MESSAGES}}');
        expect(definition.schema.safeParse('x'.repeat(2_000)).success).toBe(true);
        expect(definition.schema.safeParse('x'.repeat(2_001)).success).toBe(false);
        expect(definition.analytics?.valueKind).toBe('bucket');
        expect(definition.analytics?.privacy).toBe('bucketed');
        const serializeCurrent = definition.analytics?.serializeCurrent as ((value: unknown) => string) | undefined;
        expect(serializeCurrent?.('x'.repeat(129))).toBe('medium');
        expect(serializeCurrent?.(undefined)).toBe('small');
    });

    it('defines the bulk copy format enum', () => {
        const definition = ACCOUNT_TRANSCRIPT_TOOL_SETTING_DEFINITIONS.transcriptBulkCopyFormat;

        expect(definition.default).toBe('markdown_labeled');
        expect(definition.schema.safeParse('markdown_labeled').success).toBe(true);
        expect(definition.schema.safeParse('plain').success).toBe(true);
        expect(definition.schema.safeParse('html').success).toBe(false);
        expect(definition.analytics?.valueKind).toBe('enum');
    });
});
