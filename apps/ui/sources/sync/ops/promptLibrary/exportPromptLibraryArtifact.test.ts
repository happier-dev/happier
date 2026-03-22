import { beforeEach, describe, expect, it, vi } from 'vitest';

const machinePromptAssetsWriteMock = vi.hoisted(() => vi.fn(async () => ({
    ok: true as const,
    externalRef: { path: '.claude/commands/review.md' },
    digest: 'digest-1',
    preview: {
        operation: 'write' as const,
        targetPath: '.claude/commands/review.md',
        fileCount: 1,
    },
})));

const storageState = vi.hoisted(() => ({
    artifacts: {
        'doc-1': {
            id: 'doc-1',
            header: { title: 'Review prompt' },
            body: JSON.stringify({
                v: 1,
                markdown: '# Review',
                createdAtMs: 1,
                updatedAtMs: 1,
            }),
        },
    } as Record<string, any>,
    updateArtifact: vi.fn(),
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    storage: {
        getState: () => storageState,
    },
});
});

vi.mock('@/sync/sync', () => ({
    sync: {
        fetchArtifactWithBody: vi.fn(async () => null),
    },
}));

vi.mock('@/sync/ops/machinePromptAssets', () => ({
    machinePromptAssetsWrite: machinePromptAssetsWriteMock,
}));

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => 'link-1',
}));

vi.mock('./promptDocs', () => ({
    findPromptExternalLink: () => null,
    upsertPromptExternalLink: (_existing: unknown, next: unknown) => next,
}));

describe('writePromptLibraryArtifactToExternalAsset', () => {
    beforeEach(() => {
        machinePromptAssetsWriteMock.mockClear();
        storageState.updateArtifact.mockClear();
    });

    it('passes server routing through to machine prompt asset writes', async () => {
        const { writePromptLibraryArtifactToExternalAsset } = await import('./exportPromptLibraryArtifact');

        await writePromptLibraryArtifactToExternalAsset({
            artifactId: 'doc-1',
            machineId: 'machine-1',
            assetTypeId: 'claude.command',
            scope: 'user',
            targetInput: 'review.md',
            promptExternalLinks: { v: 1, links: [] },
            previewOnly: false,
            serverId: 'server-1',
        });

        expect(machinePromptAssetsWriteMock).toHaveBeenCalledWith(
            'machine-1',
            expect.objectContaining({
                assetTypeId: 'claude.command',
                targetPath: 'review.md',
            }),
            { serverId: 'server-1' },
        );
    });
});
