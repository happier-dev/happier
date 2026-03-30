import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getProjectPath } from '../utils/path';
import { resolveClaudeConfigDirOverride } from '../utils/resolveClaudeConfigDirOverride';
import type { ClaudeSessionBundle } from '../../../session/handoff/types';

function resolveDirectSessionSourceTranscriptPath(params: Readonly<{
  metadata: Record<string, unknown>;
  remoteSessionId: string;
}>): string | null {
  const directSession = params.metadata.directSessionV1;
  if (!directSession || typeof directSession !== 'object' || Array.isArray(directSession)) {
    return null;
  }
  const source = (directSession as { source?: unknown }).source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return null;
  }
  const kind = typeof (source as { kind?: unknown }).kind === 'string' ? String((source as { kind?: string }).kind) : '';
  if (kind !== 'claudeConfig') {
    return null;
  }
  const configDir = typeof (source as { configDir?: unknown }).configDir === 'string'
    ? String((source as { configDir?: string }).configDir).trim()
    : '';
  const projectId = typeof (source as { projectId?: unknown }).projectId === 'string'
    ? String((source as { projectId?: string }).projectId).trim()
    : '';
  if (!configDir || !projectId) {
    return null;
  }
  return join(configDir, 'projects', projectId, `${params.remoteSessionId}.jsonl`);
}

function resolveTranscriptPath(params: Readonly<{
  metadata: Record<string, unknown>;
  remoteSessionId: string;
  env: NodeJS.ProcessEnv;
}>): string {
  const directSessionTranscriptPath = resolveDirectSessionSourceTranscriptPath(params);
  if (directSessionTranscriptPath) return directSessionTranscriptPath;

  const explicit = typeof params.metadata.claudeTranscriptPath === 'string' ? params.metadata.claudeTranscriptPath.trim() : '';
  if (explicit) return explicit;

  const workingDirectory = typeof params.metadata.path === 'string' ? params.metadata.path.trim() : '';
  if (!workingDirectory) {
    throw new Error('Missing Claude working directory for handoff export');
  }

  return join(getProjectPath(workingDirectory, resolveClaudeConfigDirOverride(params.env)), `${params.remoteSessionId}.jsonl`);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveReadableTranscriptPath(params: Readonly<{
  metadata: Record<string, unknown>;
  remoteSessionId: string;
  env: NodeJS.ProcessEnv;
}>): Promise<string> {
  const candidatePaths = [
    resolveDirectSessionSourceTranscriptPath(params),
    typeof params.metadata.claudeTranscriptPath === 'string' ? params.metadata.claudeTranscriptPath.trim() : '',
  ]
    .filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);

  for (const candidatePath of candidatePaths) {
    if (await fileExists(candidatePath)) {
      return candidatePath;
    }
  }

  const fakeTranscriptLog = [
    params.env.HAPPIER_E2E_FAKE_CLAUDE_LOG,
    params.env.HAPPY_E2E_FAKE_CLAUDE_LOG,
  ].find((value) => typeof value === 'string' && value.trim().length > 0);
  if (typeof fakeTranscriptLog === 'string' && (await fileExists(fakeTranscriptLog))) {
    return fakeTranscriptLog;
  }

  const resolved = resolveTranscriptPath(params);
  if (resolved && (await fileExists(resolved))) {
    return resolved;
  }

  return resolved;
}

export async function exportClaudeSessionBundle(params: Readonly<{
  metadata: Record<string, unknown>;
  remoteSessionId: string;
  env: NodeJS.ProcessEnv;
}>): Promise<ClaudeSessionBundle> {
  const transcriptPath = await resolveReadableTranscriptPath(params);
  const transcript = await readFile(transcriptPath, 'utf8');
  return {
    providerId: 'claude',
    remoteSessionId: params.remoteSessionId,
    transcriptBase64: Buffer.from(transcript, 'utf8').toString('base64'),
  };
}
