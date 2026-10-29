import { createHash } from 'node:crypto';
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { configuration } from '@/configuration';
import { readJsonlFileBackwardPage } from '@/api/directSessions/filePaging/jsonlBackwardPager';
import { readJsonlFileForward } from '@/api/directSessions/filePaging/jsonlForwardReader';
import { readDirectSessionTitlePage } from '@/api/directSessions/title/readDirectSessionTitlePage';
import { readDirectSessionTitleCandidate } from '@/api/directSessions/title/readDirectSessionTitleCandidate';
import { atomicFileWrite } from '@/utils/fileAtomic';
import { logger } from '@/utils/logger';

const TITLE_SCAN_CHUNK_MAX_BYTES = 128 * 1024;
const TITLE_SCAN_CHUNK_MAX_ITEMS = 64;
const TITLE_SCAN_TOTAL_MAX_BYTES = 1024 * 1024;
const TITLE_SCAN_TOTAL_MAX_ITEMS = 512;

function coerceTextContent(content: unknown): string | null {
  if (typeof content === 'string') {
    return readDirectSessionTitleCandidate(content);
  }
  if (!Array.isArray(content)) return null;

  const parts = content
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return '';
      return typeof (item as Record<string, unknown>).text === 'string'
        ? String((item as Record<string, unknown>).text)
        : '';
    })
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0);

  const text = parts.join(' ');

  return readDirectSessionTitleCandidate(text);
}

const TAIL_TITLE_CACHE_MAX_ENTRIES = 2_048;
const TAIL_TITLE_APPEND_CHUNK_MAX_BYTES = 1024 * 1024;
const TAIL_TITLE_FINGERPRINT_SAMPLE_BYTES = 4 * 1024;
const TAIL_TITLE_CACHE_FILE_VERSION = 1;
const TAIL_TITLE_CACHE_PERSIST_DELAY_MS = 2_000;

// JSON.stringify writes the type values "custom-title" and "ai-title" verbatim, so a line without
// their shared suffix cannot be a title record. Checking raw bytes first skips JSON.parse for
// nearly every transcript line; the record type is still checked after parsing.
const TITLE_RECORD_MARKER = Buffer.from('-title"');

function mayBeTitleRecord(lineBytes: Buffer): boolean {
  return lineBytes.includes(TITLE_RECORD_MARKER);
}

/** Newest title records found in a transcript prefix [0, scannedEndOffsetBytes). */
type ClaudeTailTitleState = Readonly<{
  /** Line-aligned: an incomplete trailing record is left for the next read. */
  scannedEndOffsetBytes: number;
  customTitleSeen: boolean;
  customTitle: string | null;
  aiTitle: string | null;
  /** False only when the scan stopped at a usable custom title before any AI title. */
  aiTitleResolved: boolean;
}>;

type CachedClaudeTailTitleState = ClaudeTailTitleState & Readonly<{
  dev: number;
  ino: number;
  prefixFingerprint: string;
}>;

// Claude transcripts are append-only, but the title scan below must walk the
// whole file to honor an old manual rename. Remember what each file's prefix
// already resolved to so repeated candidate listings only read appended bytes.
const tailTitleStateByFilePath = new Map<string, CachedClaudeTailTitleState>();

function rememberTailTitleState(filePath: string, state: CachedClaudeTailTitleState): void {
  tailTitleStateByFilePath.delete(filePath);
  tailTitleStateByFilePath.set(filePath, state);
  if (tailTitleStateByFilePath.size > TAIL_TITLE_CACHE_MAX_ENTRIES) {
    const oldest = tailTitleStateByFilePath.keys().next().value;
    if (oldest !== undefined) tailTitleStateByFilePath.delete(oldest);
  }
  scheduleTailTitleStatePersist();
}

function forgetTailTitleState(filePath: string): void {
  if (tailTitleStateByFilePath.delete(filePath)) scheduleTailTitleStatePersist();
}

// The cache is also kept on disk so the first listing after a daemon restart only has to
// verify each entry and read appended bytes. Entries are revalidated exactly like in-memory
// ones (dev/ino, size, prefix fingerprint), so a stale or foreign file only costs a rescan.
function resolveTailTitleCachePath(): string {
  return join(dirname(configuration.daemonStateFile), 'claude-direct-session-titles.json');
}

