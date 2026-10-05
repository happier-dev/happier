import { splitUnifiedDiffByFile, type FileChangeKind } from '@happier-dev/protocol';

export type GitFileLineage = Readonly<{
    path: string;
    previousPath?: string;
    changeKind: FileChangeKind;
    beforeBlobId?: string;
    afterBlobId?: string;
}>;

function changeKind(status: string): FileChangeKind {
    switch (status[0]) {
        case 'A': return 'added'; case 'D': return 'deleted'; case 'R': return 'renamed'; case 'C': return 'copied';
        case 'M': case 'T': return 'modified'; default: return 'unknown';
    }
}

/** Git emits raw -z lineage and patch sections from the same ordered diff queue. */
export function parseGitComparisonOutput(output: string): Readonly<{
    files: readonly GitFileLineage[];
    sections: readonly string[];
    error?: string;
}> {
    // Literal names stay in the raw records; quoted patch headers need no decoding.
    const patchOffset = output.indexOf('\0\0');
    const tokens = (patchOffset < 0 ? output : output.slice(0, patchOffset)).split('\0');
    const sections = patchOffset < 0 ? [] : splitUnifiedDiffByFile(output.slice(patchOffset + 2), { preserveText: true });
    const files: GitFileLineage[] = [];
    for (let index = 0; index < tokens.length && tokens[index];) {
        const match = /^:\d+ \d+ ([a-f0-9]+) ([a-f0-9]+) ([A-Z][0-9]*)$/.exec(tokens[index++] ?? '');
        if (!match) return { files, sections, error: 'Git returned an invalid comparison inventory entry' };
        const status = match[3] ?? '';
        const previousPath = tokens[index++];
        const path = status.startsWith('R') || status.startsWith('C') ? tokens[index++] : previousPath;
        if (!path) return { files, sections, error: 'Git returned a comparison entry without a path' };
        files.push({ path, ...(previousPath && previousPath !== path ? { previousPath } : {}), changeKind: changeKind(status),
            ...(!/^0+$/.test(match[1] ?? '') ? { beforeBlobId: match[1] } : {}),
            ...(!/^0+$/.test(match[2] ?? '') ? { afterBlobId: match[2] } : {}) });
    }
    return { files, sections };
}
