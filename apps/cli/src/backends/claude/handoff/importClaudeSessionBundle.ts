import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ImportedSessionHandoffBundle } from '../../../session/handoff/types';
import type { ClaudeSessionBundle } from '../../../session/handoff/types';
import { getProjectPath } from '../utils/path';
import { resolveClaudeConfigDirOverride } from '../utils/resolveClaudeConfigDirOverride';

const CLAUDE_STARTUP_TRANSCRIPT_CATCH_UP_LOOKBACK_MS = '60000';

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
  const explicitClaudeConfigDir = resolveClaudeConfigDirOverride(params.env);
  const resolvedClaudeConfigDir = explicitClaudeConfigDir ?? join(homedir(), '.claude');
  const projectDir = getProjectPath(params.targetPath, resolvedClaudeConfigDir);
  await mkdir(projectDir, { recursive: true });

  const transcriptPath = resolveClaudeTranscriptPath(projectDir, params.bundle.remoteSessionId);
  const transcript = Buffer.from(params.bundle.transcriptBase64, 'base64').toString('utf8');
  await writeFile(transcriptPath, transcript, 'utf8');

  return {
    remoteSessionId: params.bundle.remoteSessionId,
    directSource: {
      kind: 'claudeConfig',
      configDir: explicitClaudeConfigDir,
      projectId: null,
    },
      resume: {
      directory: params.targetPath,
      agent: 'claude',
      resume: params.bundle.remoteSessionId,
      environmentVariables: {
        CLAUDE_CONFIG_DIR: resolvedClaudeConfigDir,
        HAPPIER_STARTUP_TRANSCRIPT_CATCH_UP_LOOKBACK_MS: CLAUDE_STARTUP_TRANSCRIPT_CATCH_UP_LOOKBACK_MS,
      },
      transcriptStorage: params.sessionStorageMode === 'persisted' ? 'persisted' : 'direct',
      approvedNewDirectoryCreation: true,
    },
  };
}
