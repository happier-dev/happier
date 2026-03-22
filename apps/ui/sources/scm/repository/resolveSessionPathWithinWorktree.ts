function normalizePath(value: string): string {
    const normalizedSeparators = value.trim().replace(/\\+/g, '/');
    const normalizedDriveLetter = normalizedSeparators.replace(/^([A-Z]):/, (_match, driveLetter: string) => `${driveLetter.toLowerCase()}:`);
    const trimmedTrailingSeparator = normalizedDriveLetter.replace(/\/+$/, '');

    return trimmedTrailingSeparator.length > 0 ? trimmedTrailingSeparator : normalizedDriveLetter;
}

function isWindowsPath(value: string): boolean {
    return /^[a-z]:($|\/)/i.test(value);
}

function normalizePathForComparison(value: string): string {
    return isWindowsPath(value) ? value.toLowerCase() : value;
}

function isPathAtOrWithinRoot(path: string, rootPath: string): boolean {
    const comparablePath = normalizePathForComparison(path);
    const comparableRootPath = normalizePathForComparison(rootPath);

    if (comparablePath === comparableRootPath) {
        return true;
    }

    const nextCharacter = comparablePath.charAt(comparableRootPath.length);
    return comparablePath.startsWith(comparableRootPath) && nextCharacter === '/';
}

export function resolveSessionPathWithinWorktree(params: Readonly<{
    selectedPath: string;
    worktreePath: string;
    sourceRootPath: string;
}>): string {
    const normalizedSelectedPath = normalizePath(params.selectedPath);
    const normalizedWorktreePath = normalizePath(params.worktreePath);
    const normalizedSourceRootPath = normalizePath(params.sourceRootPath);

    if (!isPathAtOrWithinRoot(normalizedSelectedPath, normalizedSourceRootPath)) {
        return params.worktreePath;
    }

    const relativePath = normalizedSelectedPath.slice(normalizedSourceRootPath.length).replace(/^\/+/, '');
    if (!relativePath) {
        return params.worktreePath;
    }

    return `${normalizedWorktreePath}/${relativePath}`;
}
