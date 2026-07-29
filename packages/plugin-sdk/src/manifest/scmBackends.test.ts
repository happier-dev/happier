import { describe, expect, it } from 'vitest';

import { ScmBackendContributionSchema } from './scmBackends.js';

describe('plugin SDK SCM backend manifest surface', () => {
    it('re-exports the protocol SCM backend contribution schema for authoring', () => {
        expect(ScmBackendContributionSchema.safeParse({
            id: 'acme-vcs',
            title: 'Acme VCS',
            kind: 'acme',
            capabilities: ['detect', 'status', 'diff'],
        }).success).toBe(true);
    });
});
