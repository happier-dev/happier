import { describe, it, expect } from 'vitest';
import { formatVoiceTestFailureMessage } from './formatVoiceTestFailureMessage';

describe('formatVoiceTestFailureMessage', () => {
    it('appends error details when available', () => {
        expect(formatVoiceTestFailureMessage('base', new Error('nope'))).toBe('base\n\nnope');
    });

    it('returns base message when error details are empty', () => {
        expect(formatVoiceTestFailureMessage('base', null)).toBe('base');
    });
});

