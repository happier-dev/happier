import { classifyScmChangePath } from '@happier-dev/protocol/scm/comparison';
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';

type ReviewFile = Readonly<{
    fullPath: string;
    fileName?: string;
    filePath?: string;
    generated?: boolean;
    lockfile?: boolean;
}>;

/** One inventory projection for picker positions, reveal, folding and hunk order. */
export function buildChangedFilesReviewFileIndex<File extends ReviewFile>(files: readonly File[],
    capturedFiles?: readonly Readonly<{ path: string; generated?: boolean; lockfile?: boolean }>[]) {
    const indexById = new Map<string, number>();
    const generated: boolean[] = [];
    const lockfile: boolean[] = [];
    const defaultCollapsedPaths: string[] = [];
    const items = files.map((file, index): DropdownMenuItem => {
        const path = file.fullPath;
        indexById.set(path, index);
        const classified = classifyScmChangePath(path);
        generated.push(file.generated ?? classified.generated);
        lockfile.push(file.lockfile ?? classified.lockfile);
        // Default folding follows path classification; captured overrides only affect navigation.
        if (classified.generated || classified.lockfile) defaultCollapsedPaths.push(path);
        return { id: path, title: file.fileName ?? path, subtitle: file.filePath, accessibilityLabel: path };
    });
    for (const file of capturedFiles ?? []) {
        const index = indexById.get(file.path);
        if (index === undefined) continue;
        if (file.generated !== undefined) generated[index] = file.generated;
        if (file.lockfile !== undefined) lockfile[index] = file.lockfile;
    }
    const source: number[] = [];
    const output: number[] = [];
    for (let index = 0; index < files.length; index += 1) {
        (generated[index] || lockfile[index] ? output : source).push(index);
    }
    return { files, items, indexById, orderedFileIndices: [...source, ...output], defaultCollapsedPaths };
}

export type ChangedFilesReviewFileIndex = ReturnType<typeof buildChangedFilesReviewFileIndex<ScmFileStatus>>;
export type ChangedFilesReviewFileOrder = Pick<ChangedFilesReviewFileIndex, 'indexById' | 'items' | 'orderedFileIndices'>;
