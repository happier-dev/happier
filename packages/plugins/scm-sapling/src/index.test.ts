import { describe, expect, it } from 'vitest';

import * as publicApi from './index.js';

describe('scm-sapling public API', () => {
    it('does not expose internal backend, operation, or parser modules from the package root', () => {
        expect(publicApi).toHaveProperty('activate');
        expect(publicApi).toHaveProperty('SAPLING_SCM_BACKEND_CAPABILITIES');
        expect(publicApi).toHaveProperty('PLUGIN_MANIFEST');
        expect(publicApi).not.toHaveProperty('registerSaplingScmBackend');
        expect(publicApi).not.toHaveProperty('saplingRemoteFetch');
        expect(publicApi).not.toHaveProperty('parseSaplingRemotePaths');
    });
});
