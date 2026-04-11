import { describe, expect, it } from 'vitest';

import { formatPathRelativeToHome } from './formatPathRelativeToHome';

describe('formatPathRelativeToHome', () => {
    it('formats a Windows home path as ~/ with normalized separators', () => {
        expect(formatPathRelativeToHome('C:/Users\\alice/projects\\demo', 'C:\\Users\\alice')).toBe('~/projects/demo');
    });

    it('formats the Windows home directory itself as ~ even when the path has a trailing separator', () => {
        expect(formatPathRelativeToHome('C:\\Users\\alice\\', 'C:\\Users\\alice')).toBe('~');
    });

    it('leaves non-home Windows paths unchanged', () => {
        expect(formatPathRelativeToHome('D:\\work\\demo', 'C:\\Users\\alice')).toBe('D:\\work\\demo');
    });
});
