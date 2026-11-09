/** @moduleRealm daemon */
import { open, stat } from 'node:fs/promises';

import { createExternalSessionContentMatchSnippet } from '../promptDisplay.js';
import type { AgentExternalSessionsInvocation } from '../../externalSessions.js';
import type { JsonlScannerFileSystemV1 } from './boundedJsonlScanner.js';

export class ExternalSessionContentSearchYield extends Error {}

/** Source binding and native branch cursors remain owned by the decoder. */
export type ExternalSessionContentSearchPageProgress = {
  cursor?: string;
  complete: boolean;
  itemCount: number;
  match: { cursor?: string; id: string; distanceFromEnd: number } | null;
};

export type ExternalSessionContentSearchControl = Readonly<{
  signal?: AbortSignal;
  /** The optional legacy estimate reset is accepted but no longer needed. */
  checkWork(resetEstimate?: boolean): void;
  assertNotYielded(): void;
  /** Commit one native step before yielding; true completes the phase. */
  prepare(step: () => Promise<boolean>): Promise<void>;
  fileSystem: JsonlScannerFileSystemV1;
}>;

/** Cooperative scanning governed only by the invocation's host deadline. */
export function createExternalSessionContentSearchControl(bounds: Readonly<{ signal?: AbortSignal; deadlineAtMs?: number }>): ExternalSessionContentSearchControl {
  let yielded = false;
  const checkWork = () => {
    bounds.signal?.throwIfAborted();
    if (yielded || (bounds.deadlineAtMs !== undefined && Date.now() >= bounds.deadlineAtMs)) {
      yielded = true;
      throw new ExternalSessionContentSearchYield();
    }
  };
  const assertNotYielded = () => {
    bounds.signal?.throwIfAborted();
    if (yielded) throw new ExternalSessionContentSearchYield();
  };
  return {
    signal: bounds.signal,
    checkWork,
    assertNotYielded,
    async prepare(step) {
      assertNotYielded();
      while (true) {
        assertNotYielded();
        // Native state owns the result and resume position. The indivisible
        // step commits both before cooperative scheduling can interrupt it.
        const complete = await step();
        assertNotYielded();
        if (complete) return;
        checkWork();
      }
    },
    fileSystem: {
      async stat(filePath) {
        checkWork();
        const metadata = await stat(filePath);
        checkWork();
        return metadata;
      },
      async read(filePath, position, length) {
        checkWork();
        if (length <= 0) return Buffer.alloc(0);
        const handle = await open(filePath, 'r');
        try {
          bounds.signal?.throwIfAborted();
          const buffer = Buffer.alloc(length);
          const { bytesRead } = await handle.read(buffer, 0, length, position);
          checkWork();
          return buffer.subarray(0, bytesRead);
        } finally {
          await handle.close();
        }
      },
    },
  };
}

function escapePattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export type ContentPrefilterParams = Readonly<{
  query: string;
  paths: readonly string[];
  ripgrep: NonNullable<AgentExternalSessionsInvocation['ripgrep']>;
  signal?: AbortSignal;
  /** Native layout selectors, supplied by the same owner that enumerates candidates. */
  glob?: string;
  maxDepth?: number;
  logger?: AgentExternalSessionsInvocation['logger'];
}>;

/**
 * Source-scoped native prefilter, shared by decoders and page owners. Null
 * excludes nothing. The default returns paths; lineOffsets returns matching
 * JSONL row-start byte positions without source text. Paths may also be roots.
 */