function normalizePersistedTailTitleState(value: unknown): CachedClaudeTailTitleState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const isCount = (field: unknown): field is number => typeof field === 'number' && Number.isSafeInteger(field) && field >= 0;
  const isTitle = (field: unknown): field is string | null => field === null || typeof field === 'string';
  if (!isCount(record.scannedEndOffsetBytes) || !isCount(record.dev) || !isCount(record.ino)) return null;
  if (typeof record.customTitleSeen !== 'boolean' || typeof record.aiTitleResolved !== 'boolean') return null;
  if (!isTitle(record.customTitle) || !isTitle(record.aiTitle) || typeof record.prefixFingerprint !== 'string') return null;
  return {
    scannedEndOffsetBytes: record.scannedEndOffsetBytes,
    customTitleSeen: record.customTitleSeen,
    customTitle: record.customTitle,
    aiTitle: record.aiTitle,
    aiTitleResolved: record.aiTitleResolved,
    dev: record.dev,
    ino: record.ino,
    prefixFingerprint: record.prefixFingerprint,
  };
}

let persistedTailTitleStatesLoad: Promise<void> | null = null;

function readCacheErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  return typeof error.code === 'string' ? error.code : null;
}

function loadPersistedTailTitleStates(): Promise<void> {
  persistedTailTitleStatesLoad ??= (async () => {
    try {
      const parsed = JSON.parse(await readFile(resolveTailTitleCachePath(), 'utf8')) as Record<string, unknown> | null;
      if (parsed?.version !== TAIL_TITLE_CACHE_FILE_VERSION || !Array.isArray(parsed.entries)) return;
      for (const entry of parsed.entries.slice(-TAIL_TITLE_CACHE_MAX_ENTRIES)) {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
        const state = normalizePersistedTailTitleState(entry[1]);
        if (state && !tailTitleStateByFilePath.has(entry[0])) tailTitleStateByFilePath.set(entry[0], state);
      }
    } catch (error) {
      const code = readCacheErrorCode(error);
      if (code !== 'ENOENT') {
        // Parse errors can contain cached title text, so report only the error code.
        logger.warnFile('[directSessions.claude] Failed to read title cache; rebuilding from transcripts', { code });
      }
    }
  })();
  return persistedTailTitleStatesLoad;
}

let tailTitleStatePersistTimer: ReturnType<typeof setTimeout> | null = null;
let tailTitleStatePersistInFlight: Promise<void> | null = null;
let tailTitleStatesDirty = false;

function scheduleTailTitleStatePersist(): void {
  tailTitleStatesDirty = true;
  if (tailTitleStatePersistTimer) return;
  tailTitleStatePersistTimer = setTimeout(() => {
    tailTitleStatePersistTimer = null;
    void flushClaudeTitleCache();
  }, TAIL_TITLE_CACHE_PERSIST_DELAY_MS);
  tailTitleStatePersistTimer.unref?.();
}

/** Writes pending title cache changes now (normally debounced). Best effort. */
export async function flushClaudeTitleCache(): Promise<void> {
  if (tailTitleStatePersistTimer) {
    clearTimeout(tailTitleStatePersistTimer);
    tailTitleStatePersistTimer = null;
  }
  while (tailTitleStatePersistInFlight) await tailTitleStatePersistInFlight;
  if (!tailTitleStatesDirty) return;
  tailTitleStatesDirty = false;

  const body = JSON.stringify({ version: TAIL_TITLE_CACHE_FILE_VERSION, entries: [...tailTitleStateByFilePath.entries()] });
  tailTitleStatePersistInFlight = (async () => {
    const filePath = resolveTailTitleCachePath();
    try {
      await mkdir(dirname(filePath), { recursive: true });
      await atomicFileWrite(filePath, (temporaryPath) => writeFile(temporaryPath, body, { encoding: 'utf8', mode: 0o600 }));
    } catch (error) {
      tailTitleStatesDirty = true;
      logger.warnFile('[directSessions.claude] Failed to write title cache; pending changes retained', { code: readCacheErrorCode(error) });
    }
  })().finally(() => {
    tailTitleStatePersistInFlight = null;
  });
  await tailTitleStatePersistInFlight;
}

/** Detects an in-place rewrite of the already-scanned prefix on the same inode. */
async function readPrefixFingerprint(filePath: string, endOffsetBytes: number): Promise<string> {
  if (endOffsetBytes <= 0) return '';
  const length = Math.min(TAIL_TITLE_FINGERPRINT_SAMPLE_BYTES, endOffsetBytes);
  const handle = await open(filePath, 'r');
  try {
    const head = Buffer.alloc(length);
    const tail = Buffer.alloc(length);
    const headRead = await handle.read(head, 0, length, 0);
    const tailRead = await handle.read(tail, 0, length, endOffsetBytes - length);
    return createHash('sha1')
      .update(String(endOffsetBytes))
      .update(head.subarray(0, headRead.bytesRead))
      .update(tail.subarray(0, tailRead.bytesRead))
      .digest('hex');
  } finally {
    await handle.close();
  }
}

