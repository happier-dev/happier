import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { ACPProvider } from '@/api/session/sessionMessageTypes';

import type { OpenCodeServerRuntimeClient } from './client';
import { extractOpenCodeTextHistoryItems, importOpenCodeTextHistoryCommitted } from './openCodeSessionMessageImport';

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

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
  const raw = await params.client.sessionMessagesList({ sessionId: params.remoteSessionId }).catch(() => []);
  const items = extractOpenCodeTextHistoryItems(raw);
  if (items.length === 0) return false;
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
