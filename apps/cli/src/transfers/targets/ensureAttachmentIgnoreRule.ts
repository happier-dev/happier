import { dirname, join } from 'path';

import { currentWorkspaceSource } from '@/workspaces/source/workspaceSource';

import type { AttachmentTransferConfig } from './resolveAttachmentTransferTarget';

/** Shared by every workspace ignore-rule writer; reads and writes through the admitted workspace source. */
export async function resolveGitDirBestEffort(workingDirectory: string): Promise<string | null> {
    const dotGitPath = join(workingDirectory, '.git');
    let gitDir: string | null = null;
    try {
        const dotGitStat = await currentWorkspaceSource().stat(dotGitPath);
        if (dotGitStat.isDirectory()) {
            gitDir = dotGitPath;
        } else if (dotGitStat.isFile()) {
            const contents = (await currentWorkspaceSource().readFile(dotGitPath)).toString('utf8');
            const match = contents.match(/^\s*gitdir:\s*(.+)\s*$/mi);
            const raw = match?.[1]?.trim();
            if (raw) {
                gitDir = join(workingDirectory, raw);
            }
        }
    } catch {
        return null;
    }

    if (!gitDir) return null;
    try {
        const gitDirStat = await currentWorkspaceSource().stat(gitDir);
        if (!gitDirStat.isDirectory()) return null;
    } catch {
        return null;
    }
    return gitDir;
}

export function toWorkspaceIgnoreRule(workspaceRelativeDir: string): string {
    const normalized = workspaceRelativeDir.replace(/^[\\/]+/, '').replace(/[\\]+/g, '/');
    return `/${normalized}/`;
}

export async function ensureFileContainsRule(filePath: string, ruleLine: string): Promise<void> {
    let current = '';
    try {
        current = (await currentWorkspaceSource().readFile(filePath)).toString('utf8');
    } catch {
        await currentWorkspaceSource().mkdir(dirname(filePath), { recursive: true });
    }

    const lines = current.split('\n').map((line) => line.trim());
    if (lines.includes(ruleLine)) {
        return;
    }

    const next = current && !current.endsWith('\n') ? `${current}\n${ruleLine}\n` : `${current}${ruleLine}\n`;
    await currentWorkspaceSource().mkdir(dirname(filePath), { recursive: true });
    await currentWorkspaceSource().writeFile(filePath, Buffer.from(next, 'utf8'));
}

export async function ensureAttachmentIgnoreRule(params: Readonly<{
    workingDirectory: string;
    config: AttachmentTransferConfig;
}>): Promise<void> {
    if (
        params.config.uploadLocation !== 'workspace'
        || !params.config.vcsIgnoreWritesEnabled
        || params.config.vcsIgnoreStrategy === 'none'
    ) {
        return;
    }

    const ruleLine = toWorkspaceIgnoreRule(params.config.workspaceRelativeDir);

    if (params.config.vcsIgnoreStrategy === 'git_info_exclude') {
        const gitDir = await resolveGitDirBestEffort(params.workingDirectory);
        if (!gitDir) {
            return;
        }
        await ensureFileContainsRule(join(gitDir, 'info', 'exclude'), ruleLine);
        return;
    }

    if (params.config.vcsIgnoreStrategy === 'gitignore') {
        const gitDir = await resolveGitDirBestEffort(params.workingDirectory);
        if (!gitDir) {
            return;
        }
        await ensureFileContainsRule(join(params.workingDirectory, '.gitignore'), ruleLine);
    }
}
