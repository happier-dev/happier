import { asRecord, normalizeString } from './openCodeParsing';

export function extractOpenCodeSessionMessageId(raw: unknown): string | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const info = asRecord(rec.info);
  if (!info) return null;
  const id = normalizeString(info.id).trim();
  return id.length > 0 ? id : null;
}

export function parseOpenCodeToolPart(raw: unknown): {
  sessionID: string;
  messageID: string;
  callID: string;
  tool: string;
  state: Record<string, unknown>;
} | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  if (normalizeString(rec.type) !== 'tool') return null;
  const sessionID = normalizeString(rec.sessionID);
  const messageID = normalizeString(rec.messageID);
  const callID = normalizeString(rec.callID);
  const tool = normalizeString(rec.tool);
  const state = asRecord(rec.state);
  if (!sessionID || !messageID || !callID || !tool || !state) return null;
  return { sessionID, messageID, callID, tool, state };
}

