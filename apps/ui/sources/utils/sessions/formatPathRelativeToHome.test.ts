import { describe, expect, it } from 'vitest';

import { formatPathRelativeToHome } from './formatPathRelativeToHome';

describe('formatPathRelativeToHome', () => {
    it('formats a POSIX path below home and preserves a sibling-prefix path', () => {
        expect(formatPathRelativeToHome('/Users/alice/projects/demo', '/Users/alice')).toBe('~/projects/demo');
        expect(formatPathRelativeToHome('/Users/alice2/projects/demo', '/Users/alice')).toBe('/Users/alice2/projects/demo');
    });

    it('formats a Windows home path as ~/ with normalized separators', () => {
        expect(formatPathRelativeToHome('C:/Users\\alice/projects\\demo', 'C:\\Users\\alice')).toBe('~/projects/demo');
    });

    it('formats the Windows home directory itself as ~ even when the path has a trailing separator', () => {
        expect(formatPathRelativeToHome('C:\\Users\\alice\\', 'C:\\Users\\alice')).toBe('~');
    });

    it('leaves non-home Windows paths unchanged', () => {
        expect(formatPathRelativeToHome('D:\\work\\demo', 'C:\\Users\\alice')).toBe('D:\\work\\demo');
    });

    it('preserves a Windows sibling-prefix path while normalizing mixed separators below home', () => {
        expect(formatPathRelativeToHome('C:\\Users\\alice2\\projects\\demo', 'C:\\Users\\alice')).toBe('C:\\Users\\alice2\\projects\\demo');
        expect(formatPathRelativeToHome('C:\\Users/alice\\projects/demo', 'C:/Users\\alice')).toBe('~/projects/demo');
    });
});
