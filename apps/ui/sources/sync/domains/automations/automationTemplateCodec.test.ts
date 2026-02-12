import { describe, expect, it } from 'vitest';

import { decodeAutomationTemplate, encodeAutomationTemplate } from './automationTemplateCodec';

describe('automationTemplateCodec', () => {
    it('encodes and decodes a valid template', () => {
        const encoded = encodeAutomationTemplate({
            directory: '/tmp/project',
            agent: 'codex',
            prompt: 'Ship it',
            permissionMode: 'default',
            permissionModeUpdatedAt: 123,
        });

        const decoded = decodeAutomationTemplate(encoded);
        expect(decoded).toEqual(
            expect.objectContaining({
                directory: '/tmp/project',
                agent: 'codex',
                prompt: 'Ship it',
            }),
        );
    });

    it('returns null when payload is not valid JSON or schema-compatible', () => {
        expect(decodeAutomationTemplate('')).toBeNull();
        expect(decodeAutomationTemplate('{')).toBeNull();
        expect(decodeAutomationTemplate(JSON.stringify({ directory: '' }))).toBeNull();
    });
});
