import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceId,
} from '@happier-dev/protocol';

import type { CatalogAgentId } from '@/backends/types';
import { materializeClaudeConnectedServiceAuth } from '@/backends/claude/connectedServices/materializeClaudeConnectedServiceAuth';
import { materializeCodexConnectedServiceAuth } from '@/backends/codex/connectedServices/materializeCodexConnectedServiceAuth';
import { materializeGeminiConnectedServiceAuth } from '@/backends/gemini/connectedServices/materializeGeminiConnectedServiceAuth';
import { materializeOpenCodeConnectedServiceAuth } from '@/backends/opencode/connectedServices/materializeOpenCodeConnectedServiceAuth';
import { materializePiConnectedServiceAuth } from '@/backends/pi/connectedServices/materializePiConnectedServiceAuth';
import { normalizeMaterializationKeyForPath } from './normalizeMaterializationKeyForPath';

type MaterializeResult = Readonly<{
  env: Record<string, string>;
  cleanupOnFailure: (() => void) | null;
  cleanupOnExit: (() => void) | null;
}>;

function bestEffortCleanupDirectory(path: string): () => void {
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    void rm(path, { recursive: true, force: true }).catch(() => {});
  };
}

export async function materializeConnectedServicesForSpawn(params: Readonly<{
  agentId: CatalogAgentId;
  materializationKey: string;
  baseDir: string;
  recordsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceCredentialRecordV1>;
}>): Promise<MaterializeResult | null> {
  const env: Record<string, string> = {};

  const materializationSegment = normalizeMaterializationKeyForPath(params.materializationKey);
  const rootDir = join(params.baseDir, materializationSegment, params.agentId);
  const cleanupRoot = bestEffortCleanupDirectory(rootDir);

  const codex = params.recordsByServiceId.get('openai-codex') ?? null;
  const anthropic = params.recordsByServiceId.get('anthropic') ?? null;
  const gemini = params.recordsByServiceId.get('gemini') ?? null;

  if (params.agentId === 'codex') {
    if (!codex) return null;
    const materialized = await materializeCodexConnectedServiceAuth({ rootDir, record: codex });
    Object.assign(env, materialized.env);
    return { env, cleanupOnFailure: cleanupRoot, cleanupOnExit: cleanupRoot };
  }

  if (params.agentId === 'claude') {
    if (!anthropic) return null;
    Object.assign(env, materializeClaudeConnectedServiceAuth({ record: anthropic }).env);
    return { env, cleanupOnFailure: null, cleanupOnExit: null };
  }

  if (params.agentId === 'opencode') {
    if (!codex && !anthropic) return null;
    const materialized = await materializeOpenCodeConnectedServiceAuth({ rootDir, openaiCodex: codex, anthropic });
    Object.assign(env, materialized.env);
    return { env, cleanupOnFailure: cleanupRoot, cleanupOnExit: cleanupRoot };
  }

  if (params.agentId === 'pi') {
    if (!codex && !anthropic) return null;
    const materialized = await materializePiConnectedServiceAuth({ rootDir, openaiCodex: codex, anthropic });
    Object.assign(env, materialized.env);
    return { env, cleanupOnFailure: cleanupRoot, cleanupOnExit: cleanupRoot };
  }

  if (params.agentId === 'gemini') {
    if (!gemini) return null;
    const materialized = await materializeGeminiConnectedServiceAuth({ rootDir, record: gemini });
    Object.assign(env, materialized.env);
    return { env, cleanupOnFailure: cleanupRoot, cleanupOnExit: cleanupRoot };
  }

  return null;
}
