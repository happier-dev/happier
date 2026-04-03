import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const CLAUDE_PROJECT_ID_MAX_LENGTH = 120;
const CLAUDE_PROJECT_ID_HASH_LENGTH = 16;
const CLAUDE_PROJECT_ID_PREFIX_LENGTH = 48;

function sanitizeClaudeProjectId(value: string): string {
  return value.replace(/[^a-zA-Z0-9-]/g, '-');
}

function resolveShortClaudeProjectId(resolvedWorkingDirectory: string): string {
  const directoryName = sanitizeClaudeProjectId(basename(resolvedWorkingDirectory).trim()) || 'workspace';
  const shortDirectoryName = directoryName.slice(0, CLAUDE_PROJECT_ID_PREFIX_LENGTH).replace(/^-+|-+$/g, '') || 'workspace';
  const digest = createHash('sha256').update(resolvedWorkingDirectory, 'utf8').digest('hex').slice(0, CLAUDE_PROJECT_ID_HASH_LENGTH);
  return `${shortDirectoryName}-${digest}`;
}

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
  const projectId = sanitizeClaudeProjectId(resolvedWorkingDirectory);
  if (projectId.length <= CLAUDE_PROJECT_ID_MAX_LENGTH) {
    return projectId;
  }
  return resolveShortClaudeProjectId(resolvedWorkingDirectory);
}

export function getProjectPath(workingDirectory: string, claudeConfigDirOverride?: string | null) {
  const claudeConfigDirRaw = claudeConfigDirOverride ?? process.env.CLAUDE_CONFIG_DIR ?? '';
  const claudeConfigDirTrimmed = claudeConfigDirRaw.trim();
  const claudeConfigDir = claudeConfigDirTrimmed ? claudeConfigDirTrimmed : join(homedir(), '.claude');
  return join(claudeConfigDir, 'projects', resolveClaudeProjectId(workingDirectory));
}
