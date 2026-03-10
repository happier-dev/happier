import type { OpenCodePermissionRequest } from './types';
import { asRecord, normalizeString, normalizeStringArray } from './openCodeParsing';

export function parsePermissionRequest(raw: unknown): OpenCodePermissionRequest | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const id = normalizeString(rec.id);
  const sessionID = normalizeString(rec.sessionID);
  const permission = normalizeString(rec.permission);
  if (!id || !sessionID || !permission) return null;
  const patterns = normalizeStringArray(rec.patterns);
  const always = normalizeStringArray(rec.always);
  const metadata = (asRecord(rec.metadata) ?? {}) as Record<string, unknown>;
  const toolRec = asRecord(rec.tool);
  const tool = toolRec
    ? { messageID: normalizeString(toolRec.messageID), callID: normalizeString(toolRec.callID) }
    : undefined;
  return { id, sessionID, permission, patterns, metadata, always, ...(tool?.messageID && tool.callID ? { tool } : {}) };
}

