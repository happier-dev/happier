function splitFileName(fileName: string): { stem: string; ext: string } {
    const name = fileName.trim();
    const dot = name.lastIndexOf('.');
    if (dot <= 0 || dot === name.length - 1) {
        return { stem: name, ext: '' };
    }
    return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

function withKeepBothSuffix(fileName: string, n: number): string {
    const { stem, ext } = splitFileName(fileName);
    if (!stem) return fileName;
    return `${stem} (${n})${ext}`;
}

export async function resolveKeepBothTargetPath(input: Readonly<{
    desiredPath: string;
    usedPaths?: ReadonlySet<string>;
    maxAttempts: number;
    pathExists: (path: string) => Promise<boolean>;
}>): Promise<string> {
    const desired = input.desiredPath.trim().replace(/\/+$/g, '');
    if (!desired) return desired;

    const usedPaths = new Set<string>(input.usedPaths ?? []);
    if (!usedPaths.has(desired) && !(await input.pathExists(desired))) {
        usedPaths.add(desired);
        return desired;
    }

    const lastSlash = desired.lastIndexOf('/');
    const dir = lastSlash >= 0 ? desired.slice(0, lastSlash) : '';
    const base = lastSlash >= 0 ? desired.slice(lastSlash + 1) : desired;

    for (let n = 1; n <= input.maxAttempts; n += 1) {
        const candidateBase = withKeepBothSuffix(base, n);
        const candidate = dir ? `${dir}/${candidateBase}` : candidateBase;
        if (usedPaths.has(candidate)) continue;
        if (!(await input.pathExists(candidate))) {
            usedPaths.add(candidate);
            return candidate;
        }
    }

    return desired;
}