export function prefilterExternalSessionContentPaths(params: ContentPrefilterParams & Readonly<{
  lineOffsets: true;
  /** Decoder-owned spellings which may produce text absent from a raw query. */
  additionalLinePatterns?: readonly string[];
}>): Promise<ReadonlyMap<string, readonly number[]> | null>;
export function prefilterExternalSessionContentPaths(params: ContentPrefilterParams): Promise<ReadonlySet<string> | null>;
export async function prefilterExternalSessionContentPaths(params: ContentPrefilterParams & Readonly<{
  lineOffsets?: boolean;
  additionalLinePatterns?: readonly string[];
}>): Promise<ReadonlySet<string> | ReadonlyMap<string, readonly number[]> | null> {
  params.signal?.throwIfAborted();
  const startedAt = performance.now();
  const report = (reason: string, fields: Readonly<Record<string, number | boolean>> = {}) => {
    params.logger?.debug('external_sessions.content_prefilter', {
      reason, files: params.paths.length, lineOffsets: params.lineOffsets === true,
      elapsedMs: Math.round(performance.now() - startedAt), ...fields,
    });
  };
  const unavailable = (reason: string) => { report(reason); return null; };
  if (!params.query || /[^\x01-\x7F]/.test(params.query.toLowerCase())) return unavailable('query_not_process_safe');
  if (params.paths.length === 0) return params.lineOffsets ? new Map() : new Set();
  // A mixed JSON spelling either contains the literal/named-escaped query or
  // at least one Unicode escape for a character in it. Bound the alternatives
  // by the ASCII alphabet, not query length: expanding every query character
  // into alternatives can exceed Windows argv for a valid 2,000-unit query.
  const folded = params.query.toLowerCase();
  const codes = new Set([...folded].flatMap(char => [char.charCodeAt(0), char.toUpperCase().charCodeAt(0)]));
  // The only non-ASCII code points whose JavaScript lowercase contains ASCII.
  if (folded.includes('i')) codes.add(0x0130);
  if (folded.includes('k')) codes.add(0x212a);
  const patterns = [...new Set([...(params.lineOffsets && params.query.includes('\n') ? [] : [escapePattern(params.query)]), escapePattern(JSON.stringify(params.query).slice(1, -1)),
    `\\\\u(?:${[...codes].map(code => code.toString(16).padStart(4, '0')).join('|')})`,
    ...(folded.includes('i') ? ['İ'] : []), ...(folded.includes('k') ? ['K'] : []),
    ...(params.query.includes('/') ? [escapePattern('\\/')] : []),
    ...(params.lineOffsets ? params.additionalLinePatterns ?? [] : [])])];
  const result = await params.ripgrep.run({
    // A raw NUL in a damaged native record must not hide readable messages
    // elsewhere in the file. The decoder owns record validity and coverage.
    args: ['--no-config', ...(params.lineOffsets
      ? ['--with-filename', '--only-matching', '--byte-offset', '--replace', '-', '--heading', '--color', 'never']
      : ['--files-with-matches']), '--null', '--ignore-case', ...(!params.lineOffsets ? ['--multiline'] : []), '--text',
      '--hidden', '--no-ignore',
      ...(params.glob === undefined ? [] : ['--glob', params.glob]),
      ...(params.maxDepth === undefined ? [] : ['--max-depth', String(params.maxDepth)]),
      // Anchor each admitted match at its JSONL row boundary. Consumers can
      // seek that row through the canonical byte scanner instead of rereading
      // gigabytes between sparse matches. JSONL spellings are line-local;
      // multiline replacement in rg shifts later byte offsets by replaced text.
      ...(params.lineOffsets ? [`(?m)^[^\\n]*(?:${patterns.join('|')})`] : patterns).flatMap(pattern => ['-e', pattern])],
    paths: params.paths,
    signal: params.signal,
  });
  params.signal?.throwIfAborted();
  if (result.stdoutTruncated) return unavailable('stdout_truncated');
  if (result.exitCode !== 0 && result.exitCode !== 1) throw new Error('Conversation content prefilter failed.');
  if (params.lineOffsets) {
    const offsets = new Map<string, number[]>();
    // Heading mode emits each NUL-framed path once, rather than once per
    // match. Repeating native paths can exhaust the host output budget and
    // discard admission for an entire page. Positions contain no source text.
    // Blank lines separate groups; newlines within paths stay before the NUL.
    for (let start = 0; start < result.stdout.length;) {
      const separator = result.stdout.indexOf('\0', start);
      if (separator < start) return unavailable('invalid_offset_output');
      const path = result.stdout.slice(start, separator);
      const entries = offsets.get(path) ?? [];
      start = separator + 1;
      let matched = false;
      while (start < result.stdout.length) {
        const end = result.stdout.indexOf('\n', start);
        if (end < 0) return unavailable('invalid_offset_output');
        const position = result.stdout.slice(start, end);
        start = end + 1;
        if (/^\r?$/.test(position)) break;
        if (!/^\d+:-\r?$/.test(position)) return unavailable('invalid_offset_output');
        const offset = Number(position.replace(/:-\r?$/, ''));
        if (!Number.isSafeInteger(offset)) return unavailable('invalid_offset_output');
        entries.push(offset);
        matched = true;
      }
      if (!matched) return unavailable('invalid_offset_output');
      offsets.set(path, entries);
    }
    if (result.exitCode === 0 && offsets.size === 0) return unavailable('empty_success_output');
    // Repeated native path operands can produce another heading group. Admit
    // one ordered set here; every resumed scanner page consumes it directly.
    for (const [path, entries] of offsets) offsets.set(path, [...new Set(entries)].sort((a, b) => a - b));
    report('line_offsets', { admittedFiles: offsets.size, stdoutBytes: Buffer.byteLength(result.stdout) });
    return offsets;
  }
  const paths = new Set(result.stdout.split('\0').filter(Boolean));
  report('file_paths', { admittedFiles: paths.size, stdoutBytes: Buffer.byteLength(result.stdout) });
  return paths;
}

