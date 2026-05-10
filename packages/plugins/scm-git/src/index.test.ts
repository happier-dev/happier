import { describe, expect, it } from 'vitest';

import * as publicApi from './index.js';

describe('scm-git public API', () => {
    it('does not expose the full internal backend factory from the package root', () => {
        expect(publicApi).toHaveProperty('activate');
        expect(publicApi).not.toHaveProperty('createGitBackend');
    });
});
