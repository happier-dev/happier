import { stat } from 'node:fs/promises';

import { isChangeTitleToolNameAlias } from '@happier-dev/plugin-sdk/sessions';
import { isPluginError, isRecord } from '@happier-dev/plugin-sdk';
import { readSessionInputPromptUserTextV1 } from '@happier-dev/plugin-sdk/sessions/external';
import { readJsonlFileForwardLines } from '@happier-dev/plugin-sdk/sessions/file-stores';
import { projectExternalSessionCandidateTitle } from '@happier-dev/protocol/sessions/external/daemonRpcV1';

import {
  createCodexExternalSessionJsonlScannerFileSystem,
  throwIfCodexExternalSessionInvocationStopped,
  type CodexExternalSessionInvocationBounds,
} from '../../surfaces/sessions/external/invocationBounds.js';
import { mapCodexRolloutEventToActions } from '../projection/actions.js';
import { classifyCodexSessionThread, type CodexSessionThread } from './sessionThread.js';

const CODEX_TITLE_SCAN_CHUNK_MAX_BYTES = 128 * 1024;
const CODEX_TITLE_SCAN_MAX_TRAVERSED_BYTES = 512 * 1024;

const CODEX_TITLE_BOILERPLATE_PATTERNS = [
  '<environment_context>',
  '<instructions>',
  '<turn_aborted>',
  '# agents.md instructions',
] as const;

/**
 * The single normalization rule for a Codex candidate title: collapse
 * whitespace and reject harness boilerplate rather than
 * presenting it as a session title.
 */
export function readCodexExternalSessionTitleCandidate(
  value: unknown,
  /** `prompt`: the value is a user prompt, titled by its visible words (Happier's delivery frame left out). */
  options?: Readonly<{ source: 'prompt' }>,
): string | null {
  if (typeof value !== 'string') return null;
  const normalized = projectExternalSessionCandidateTitle(readSessionInputPromptUserTextV1(value), options).replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  const lowerTitle = normalized.toLowerCase();
  if (CODEX_TITLE_BOILERPLATE_PATTERNS.some((pattern) => lowerTitle.includes(pattern))) {
    return null;
  }
  return normalized || null;
}

function readTitleFromCodexTitleToolInput(input: unknown): string | null {
  return readCodexExternalSessionTitleCandidate(isRecord(input) ? input.title : null);
}

export type CodexRolloutHead = Readonly<{
  title: string | null;
  cwd?: string;
  /** From line 1's `session_meta`, which this read traverses anyway. */
  thread: CodexSessionThread | null;
}>;

/**
 * What a head read must produce. `includeThreadTitles: false` is for listings
 * that drop internal threads: line 1 classifies the thread, so its title window
 * is never read for a row the caller discards.
 */
export type CodexRolloutHeadReadScope = Readonly<{ includeTitles?: boolean; includeThreadTitles?: boolean }>;

/**
 * The single title and thread-classification reader for both corpus rows and
 * selected candidates. Both use the earliest rollout file and the same head
 * allowance; classification costs no additional file open. Every record in
 * that head is eligible to supply an explicit title before the first genuine
 * user message is used as a fallback.
 */
export async function readCodexRolloutHead(
  filePath: string,
  bounds: CodexExternalSessionInvocationBounds & CodexRolloutHeadReadScope,
): Promise<CodexRolloutHead> {
  let thread: CodexSessionThread | null = null;
  let cwd: string | undefined;
  let firstRecord = true;
  let fallbackUserText: string | null = null;
  let offsetBytes = 0;
  let traversedBytes = 0;
  while (traversedBytes < CODEX_TITLE_SCAN_MAX_TRAVERSED_BYTES) {
    throwIfCodexExternalSessionInvocationStopped(bounds);
    const remainingTraversalBytes = CODEX_TITLE_SCAN_MAX_TRAVERSED_BYTES - traversedBytes;
    const pageMaxBytes = Math.min(CODEX_TITLE_SCAN_CHUNK_MAX_BYTES, remainingTraversalBytes);
    const page = await readJsonlFileForwardLines({
      filePath,
      offsetBytes,
      maxBytes: pageMaxBytes,
      // A nonempty record consumes at least one byte. Let the byte page own
      // this read; an independent row ceiling rereads its unconsumed suffix.
      maxItems: bounds.includeTitles === false ? 1 : pageMaxBytes,
      // One native read per advisory page, through the shared scanner owner.
      chunkBytes: pageMaxBytes,
      // A single record may never cost more than what is left of the traversal
      // budget. Without this the scanner follows one multi-megabyte line for up
      // to its own 8 MB oversize allowance, which is the whole read's cost bound
      // escaping through one pathological record.
      maxOversizeLineBytes: remainingTraversalBytes,
      signal: bounds.signal,
      fileSystem: createCodexExternalSessionJsonlScannerFileSystem(bounds),
    }).catch((error: unknown) => {
      if (!isPluginError(error) || error.code !== 'JSONL_RECORD_TOO_LARGE') throw error;
      // This is advisory metadata, not a transcript completion claim.
      console.warn(`[codex] Rollout title scan stopped: ${error.message}`);
      return null;
    });
    throwIfCodexExternalSessionInvocationStopped(bounds);
    if (!page) break;

    for (const line of page.items) {
      throwIfCodexExternalSessionInvocationStopped(bounds);
      if (line.value === null) continue;
      if (firstRecord) {
        firstRecord = false;
        if (isRecord(line.value) && line.value.type === 'session_meta') {
          thread = classifyCodexSessionThread(line.value.payload);
          if (isRecord(line.value.payload) && typeof line.value.payload.cwd === 'string' && line.value.payload.cwd.trim()) cwd = line.value.payload.cwd;
        }
        // Index ingestion needs source classification, not a display title.
        // Keep the same decoder and native head budget for large metadata rows.
        if (bounds.includeTitles === false || (thread && bounds.includeThreadTitles === false)) {
          return { title: null, thread, ...(cwd ? { cwd } : {}) };
        }
      }
      for (const action of mapCodexRolloutEventToActions(line.value, { debug: false })) {
        if (action.type === 'tool-call' && isChangeTitleToolNameAlias(action.name)) {
          const title = readTitleFromCodexTitleToolInput(action.input);
          if (title) return { title, thread, ...(cwd ? { cwd } : {}) };
        }
        if (action.type === 'user-text' && fallbackUserText === null) {
          fallbackUserText = readCodexExternalSessionTitleCandidate(action.text, { source: 'prompt' });
        }
      }
    }

    if (page.reachedEnd || page.nextOffsetBytes <= offsetBytes) break;
    traversedBytes += Math.max(0, page.nextOffsetBytes - offsetBytes);
    offsetBytes = page.nextOffsetBytes;
  }

  return { title: fallbackUserText, thread, ...(cwd ? { cwd } : {}) };
}

