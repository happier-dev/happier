import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { resolveClaudeConfigDir } from '../../../environment.js';

// Claude Code 2.1.296 keeps 200 sanitized UTF-16 units and suffixes longer
// physical cwd spellings with its absolute signed 32-bit string hash in base 36.
const CLAUDE_PROJECT_ID_MAX_LENGTH = 200;

function resolveWorkingDirectoryForClaudeProjectId(workingDirectory: string): string {
    const resolvedWorkingDirectory = resolve(workingDirectory);
    try {
        return realpathSync(resolvedWorkingDirectory);
    } catch {
        return resolvedWorkingDirectory;
    }
}

export function resolveClaudeProjectId(workingDirectory: string): string {
    const resolvedWorkingDirectory = resolveWorkingDirectoryForClaudeProjectId(workingDirectory);
    const projectId = resolvedWorkingDirectory.replace(/[^a-zA-Z0-9]/g, '-');
    if (projectId.length <= CLAUDE_PROJECT_ID_MAX_LENGTH) {
        return projectId;
    }
    let hash = 0;
    for (let index = 0; index < resolvedWorkingDirectory.length; index++) {
        hash = ((hash << 5) - hash + resolvedWorkingDirectory.charCodeAt(index)) | 0;
    }
    return `${projectId.slice(0, CLAUDE_PROJECT_ID_MAX_LENGTH)}-${Math.abs(hash).toString(36)}`;
}

export function getClaudeProjectPath(
    workingDirectory: string,
    claudeConfigDirOverride?: string | null,
    env: Readonly<Record<string, string | undefined>> = process.env,
): string {
    const claudeConfigDirTrimmed = claudeConfigDirOverride?.trim();
    const claudeConfigDir = claudeConfigDirTrimmed || resolveClaudeConfigDir(env);
    return join(claudeConfigDir, 'projects', resolveClaudeProjectId(workingDirectory));
}
