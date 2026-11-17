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
export async function readGitComparisonFiles(input: Readonly<{ cwd: string; before: string; after: string;
    env?: Parameters<typeof readGitCheckpointDiffOutput>[0]['env'] }>): Promise<Readonly<{
    files: readonly GitComparisonFile[];
    reasons: readonly string[];
    enumerationComplete: boolean;
}>> {
    const rawArgs = ['--raw', '--no-abbrev', '-z', '--find-renames', '--find-copies'] as const;
    // One Git process returns the inventory and every patch over the same immutable endpoints;
    // raw lineage and exact-text sections are paired within that response. The inventory is read
    // on its own only when that response is unavailable, so it never depends on patch availability.
    const diff = await readGitCheckpointDiffOutput({ cwd: input.cwd, env: input.env,
        args: [...rawArgs, '--patch', '--binary', '--full-index', input.before, input.after, '--'] });
    const parsed = diff.success ? parseGitComparisonOutput(diff.stdout) : null;
    const paired = parsed && !parsed.error && parsed.sections.length === parsed.files.length ? parsed : null;
    let inventory: ReturnType<typeof parseGitComparisonOutput>;
    if (paired) inventory = paired;
    else {
        const raw = await readGitCheckpointDiffOutput({ cwd: input.cwd, env: input.env, args: [...rawArgs, input.before, input.after, '--'] });
        if (!raw.success) return { files: [], reasons: [raw.stderr || 'Comparison inventory could not be read'], enumerationComplete: false };
        inventory = parseGitComparisonOutput(raw.stdout);
    }
    if (inventory.files.length === 0) return { files: [], reasons: inventory.error ? [inventory.error] : [],
        enumerationComplete: !inventory.error };
    const patches = new Map<string, string>();
    if (paired) paired.files.forEach((file, index) => patches.set(lineageKey(file), paired.sections[index]!));
    const files: GitComparisonFile[] = inventory.files.map((lineage) => {
        const unifiedDiff = patches.get(lineageKey(lineage));
        return { ...lineage,
            binary: unifiedDiff !== undefined ? /GIT binary patch|Binary files .* differ/i.test(unifiedDiff) : null,
            ...(unifiedDiff !== undefined ? { unifiedDiff } : { unavailableReason: diff.stderr || 'Git comparison file evidence could not be paired with its inventory entry' }) };
    });
    return { files, reasons: [...(inventory.error ? [inventory.error] : []),
        ...files.flatMap((file) => file.unavailableReason ? [`${file.path}: ${file.unavailableReason}`] : [])], enumerationComplete: !inventory.error };
}
