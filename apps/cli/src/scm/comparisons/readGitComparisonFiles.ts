import type { FileChangeKind } from '@happier-dev/protocol';
import { parseGitComparisonOutput, type GitFileLineage } from '@happier-dev/cli-common/scm/gitComparisonOutput';
import { readGitCheckpointDiffOutput } from '../checkpoints/gitCheckpointDiffOutput';

export type GitComparisonFile = Readonly<{
    path: string;
    previousPath?: string;
    changeKind: FileChangeKind;
    beforeBlobId?: string;
    afterBlobId?: string;
    binary: boolean | null;
    unifiedDiff?: string;
    unavailableReason?: string;
}>;

function selectLineageDiff(output: string, lineage: GitFileLineage): string | undefined {
    const parsed = parseGitComparisonOutput(output);
    if (parsed.error) return undefined;
    const index = parsed.files.findIndex((file) => file.path === lineage.path && file.previousPath === lineage.previousPath
        && file.beforeBlobId === lineage.beforeBlobId && file.afterBlobId === lineage.afterBlobId);
    if (index < 0 || !parsed.sections.length) return undefined;
    return parsed.sections.length === parsed.files.length ? parsed.sections[index] : undefined;
}

/** The one tree comparison reader serves turn, session, pending and immutable history. */
export async function readGitComparisonFiles(input: Readonly<{ cwd: string; before: string; after: string }>): Promise<Readonly<{
    files: readonly GitComparisonFile[];
    reasons: readonly string[];
    enumerationComplete: boolean;
}>> {
    const raw = await readGitCheckpointDiffOutput({ cwd: input.cwd,
        args: ['--raw', '--no-abbrev', '-z', '--find-renames', '--find-copies', input.before, input.after, '--'] });
    if (!raw.success) return { files: [], reasons: [raw.stderr || 'Comparison inventory could not be read'], enumerationComplete: false };
    const inventory = parseGitComparisonOutput(raw.stdout);
    const files: GitComparisonFile[] = [];
    for (const lineage of inventory.files) {
        const paths = lineage.previousPath ? [lineage.previousPath, lineage.path] : [lineage.path];
        const diff = await readGitCheckpointDiffOutput({ cwd: input.cwd,
            args: ['--raw', '--no-abbrev', '-z', '--find-renames', '--find-copies', '--patch', '--binary', '--full-index',
                input.before, input.after, '--', ...paths.map((path) => `:(literal)${path}`)] });
        const unifiedDiff = diff.success ? selectLineageDiff(diff.stdout, lineage) : undefined;
        files.push({ ...lineage,
            binary: unifiedDiff !== undefined ? /GIT binary patch|Binary files .* differ/i.test(unifiedDiff) : null,
            ...(unifiedDiff !== undefined ? { unifiedDiff } : { unavailableReason: diff.stderr || 'Git comparison file evidence could not be paired with its inventory entry' }) });
    }
    return { files, reasons: [...(inventory.error ? [inventory.error] : []),
        ...files.flatMap((file) => file.unavailableReason ? [`${file.path}: ${file.unavailableReason}`] : [])], enumerationComplete: !inventory.error };
}
