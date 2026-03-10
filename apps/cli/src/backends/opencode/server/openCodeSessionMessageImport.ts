import { randomUUID } from 'node:crypto';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { ACPProvider } from '@/api/session/sessionMessageTypes';

import { asRecord, normalizeString } from './openCodeParsing';

function normalizeRole(value: unknown): 'user' | 'assistant' | null {
  const raw = normalizeString(value).trim().toLowerCase();
  if (raw === 'user') return 'user';
  if (raw === 'assistant') return 'assistant';
  return null;
}

function extractCreatedAtMs(info: Record<string, unknown>): number {
  const timeRec = asRecord(info.time);
  const created = timeRec ? timeRec.created : null;
  return typeof created === 'number' && Number.isFinite(created) ? created : 0;
}

function extractTextFromParts(parts: unknown[]): string {
  const out: string[] = [];
  for (const part of parts) {
    const rec = asRecord(part);
    if (!rec) continue;
    if (normalizeString(rec.type) !== 'text') continue;
    const text = normalizeString(rec.text);
    if (text.trim().length === 0) continue;
    out.push(text);
  }
  return out.join('').trim();
}

export type OpenCodeTextHistoryItem = Readonly<{
  messageId: string;
  role: 'user' | 'assistant';
  createdAtMs: number;
  text: string;
}>;

export function extractOpenCodeTextHistoryItems(rawMessages: unknown[]): OpenCodeTextHistoryItem[] {
  if (!Array.isArray(rawMessages)) return [];
  const items: OpenCodeTextHistoryItem[] = [];
  for (const msg of rawMessages) {
    const rec = asRecord(msg);
    if (!rec) continue;
    const info = asRecord(rec.info);
    if (!info) continue;
    const role = normalizeRole(info.role);
    if (!role) continue;
    const messageId = normalizeString(info.id).trim();
    if (!messageId) continue;
    const parts = Array.isArray(rec.parts) ? rec.parts : [];
    const text = extractTextFromParts(parts);
    if (!text) continue;
    items.push({
      messageId,
      role,
      createdAtMs: extractCreatedAtMs(info),
      text,
    });
  }
  items.sort((a, b) => a.createdAtMs - b.createdAtMs);
  return items;
}

function buildImportLocalId(params: { kind: 'history' | 'sidechain'; remoteSessionId: string; messageId: string; sidechainId?: string }): string {
  const sidechainPart = params.kind === 'sidechain' && typeof params.sidechainId === 'string' && params.sidechainId ? `:${params.sidechainId}` : '';
  return `opencode:import:${params.kind}:${params.remoteSessionId}${sidechainPart}:${params.messageId}`;
}

export async function importOpenCodeTextHistoryCommitted(params: Readonly<{
  session: ApiSessionClient;
  provider: ACPProvider;
  remoteSessionId: string;
  items: ReadonlyArray<OpenCodeTextHistoryItem>;
  importedFrom: 'acp-history' | 'acp-sidechain' | 'acp-live-sync';
  sidechainId?: string;
}>): Promise<void> {
  for (const item of params.items) {
    const localId = buildImportLocalId({
      kind: params.importedFrom === 'acp-sidechain' ? 'sidechain' : 'history',
      remoteSessionId: params.remoteSessionId,
      sidechainId: params.sidechainId,
      messageId: item.messageId,
    });
    const meta: Record<string, unknown> = {
      // Prevent imported user messages from being delivered into the agent queue.
      source: 'cli',
      sentFrom: 'cli',
      importedFrom: params.importedFrom,
      remoteSessionId: params.remoteSessionId,
      ...(params.importedFrom === 'acp-sidechain' && params.sidechainId ? { sidechainId: params.sidechainId } : {}),
    };

    if (item.role === 'user') {
      await params.session.sendUserTextMessageCommitted(item.text, { localId, meta });
      continue;
    }
    await params.session.sendAgentMessageCommitted(
      params.provider,
      { type: 'message', message: item.text, ...(params.sidechainId ? { sidechainId: params.sidechainId } : {}) },
      { localId, meta },
    );
  }
}
