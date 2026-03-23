import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    return {
        ...actual,
        readFile: vi.fn(actual.readFile),
    };
});

async function makeTempDir(prefix: string): Promise<string> {
    const { mkdtemp } = await import('node:fs/promises');
    return await mkdtemp(join(tmpdir(), prefix));
}

describe('importSessionHandoffWorkspaceArtifacts (sync_changes)', () => {
    it('does not use readFile() while scanning the current target manifest', async () => {
        const { mkdir, writeFile, readFile } = await import('node:fs/promises');
        const readFileMock = readFile as unknown as ReturnType<typeof vi.fn>;

        const {
            buildWorkspaceExportArtifactsWithSourcePathBlobProviderFromTransferEntries,
        } = await import('@/scm/sourceController/workspaceExportPackaging/buildWorkspaceExportArtifactsWithSourcePathBlobProviderFromTransferEntries');
        const {
            createScmSourceControllerWorkspaceExportArtifacts,
        } = await import('@/scm/sourceController/workspaceExportArtifacts');
        const {
            importSessionHandoffWorkspaceArtifacts,
        } = await import('./sessionHandoffWorkspaceArtifacts');

        const root = await makeTempDir('handoff-sync-target-manifest-scan-');
        const source = join(root, 'source');
        const target = join(root, 'target');
        await mkdir(source, { recursive: true });
        await mkdir(target, { recursive: true });

        await writeFile(join(target, 'README.md'), 'old\n');
        await writeFile(join(target, 'remove-me.txt'), 'remove\n');
        await writeFile(join(source, 'README.md'), 'new\n');
        await writeFile(join(source, 'keep.txt'), 'keep\n');

        const sourceEntries = [
            { relativePath: 'README.md', sourcePath: join(source, 'README.md') },
            { relativePath: 'keep.txt', sourcePath: join(source, 'keep.txt') },
        ] as const;
        const sourceArtifactsWithProvider = await buildWorkspaceExportArtifactsWithSourcePathBlobProviderFromTransferEntries({
            entries: sourceEntries,
        });
        const workspaceExportArtifacts = createScmSourceControllerWorkspaceExportArtifacts({
            manifest: sourceArtifactsWithProvider.manifest,
            blobContentsByDigest: new Map(),
            sourceControllerMetadata: null,
        });

        readFileMock.mockClear();

        await importSessionHandoffWorkspaceArtifacts({
            workspaceExportArtifacts,
            blobProvider: sourceArtifactsWithProvider.blobProvider,
            targetPath: target,
            workspaceTransfer: {
                enabled: true,
                strategy: 'sync_changes',
                conflictPolicy: 'replace_existing',
                includeIgnoredMode: 'exclude',
                ignoredIncludeGlobs: [],
            },
        });

        const targetPathPrefix = `${target}/`;
        const targetReadCalls = readFileMock.mock.calls.filter((call) => {
            const candidatePath = call[0];
            return typeof candidatePath === 'string' && candidatePath.startsWith(targetPathPrefix);
        });
        expect(targetReadCalls).toEqual([]);
    });
});
