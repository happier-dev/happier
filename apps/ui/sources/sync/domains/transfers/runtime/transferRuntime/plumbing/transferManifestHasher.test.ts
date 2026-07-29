import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createTransferManifestHasher } from './transferManifestHasher';

describe('createTransferManifestHasher', () => {
    it('computes the canonical manifest incrementally across destination-sized chunks', () => {
        const chunks = [
            new TextEncoder().encode('bounded '),
            new TextEncoder().encode('memory '),
            new TextEncoder().encode('download'),
        ];
        const hasher = createTransferManifestHasher();

        for (const chunk of chunks) {
            hasher.update(chunk);
        }

        const expected = createHash('sha256')
            .update(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))))
            .digest('hex');
        expect(hasher.digestManifestHash()).toBe(`sha256:${expected}`);
    });
});
