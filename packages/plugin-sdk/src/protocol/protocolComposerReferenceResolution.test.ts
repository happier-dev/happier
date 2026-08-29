import { describe, expect, it } from 'vitest';

import {
    ComposerReferenceResolutionV1Schema as canonicalComposerReferenceResolutionV1Schema,
} from '@happier-dev/protocol';

import { ProtocolComposerReferenceResolutionV1Schema } from './index.js';

describe('the /protocol Composer reference resolution projection', () => {
    it('publishes the executable canonical Protocol parser by identity', () => {
        expect(ProtocolComposerReferenceResolutionV1Schema)
            .toBe(canonicalComposerReferenceResolutionV1Schema);
    });

    it('enforces the canonical whole-resolution 16KiB boundary', () => {
        expect(ProtocolComposerReferenceResolutionV1Schema.safeParse({
            id: 'candidate-1',
            label: 'Candidate',
            context: 'x'.repeat(16 * 1024),
        }).success).toBe(false);
        expect(ProtocolComposerReferenceResolutionV1Schema.safeParse({
            id: 'candidate-1',
            label: 'Candidate',
            context: 'ready',
        }).success).toBe(true);
    });
});
