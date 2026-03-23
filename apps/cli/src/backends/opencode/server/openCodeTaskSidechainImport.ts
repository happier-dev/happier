import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { ACPProvider } from '@/api/session/sessionMessageTypes';

import type { OpenCodeServerRuntimeClient } from './client';
import { extractOpenCodeTextHistoryItems, importOpenCodeTextHistoryCommitted } from './openCodeSessionMessageImport';
import { normalizeString } from './openCodeParsing';
import { delay } from '@/utils/time';

function extractChildSessionIdFromTaskOutput(output: string): string | null {
  const text = output.trim();
  if (!text) return null;
  const match = text.match(/<task_metadata>[\s\S]*?session_id:\s*([^\s<]+)[\s\S]*?<\/task_metadata>/i);
  const id = match?.[1] ? String(match[1]).trim() : '';
  return id ? id : null;
}

function extractChildSessionIdFromMetadata(metadata: unknown): string | null {
  const rec = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : null;
  const id = normalizeString(rec?.sessionId ?? rec?.sessionID ?? rec?.session_id).trim();
  return id ? id : null;
}

export function extractOpenCodeTaskChildSessionId(params: Readonly<{ output: string; metadata: unknown }>): string | null {
  return extractChildSessionIdFromMetadata(params.metadata) ?? extractChildSessionIdFromTaskOutput(params.output);
}

export async function importOpenCodeTaskSidechainBestEffort(params: Readonly<{
  client: OpenCodeServerRuntimeClient;
  session: ApiSessionClient;
  provider: ACPProvider;
  remoteSessionId: string;
  sidechainId: string;
}>): Promise<boolean> {
  const resolvePositiveIntEnv = (raw: string | undefined, fallback: number, bounds: { min: number; max: number }): number => {
    const value = (raw ?? '').trim();
    if (!value) return fallback;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(bounds.max, Math.max(bounds.min, Math.trunc(parsed)));
  };

  const maxWaitMs = resolvePositiveIntEnv(process.env.HAPPIER_OPENCODE_TASK_SIDECHAIN_IMPORT_WAIT_MS, 25_000, { min: 0, max: 120_000 });
  const retryBaseDelayMs = resolvePositiveIntEnv(process.env.HAPPIER_OPENCODE_TASK_SIDECHAIN_IMPORT_RETRY_BASE_DELAY_MS, 250, { min: 0, max: 10_000 });
  const retryMaxDelayMs = resolvePositiveIntEnv(process.env.HAPPIER_OPENCODE_TASK_SIDECHAIN_IMPORT_RETRY_MAX_DELAY_MS, 2_000, { min: 0, max: 30_000 });

  let delayMs = retryBaseDelayMs;
  const startMs = Date.now();
  const deadlineMs = startMs + maxWaitMs;
  while (true) {
    const raw = await params.client.sessionMessagesList({ sessionId: params.remoteSessionId }).catch(() => []);
    const items = extractOpenCodeTextHistoryItems(raw);
    if (items.length > 0) {
      await importOpenCodeTextHistoryCommitted({
        session: params.session,
        provider: params.provider,
        remoteSessionId: params.remoteSessionId,
        items,
        importedFrom: 'acp-sidechain',
        sidechainId: params.sidechainId,
      });
      return true;
    }

    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) return false;

    const nextDelayMs = delayMs <= 0 ? Math.min(remainingMs, 1) : Math.min(delayMs, remainingMs);
    await delay(nextDelayMs);
    if (delayMs > 0) {
      delayMs = Math.min(retryMaxDelayMs, Math.max(delayMs, 1) * 2);
    }
  }
}
