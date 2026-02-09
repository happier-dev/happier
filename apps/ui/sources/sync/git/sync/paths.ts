function normalizePathForScope(path: string): string {
    const replaced = path.replace(/\\/g, '/');
    if (replaced.length <= 1) return replaced;
    return replaced.endsWith('/') ? replaced.slice(0, -1) : replaced;
}

export function isSessionPathWithinRepoRoot(sessionPath: string, repoRoot: string): boolean {
    const normalizedSessionPath = normalizePathForScope(sessionPath);
    const normalizedRepoRoot = normalizePathForScope(repoRoot);
    if (!normalizedSessionPath || !normalizedRepoRoot) return false;
    if (normalizedSessionPath === normalizedRepoRoot) return true;
    return normalizedSessionPath.startsWith(`${normalizedRepoRoot}/`);
}
