const { createHash } = require('node:crypto');
const { realpathSync } = require('node:fs');
const path = require('node:path');

const CLAUDE_PROJECT_ID_MAX_LENGTH = 120;
const CLAUDE_PROJECT_ID_HASH_LENGTH = 16;
const CLAUDE_PROJECT_ID_PREFIX_LENGTH = 48;

function sanitizeClaudeProjectId(value) {
  return String(value ?? '').replace(/[^a-zA-Z0-9-]/g, '-');
}

function resolveShortClaudeProjectId(resolvedWorkingDirectory) {
  const directoryName = sanitizeClaudeProjectId(path.basename(resolvedWorkingDirectory).trim()) || 'workspace';
  const shortDirectoryName = directoryName.slice(0, CLAUDE_PROJECT_ID_PREFIX_LENGTH).replace(/^-+|-+$/g, '') || 'workspace';
  const digest = createHash('sha256').update(resolvedWorkingDirectory, 'utf8').digest('hex').slice(0, CLAUDE_PROJECT_ID_HASH_LENGTH);
  return `${shortDirectoryName}-${digest}`;
}

function resolveClaudeProjectId(workingDirectory) {
  const absoluteWorkingDirectory = path.resolve(String(workingDirectory ?? ''));
  let resolvedWorkingDirectory = absoluteWorkingDirectory;
  try {
    resolvedWorkingDirectory = realpathSync(absoluteWorkingDirectory);
  } catch {
    // Match the production owner: nonexistent paths retain their absolute spelling.
  }
  const projectId = sanitizeClaudeProjectId(resolvedWorkingDirectory);
  if (projectId.length <= CLAUDE_PROJECT_ID_MAX_LENGTH) {
    return projectId;
  }
  return resolveShortClaudeProjectId(resolvedWorkingDirectory);
}

module.exports = {
  resolveClaudeProjectId,
};