function resolveTailTitle(state: ClaudeTailTitleState): Readonly<{ resolved: boolean; title: string | null }> {
  if (state.customTitleSeen && state.customTitle) return { resolved: true, title: state.customTitle };
  if (!state.aiTitleResolved) return { resolved: false, title: null };
  return { resolved: true, title: state.aiTitle };
}

async function scanTailTitleState(filePath: string, fileSize: number): Promise<ClaudeTailTitleState> {
  let endOffsetBytes = fileSize;
  let scannedEndOffsetBytes: number | null = fileSize > 0 ? null : 0;
  let aiTitle: string | null = null;
  let customTitle: string | null = null;
  let sawAiTitle = false;
  let sawCustomTitle = false;
  const finish = (aiTitleResolved: boolean): ClaudeTailTitleState => ({
    scannedEndOffsetBytes: scannedEndOffsetBytes ?? 0,
    customTitleSeen: sawCustomTitle,
    customTitle,
    aiTitle,
    aiTitleResolved,
  });

  // Claude loads the latest value of each title independently. A later AI
  // metadata snapshot cannot override a manual rename, even on an older page.
  while (endOffsetBytes > 0) {
    const page = await readDirectSessionTitlePage(() => readJsonlFileBackwardPage({
      filePath,
      endOffsetBytes,
      maxBytes: TITLE_SCAN_CHUNK_MAX_BYTES,
      // The byte page already bounds memory. Every JSONL record consumes at
      // least one byte, so do not stop at 64 items and reread the same chunk.
      maxItems: TITLE_SCAN_CHUNK_MAX_BYTES,
      lineFilter: mayBeTitleRecord,
    }));
    if (!page) break;
    // The first page's tail offset excludes an incomplete trailing record.
    if (scannedEndOffsetBytes === null) scannedEndOffsetBytes = page.tailOffsetBytes ?? 0;
    for (let index = page.items.length - 1; index >= 0; index -= 1) {
      const value = page.items[index]?.value;
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      if (!sawCustomTitle && record.type === 'custom-title' && typeof record.customTitle === 'string') {
        sawCustomTitle = true;
        customTitle = readDirectSessionTitleCandidate(record.customTitle);
        if (customTitle) return finish(sawAiTitle);
      }
      if (!sawAiTitle && record.type === 'ai-title' && typeof record.aiTitle === 'string') {
        sawAiTitle = true;
        aiTitle = readDirectSessionTitleCandidate(record.aiTitle);
      }
      if (sawCustomTitle && sawAiTitle) return finish(true);
    }

    if (page.reachedStart || page.nextEndOffsetBytes >= endOffsetBytes) break;
    endOffsetBytes = page.nextEndOffsetBytes;
  }

  return finish(true);
}

/**
 * Folds records appended after the cached prefix; later records supersede earlier ones.
 * Returns null when an appended record cannot be read within the allowance: the caller
 * then falls back to the full backward scan, which still sees records after it.
 */
async function scanAppendedTitleState(
  filePath: string,
  state: ClaudeTailTitleState,
  fileSize: number,
): Promise<ClaudeTailTitleState | null> {
  let { customTitleSeen, customTitle, aiTitle, aiTitleResolved } = state;
  let offsetBytes = state.scannedEndOffsetBytes;
  while (offsetBytes < fileSize) {
    const page = await readDirectSessionTitlePage(() => readJsonlFileForward({
      filePath,
      offsetBytes,
      maxBytes: TAIL_TITLE_APPEND_CHUNK_MAX_BYTES,
      maxItems: TAIL_TITLE_APPEND_CHUNK_MAX_BYTES,
    }));
    if (!page) return null;
    for (const line of page.items) {
      const value = line.value;
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      if (record.type === 'custom-title' && typeof record.customTitle === 'string') {
        customTitleSeen = true;
        customTitle = readDirectSessionTitleCandidate(record.customTitle);
      }
      if (record.type === 'ai-title' && typeof record.aiTitle === 'string') {
        aiTitle = readDirectSessionTitleCandidate(record.aiTitle);
        aiTitleResolved = true;
      }
    }
    if (page.nextOffsetBytes <= offsetBytes) break;
    offsetBytes = page.nextOffsetBytes;
    if (page.reachedEnd) break;
  }
  return { scannedEndOffsetBytes: offsetBytes, customTitleSeen, customTitle, aiTitle, aiTitleResolved };
}