/** Native decoding/semantic selection stays with the plugin; bodies are not retained. */
export async function searchExternalSessionContent(params: Readonly<{
  query: string;
  paths?: readonly string[];
  ripgrep?: AgentExternalSessionsInvocation['ripgrep'];
  control: ExternalSessionContentSearchControl;
  /** Native EOF closes cooperative scanning; source verification still observes cancellation. */
  isScanComplete?: () => boolean;
  /** Older native pages contain chronological records. Retain locators, not snippets. */
  pageProgress?: ExternalSessionContentSearchPageProgress;
  decode: (matchText: (text: string) => string | null, cursor?: string) => Promise<Readonly<{
    /** Streaming decoders may supply the ordinal without retaining preceding rows. */
    records: readonly Readonly<{ id: string; snippet?: string; messageIndex?: number }>[];
    partial: boolean;
    nextCursor?: string | null;
  }>>;
}>): Promise<Readonly<{ match?: Readonly<{ snippet: string; sourceItemId: string; messageIndex: number }>; partial: boolean }>> {
  const nativeProgress = params.pageProgress !== undefined || params.isScanComplete !== undefined;
  if (nativeProgress) params.control.assertNotYielded();
  else params.control.checkWork();
  if (!params.query) return { partial: false };
  if (params.paths) {
    if (params.paths.length === 0) return { partial: false };
    if (!params.ripgrep) throw new Error('File content search requires host ripgrep.');
    const paths = await prefilterExternalSessionContentPaths({ query: params.query, paths: params.paths,
      ripgrep: params.ripgrep, signal: params.control.signal });
    if (nativeProgress) params.control.assertNotYielded();
    else params.control.checkWork();
    if (paths?.size === 0) return { partial: false };
  }
  const matchText = (text: string) => createExternalSessionContentMatchSnippet(text, params.query);
  const decodePages = async () => {
    const progress = params.pageProgress!;
    let partial = false;
    await params.control.prepare(async () => {
      if (progress.complete) return true;
      const cursor = progress.cursor;
      const page = await params.decode(matchText, cursor);
      if (page.partial) {
        progress.complete = true;
        partial = true;
        return true;
      }
      const matchIndex = page.records.findIndex((item) => item.snippet !== undefined);
      if (matchIndex >= 0) {
        progress.match = { cursor, id: page.records[matchIndex]!.id,
          distanceFromEnd: progress.itemCount + page.records.length - matchIndex };
      }
      progress.itemCount += page.records.length;
      progress.cursor = page.nextCursor ?? undefined;
      progress.complete = !progress.cursor;
      return progress.complete;
    });
    if (partial) return { records: [], partial: true };
    params.control.assertNotYielded();
    const match = progress.match;
    if (!match) return { records: [], partial: false };
    const page = await params.decode(matchText, match.cursor);
    const item = page.records.find((record) => record.id === match.id);
    if (page.partial || item?.snippet === undefined) return { records: [], partial: true };
    return { records: [{ ...item, messageIndex: progress.itemCount - match.distanceFromEnd }], partial: false };
  };
  const projection = params.pageProgress ? await decodePages() : await params.decode(matchText);
  const checkFinalization = () => {
    if (params.pageProgress?.complete || params.isScanComplete?.()) params.control.assertNotYielded();
    else params.control.checkWork();
  };
  checkFinalization();
  params.control.assertNotYielded();
  for (let messageIndex = 0; messageIndex < projection.records.length; messageIndex += 1) {
    checkFinalization();
    const item = projection.records[messageIndex]!;
    if (item.snippet !== undefined) return { match: { snippet: item.snippet, sourceItemId: item.id, messageIndex: item.messageIndex ?? messageIndex }, partial: projection.partial };
  }
  return { partial: projection.partial };
}
