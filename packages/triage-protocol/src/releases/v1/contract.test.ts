import { describe, expect, it } from 'vitest';
import { createForgeReleaseV1Fixture } from '../testing/v1/index.js';
import { ForgeReleaseActionInputSchemasV1, ForgeReleaseV1Schema } from './index.js';

describe('public Releases V1 boundary', () => {
    it('preserves absent immutable evidence and refuses authority-bearing unknown mutation fields', () => {
        const release = createForgeReleaseV1Fixture();
        expect(ForgeReleaseV1Schema.parse(release)).not.toHaveProperty('immutable');
        const target = { repository: release.repository, repositoryId: release.repositoryId };
        const publish = { ...target, releaseId: release.releaseId, reviewed: release, makeLatest: 'legacy' };
        expect(ForgeReleaseActionInputSchemasV1.publishReleaseDraft.safeParse(publish).success).toBe(true);
        const { reviewed: _reviewed, ...timestampOnly } = publish;
        expect(ForgeReleaseActionInputSchemasV1.publishReleaseDraft.safeParse(timestampOnly).success).toBe(false);
        expect(ForgeReleaseActionInputSchemasV1.editReleaseDraft.safeParse({ ...target, releaseId: release.releaseId,
            observedUpdatedAt: release.updatedAt, changes: { body: 'Explicit edit' } }).success).toBe(true);
        expect(ForgeReleaseActionInputSchemasV1.publishReleaseDraft.safeParse({ ...publish, approved: true }).success).toBe(false);
        expect(ForgeReleaseActionInputSchemasV1.createReleaseDraft.safeParse({ ...target, tagName: 'v7', targetCommitish: 'main', name: 'Title', body: 'Body', prerelease: false, draft: false }).success).toBe(false);
    });
    it('accepts only the receiver-owned opaque destination, never a path or URL destination', () => {
        const release = createForgeReleaseV1Fixture();
        const input = { repository: release.repository, repositoryId: release.repositoryId, releaseId: release.releaseId, assetId: '9' };
        expect(ForgeReleaseActionInputSchemasV1.downloadAsset.safeParse({ ...input, destination: { destinationId: 'receiver-issued' } }).success).toBe(true);
        for (const destination of [{ path: 'C:\\Downloads\\asset.zip' }, { url: 'https://storage.example/asset.zip' }, { destinationId: 'receiver-issued', overwrite: true }])
            expect(ForgeReleaseActionInputSchemasV1.downloadAsset.safeParse({ ...input, destination }).success).toBe(false);
    });
});
