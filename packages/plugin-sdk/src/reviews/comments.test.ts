import { describe, expect, it } from 'vitest';

import {
    createReviewCommentFingerprintV1,
    redactReviewCommentSensitiveText,
} from './comments.js';

describe('review comment helpers', () => {
    it('redacts diagnostic secrets from review comment text', () => {
        const redacted = redactReviewCommentSensitiveText(
            'AUTH_TOKEN=abc123 --api-key live-secret custom-secret',
            { redactedValues: ['custom-secret'] },
        );

        expect(redacted).toContain('AUTH_TOKEN=[REDACTED]');
        expect(redacted).toContain('--api-key [REDACTED]');
        expect(redacted).not.toContain('abc123');
        expect(redacted).not.toContain('live-secret');
        expect(redacted).not.toContain('custom-secret');
    });

    it('builds stable fingerprints from normalized message and anchor content', () => {
        const first = createReviewCommentFingerprintV1({
            ruleId: ' Security ',
            anchor: { kind: 'line', filePath: ' src/auth.ts ', line: 42 },
            message: 'Validate   TOKEN=first before use.',
            engineId: 'coderabbit',
        });
        const second = createReviewCommentFingerprintV1({
            ruleId: 'security',
            anchor: { kind: 'line', filePath: 'src/auth.ts', line: 42 },
            message: ' validate token=second before use. ',
            engineId: 'coderabbit',
        });

        expect(first.normalizedMessageHash).toMatch(/^[a-f0-9]{64}$/);
        expect(first.normalizedMessageHash).toBe(second.normalizedMessageHash);
        expect(first.lineRange).toEqual({ startLine: 42, endLine: 42 });
        expect(JSON.stringify(first)).not.toContain('first');
        expect(JSON.stringify(second)).not.toContain('second');
    });
});
