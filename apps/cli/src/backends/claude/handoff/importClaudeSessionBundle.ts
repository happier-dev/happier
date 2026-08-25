import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ImportedSessionHandoffBundle } from '../../../session/handoff/types';
import type { ClaudeSessionBundle } from '../../../session/handoff/types';
import { getProjectPath, resolveClaudeProjectId } from '../utils/path';
import { resolveConfiguredClaudeConfigDir } from '../utils/resolveConfiguredClaudeConfigDir';

function resolveClaudeTranscriptPath(projectDir: string, remoteSessionId: string): string {
  if (!remoteSessionId || remoteSessionId.includes('/') || remoteSessionId.includes('\\')) {
    throw new Error(`Invalid remoteSessionId for Claude handoff: ${remoteSessionId}`);
  }
  return join(projectDir, `${remoteSessionId}.jsonl`);
}

export async function importClaudeSessionBundle(params: Readonly<{
  bundle: ClaudeSessionBundle;
  targetPath: string;
  env: NodeJS.ProcessEnv;
  sessionStorageMode?: 'direct' | 'persisted';
}>): Promise<ImportedSessionHandoffBundle> {
  const resolvedClaudeConfigDir = resolveConfiguredClaudeConfigDir({ env: params.env });
  const projectId = resolveClaudeProjectId(params.targetPath);
  const projectDir = getProjectPath(params.targetPath, resolvedClaudeConfigDir);
  const transcriptPath = resolveClaudeTranscriptPath(projectDir, params.bundle.remoteSessionId);
  await mkdir(projectDir, { recursive: true });

  const transcript = Buffer.from(params.bundle.transcriptBase64, 'base64').toString('utf8');
  await writeFile(transcriptPath, transcript, 'utf8');

  return {
    remoteSessionId: params.bundle.remoteSessionId,
    directSource: {
      kind: 'claudeConfig',
      configDir: resolvedClaudeConfigDir,
      projectId,
    },
    resume: {
      directory: params.targetPath,
      agent: 'claude',
      resume: params.bundle.remoteSessionId,
      environmentVariables: {
        CLAUDE_CONFIG_DIR: resolvedClaudeConfigDir,
      },
      transcriptStorage: params.sessionStorageMode === 'persisted' ? 'persisted' : 'direct',
      approvedNewDirectoryCreation: true,
    },
  };
}
