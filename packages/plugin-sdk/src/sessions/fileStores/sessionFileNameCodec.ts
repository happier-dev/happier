import { open } from 'node:fs/promises';
import { basename } from 'node:path';

import { parseDefaultSessionHeader, parseJsonLine } from './records.js';

const JSONL_EXTENSION = '.jsonl';
const SESSION_FILE_HEAD_BYTES = 64 * 1024;

export function sessionFileNameMatchesSessionId(fileName: string, sessionId: string): boolean {
  if (!fileName.endsWith(JSONL_EXTENSION)) return false;
  const stem = fileName.slice(0, -JSONL_EXTENSION.length);
  if (stem === sessionId) return true;
  if (stem === `session-${sessionId}`) return true;
  return stem.endsWith(`_${sessionId}`);
}

export function isBareSessionFileId(value: string): boolean {
  return (
    value.length > 0
    && !value.includes('\0')
    && !value.includes('/')
    && !value.includes('\\')
    && !value.toLowerCase().endsWith(JSONL_EXTENSION)
  );
}

export function parseSessionIdFromFileName(fileNameOrPath: string): string | null {
  const fileName = basename(fileNameOrPath.trim());
  if (!fileName.toLowerCase().endsWith(JSONL_EXTENSION)) return null;
  const stem = fileName.slice(0, -JSONL_EXTENSION.length);
  if (stem.startsWith('session-') && stem.length > 'session-'.length) {
    return stem.slice('session-'.length) || null;
  }
  const lastUnderscore = stem.lastIndexOf('_');
  if (lastUnderscore >= 0 && lastUnderscore < stem.length - 1) {
    return stem.slice(lastUnderscore + 1) || null;
  }
  return stem || null;
}

export async function readSessionIdFromFileHead(filePath: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(filePath, 'r');
    const buffer = Buffer.alloc(SESSION_FILE_HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0] ?? '';
    return parseDefaultSessionHeader(parseJsonLine(firstLine))?.sessionId ?? null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
