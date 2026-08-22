import { describe, expect, it } from 'vitest';

import { redactVoicePathLikeString } from './redactVoicePathLikeData';

describe('redactVoicePathLikeString', () => {
    it('redacts an absolute Windows drive path', () => {
        expect(redactVoicePathLikeString('Open C:\\Users\\alice\\SECRET')).toBe('Open <path_redacted>');
    });

    it('redacts an absolute Windows UNC path', () => {
        expect(redactVoicePathLikeString('Open \\\\server\\share\\SECRET')).toBe('Open <path_redacted>');
    });

    it('redacts Windows drive paths with mixed separators', () => {
        expect(redactVoicePathLikeString('Open C:/Users\\alice/SECRET')).toBe('Open <path_redacted>');
    });

    it('redacts home-relative Windows paths', () => {
        expect(redactVoicePathLikeString('Open ~\\workspace\\SECRET')).toBe('Open <path_redacted>');
    });

    it('redacts a sibling-prefixed Windows user directory as its own path', () => {
        expect(redactVoicePathLikeString('Open C:\\Users\\alice2\\SECRET')).toBe('Open <path_redacted>');
    });

    it('preserves existing POSIX path redaction', () => {
        expect(redactVoicePathLikeString('Open /Users/alice/SECRET')).toBe('Open <path_redacted>');
    });

    it('does not treat an arbitrary colon-delimited value as a path', () => {
        expect(redactVoicePathLikeString('Status C: pending')).toBe('Status C: pending');
    });
});
