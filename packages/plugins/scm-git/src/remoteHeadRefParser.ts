export type GitRemoteHeadRef = Readonly<{
    remoteName: string;
    branch: string;
}>;

function stripTargetBranchPrefix(targetRef: string, remoteName: string): string | null {
    const shortPrefix = `${remoteName}/`;
    if (targetRef.startsWith(shortPrefix)) {
        return targetRef.slice(shortPrefix.length);
    }

    const fullPrefix = `refs/remotes/${remoteName}/`;
    if (targetRef.startsWith(fullPrefix)) {
        return targetRef.slice(fullPrefix.length);
    }

    return null;
}

export function parseGitRemoteHeadRefs(output: string): readonly GitRemoteHeadRef[] {
    const refs: GitRemoteHeadRef[] = [];

    for (const rawLine of output.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;

        const [rawHeadRef, rawTargetRef] = line.split('\t');
        const headRef = rawHeadRef?.trim() ?? '';
        const targetRef = rawTargetRef?.trim() ?? '';
        if (!headRef || !targetRef) continue;

        const remoteName = headRef.endsWith('/HEAD')
            ? headRef.slice(0, -'/HEAD'.length).trim()
            : headRef;
        if (!remoteName) continue;

        const branch = stripTargetBranchPrefix(targetRef, remoteName)?.trim() ?? '';
        if (!branch || branch === 'HEAD') continue;

        refs.push({ remoteName, branch });
    }

    return refs;
}