async function readCachedTailTitle(
  filePath: string,
  fileStat: Readonly<{ dev: number; ino: number; size: number }>,
): Promise<Readonly<{ resolved: boolean; title: string | null }>> {
  const cached = tailTitleStateByFilePath.get(filePath);
  if (!cached) return { resolved: false, title: null };
  if (cached.dev !== fileStat.dev || cached.ino !== fileStat.ino || fileStat.size < cached.scannedEndOffsetBytes) {
    return { resolved: false, title: null };
  }
  if (await readPrefixFingerprint(filePath, cached.scannedEndOffsetBytes) !== cached.prefixFingerprint) {
    return { resolved: false, title: null };
  }
  if (fileStat.size === cached.scannedEndOffsetBytes) return resolveTailTitle(cached);

  const next = await scanAppendedTitleState(filePath, cached, fileStat.size);
  if (!next) return { resolved: false, title: null };
  const resolved = resolveTailTitle(next);
  if (resolved.resolved) {
    rememberTailTitleState(filePath, {
      ...next,
      dev: fileStat.dev,
      ino: fileStat.ino,
      prefixFingerprint: await readPrefixFingerprint(filePath, next.scannedEndOffsetBytes),
    });
  }
  return resolved;
}

async function readClaudeTitleFromTail(filePath: string): Promise<string | null> {
  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat) return null;

  await loadPersistedTailTitleStates();
  const cached = await readCachedTailTitle(filePath, fileStat).catch(() => ({ resolved: false, title: null }));
  if (cached.resolved) return cached.title;
  forgetTailTitleState(filePath);

  const state = await scanTailTitleState(filePath, fileStat.size);
  const prefixFingerprint = await readPrefixFingerprint(filePath, state.scannedEndOffsetBytes).catch(() => null);
  if (prefixFingerprint !== null) {
    rememberTailTitleState(filePath, { ...state, dev: fileStat.dev, ino: fileStat.ino, prefixFingerprint });
  }
  return resolveTailTitle(state).title;
}

export async function readClaudeSessionTitle(filePath: string): Promise<string | null> {
  const providerTitle = await readClaudeTitleFromTail(filePath);
  if (providerTitle) return providerTitle;

  let summaryTitle: string | null = null;
  let assistantFallback: string | null = null;
  let offsetBytes = 0;
  let scannedBytes = 0;
  let scannedItems = 0;

  while (scannedBytes < TITLE_SCAN_TOTAL_MAX_BYTES && scannedItems < TITLE_SCAN_TOTAL_MAX_ITEMS) {
    const page = await readDirectSessionTitlePage(() => readJsonlFileForward({
      filePath,
      offsetBytes,
      maxBytes: Math.min(TITLE_SCAN_CHUNK_MAX_BYTES, TITLE_SCAN_TOTAL_MAX_BYTES - scannedBytes),
      maxItems: Math.min(TITLE_SCAN_CHUNK_MAX_ITEMS, TITLE_SCAN_TOTAL_MAX_ITEMS - scannedItems),
    }));
    if (!page) break;

    for (const line of page.items) {
      const value = line.value;
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      const type = typeof record.type === 'string' ? record.type : '';

      if (type === 'summary' && summaryTitle === null) {
        summaryTitle = readDirectSessionTitleCandidate(typeof record.summary === 'string' ? record.summary : '');
        if (summaryTitle) return summaryTitle;
        continue;
      }

      if (type === 'queue-operation') {
        const operation = typeof record.operation === 'string' ? record.operation : '';
        if (operation === 'enqueue') {
          const queuedTitle = coerceTextContent(record.content);
          if (queuedTitle) return queuedTitle;
        }
      }

      const message = record.message && typeof record.message === 'object' && !Array.isArray(record.message)
        ? (record.message as Record<string, unknown>)
        : null;
      const messageTitle = coerceTextContent(message?.content);

      if (type === 'user' && messageTitle) return messageTitle;
      if (type === 'assistant' && assistantFallback === null && messageTitle) {
        assistantFallback = messageTitle;
      }
    }

    if (page.reachedEnd || page.nextOffsetBytes <= offsetBytes) break;
    scannedBytes += Math.max(0, page.nextOffsetBytes - offsetBytes);
    scannedItems += page.items.length;
    offsetBytes = page.nextOffsetBytes;
  }

  return assistantFallback;
}
