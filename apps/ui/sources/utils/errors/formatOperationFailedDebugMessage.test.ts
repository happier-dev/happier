import { describe, it, expect } from 'vitest';

import { formatOperationFailedDebugMessage } from './formatOperationFailedDebugMessage';

describe('formatOperationFailedDebugMessage', () => {
    it('returns base message when error has no detail', () => {
        expect(formatOperationFailedDebugMessage('Operation failed', null)).toBe('Operation failed');
    });

    it('appends error message when provided', () => {
        expect(formatOperationFailedDebugMessage('Operation failed', new Error('boom'))).toBe(
            'Operation failed\n\nboom',
        );
    });

    it('handles non-Error inputs', () => {
        expect(formatOperationFailedDebugMessage('Operation failed', { message: 'nope' })).toBe(
            'Operation failed\n\nnope',
        );
    });
});

