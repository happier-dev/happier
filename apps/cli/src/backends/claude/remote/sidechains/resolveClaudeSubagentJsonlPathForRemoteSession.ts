import { basename, dirname } from 'node:path';

import { resolveClaudeSubagentJsonlPath } from './resolveClaudeSubagentJsonlPath';

function inferClaudeSessionIdFromTranscriptPath(transcriptPath: string | null | undefined): string | null {
  const raw = typeof transcriptPath === 'string' ? transcriptPath.trim() : '';
  if (!raw) return null;
  const base = basename(raw);
  if (!base) return null;
  if (base.endsWith('.jsonl')) {
    const without = base.slice(0, -'.jsonl'.length).trim();
    return without.length > 0 ? without : null;
  }
  return base.trim().length > 0 ? base.trim() : null;
}

export function resolveClaudeSubagentJsonlPathForRemoteSession(params: Readonly<{
  transcriptPath?: string | null;
  projectDir?: string | null;
  claudeSessionId?: string | null;
  agentId: string;
}>): string | null {
  const agentId = String(params.agentId ?? '').trim();
  if (!agentId) return null;

  const projectDir =
    typeof params.projectDir === 'string' && params.projectDir.trim().length > 0
      ? params.projectDir.trim()
      : typeof params.transcriptPath === 'string' && params.transcriptPath.trim().length > 0
        ? dirname(params.transcriptPath.trim())
        : null;
  if (!projectDir) return null;

  const explicitSessionId = typeof params.claudeSessionId === 'string' ? params.claudeSessionId.trim() : '';
  const claudeSessionId = explicitSessionId.length > 0 ? explicitSessionId : inferClaudeSessionIdFromTranscriptPath(params.transcriptPath);
  if (!claudeSessionId) return null;

  return resolveClaudeSubagentJsonlPath({
    projectDir,
    claudeSessionId,
    agentId,
  });
}
