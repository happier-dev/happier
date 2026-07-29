import { describe, expect, it } from 'vitest';

import { resolveTildePath } from './runtime';

describe('SCM home-path expansion', () => {
    it('delegates Windows mixed-separator home paths to the canonical CLI path owner', () => {
        expect(resolveTildePath(
            '~\\projects/acme',
            { USERPROFILE: 'C:\\Users\\Alice' },
            'win32',
        )).toBe('C:\\Users\\Alice\\projects\\acme');
    });
});
