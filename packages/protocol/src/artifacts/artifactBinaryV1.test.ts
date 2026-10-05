import { describe, expect, it } from 'vitest';
import { ArtifactBlobUploadInitV1Schema } from './artifactBinaryV1';

describe('Artifact upload destination identity', () => {
    it('uses the signed conversion UUID identity while preserving legacy update addresses', () => {
        const identity = { artifactId: 'legacy:document', blobId: '00000000-0000-4000-8000-000000000001', t: 'plain', sizeBytes: 1 };
        expect(ArtifactBlobUploadInitV1Schema.safeParse({ kind: 'encryption-conversion', ...identity }).success).toBe(false);
        expect(ArtifactBlobUploadInitV1Schema.safeParse({ kind: 'encryption-conversion', ...identity,
            artifactId: '00000000-0000-4000-8000-000000000002' }).success).toBe(true);
        expect(ArtifactBlobUploadInitV1Schema.safeParse({ kind: 'update', ...identity, body: 'body', expectedBodyVersion: 1 }).success).toBe(true);
    });
});
