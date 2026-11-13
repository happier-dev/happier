/** Shared admission and exclusions for the two workspace-file ripgrep operations. */
/** Folders no workspace-file operation walks into. */
export const WORKSPACE_FILE_EXCLUDED_DIRECTORY_NAMES: ReadonlySet<string> = new Set(['.git', 'node_modules']);

export function workspaceFileExclusionArguments(globFlag: '--glob' | '--iglob' = '--glob'): string[] {
    return [...WORKSPACE_FILE_EXCLUDED_DIRECTORY_NAMES].flatMap((name) => [globFlag, `!**/${name}/**`]);
}

export function isSafeRelativeWorkspacePath(value: string): boolean {
    if (!value || value.includes('\0')) return false;
    if (value.startsWith('/') || value.startsWith('\\')) return false;
    if (/^[A-Za-z]:[\\/]/u.test(value)) return false;
    return !value.replace(/\\/g, '/').split('/').some((segment) => segment === '..');
}
