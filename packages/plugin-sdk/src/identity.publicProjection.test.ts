import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import {
    computeCanonicalDomainSeparatedDigest as canonicalComputeCanonicalDomainSeparatedDigest,
} from '@happier-dev/protocol/crypto/canonicalDigest';

import {
    computeCanonicalDomainSeparatedDigest,
} from './identity.js';

describe('identity public projection', () => {
    it('preserves the canonical digest identity through the root author spec', () => {
        const rootAuthorSource = readFileSync(
            new URL('./index.public.ts', import.meta.url),
            'utf8',
        );

        expect(computeCanonicalDomainSeparatedDigest).toBe(
            canonicalComputeCanonicalDomainSeparatedDigest,
        );
        expect(rootAuthorSource).toContain(
            "export { computeCanonicalDomainSeparatedDigest } from './identity.js';",
        );
    });
});
