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

function lineageKey(lineage: GitFileLineage): string {
    return JSON.stringify([lineage.path, lineage.previousPath, lineage.beforeBlobId, lineage.afterBlobId]);
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
    if (inventory.files.length === 0) return { files: [], reasons: inventory.error ? [inventory.error] : [],
        enumerationComplete: !inventory.error };
    // Keep inventory independent of patch availability, but acquire all patches
    // in one Git operation over the same immutable endpoints. Pair raw lineage
    // and exact-text sections within that response before projecting the inventory.
    const diff = await readGitCheckpointDiffOutput({ cwd: input.cwd,
        args: ['--raw', '--no-abbrev', '-z', '--find-renames', '--find-copies', '--patch', '--binary', '--full-index',
            input.before, input.after, '--'] });
    const patches = new Map<string, string>();
    if (diff.success) {
        const parsed = parseGitComparisonOutput(diff.stdout);
        if (!parsed.error && parsed.sections.length === parsed.files.length) {
            parsed.files.forEach((lineage, index) => patches.set(lineageKey(lineage), parsed.sections[index]!));
        }
    }
    const files: GitComparisonFile[] = inventory.files.map((lineage) => {
        const unifiedDiff = patches.get(lineageKey(lineage));
        return { ...lineage,
            binary: unifiedDiff !== undefined ? /GIT binary patch|Binary files .* differ/i.test(unifiedDiff) : null,
            ...(unifiedDiff !== undefined ? { unifiedDiff } : { unavailableReason: diff.stderr || 'Git comparison file evidence could not be paired with its inventory entry' }) };
    });
    return { files, reasons: [...(inventory.error ? [inventory.error] : []),
        ...files.flatMap((file) => file.unavailableReason ? [`${file.path}: ${file.unavailableReason}`] : [])], enumerationComplete: !inventory.error };
}