/**
 * The host candidate index's private checkpoint for one rollout head. The head
 * this module reads is a pure function of the file's first
 * `CODEX_TITLE_SCAN_MAX_TRAVERSED_BYTES`: every page and oversize-record
 * allowance is drawn from what is left of that traversal. Rollouts are
 * append-only, so once the same file (device, inode, birth time) is longer than
 * that window its head can no longer change; a shorter file is reused only while
 * its size and mtime are unchanged.
 */
export type CodexRolloutHeadIndexState = Readonly<{
  v: 1;
  kind: 'codex_rollout_head';
  device: string;
  inode: string;
  birthtimeNs: string;
  sizeBytes: number;
  mtimeNs: string;
  title: string | null;
  cwd: string | null;
  thread: CodexSessionThread | null;
}>;

function readCodexRolloutHeadIndexState(value: unknown): CodexRolloutHeadIndexState | null {
  if (!isRecord(value) || value.v !== 1 || value.kind !== 'codex_rollout_head') return null;
  const { device, inode, birthtimeNs, sizeBytes, mtimeNs, title, cwd, thread } = value;
  if (typeof device !== 'string' || typeof inode !== 'string' || typeof birthtimeNs !== 'string'
    || typeof mtimeNs !== 'string' || !Number.isSafeInteger(sizeBytes) || (sizeBytes as number) < 0) return null;
  if (title !== null && typeof title !== 'string') return null;
  if (cwd !== null && typeof cwd !== 'string') return null;
  if (thread !== null && (!isRecord(thread)
    || (thread.kind !== 'reviewer' && thread.kind !== 'subagent')
    || (thread.parentRemoteSessionId !== null && typeof thread.parentRemoteSessionId !== 'string'))) return null;
  return value as CodexRolloutHeadIndexState;
}

/**
 * Reads a rollout head unless the host-supplied checkpoint proves it unchanged.
 * Only an unreadable file falls back to the plain read, so a stat failure never
 * hides a title the read could still produce.
 */
export async function readCodexRolloutHeadWithIndexState(
  filePath: string,
  bounds: CodexExternalSessionInvocationBounds & CodexRolloutHeadReadScope,
  previousState: unknown,
): Promise<Readonly<{ head: CodexRolloutHead; indexState?: CodexRolloutHeadIndexState }>> {
  const identity = await stat(filePath, { bigint: true }).catch(() => null);
  throwIfCodexExternalSessionInvocationStopped(bounds);
  if (!identity || identity.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { head: await readCodexRolloutHead(filePath, bounds) };
  }
  const current = {
    device: identity.dev.toString(),
    inode: identity.ino.toString(),
    birthtimeNs: identity.birthtimeNs.toString(),
    sizeBytes: Number(identity.size),
    mtimeNs: identity.mtimeNs.toString(),
  };
  const previous = readCodexRolloutHeadIndexState(previousState);
  if (
    previous
    && previous.device === current.device
    && previous.inode === current.inode
    && previous.birthtimeNs === current.birthtimeNs
    && (
      (previous.sizeBytes > CODEX_TITLE_SCAN_MAX_TRAVERSED_BYTES && current.sizeBytes >= previous.sizeBytes)
      || (previous.sizeBytes === current.sizeBytes && previous.mtimeNs === current.mtimeNs)
    )
  ) {
    return {
      head: {
        title: previous.title,
        thread: previous.thread,
        ...(previous.cwd ? { cwd: previous.cwd } : {}),
      },
      indexState: previous,
    };
  }
  const head = await readCodexRolloutHead(filePath, bounds);
  return {
    head,
    indexState: Object.freeze({
      v: 1,
      kind: 'codex_rollout_head',
      ...current,
      title: head.title,
      cwd: head.cwd ?? null,
      thread: head.thread,
    }),
  };
}
