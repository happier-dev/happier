/** Shared admission and exclusions for the two workspace-file ripgrep operations. */
export function workspaceFileExclusionArguments(): string[] {
    return ['--glob', '!**/.git/**', '--glob', '!**/node_modules/**'];
}

export function isSafeRelativeWorkspacePath(value: string): boolean {
    if (!value || value.includes('\0')) return false;
    if (value.startsWith('/') || value.startsWith('\\')) return false;
    if (/^[A-Za-z]:[\\/]/u.test(value)) return false;
    return !value.replace(/\\/g, '/').split('/').some((segment) => segment === '..');
}
