import { describe, expect, it } from 'vitest';
import {
  DaemonWorkspaceFileListRequestSchema,
  DaemonWorkspaceFileListResponseSchema,
  DaemonWorkspaceFileReplaceApplyResponseSchema,
  DaemonWorkspaceFileReplacePreviewResponseSchema,
  DaemonWorkspaceFileSearchResponseSchema,
  WORKSPACE_FILE_RPC_MAX_RESPONSE_UTF8_BYTES,
  WORKSPACE_FILE_LIST_MAX_RESPONSE_UTF8_BYTES,
  WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES,
} from './workspaceFiles.js';
import { EXTERNAL_ACTION_RESULT_MAX_SERIALIZED_BYTES } from '../actions/externalActionLimits.js';

describe('workspace file response budgets', () => {
  it('keeps machine file replies within the successful Action result carrier', () => {
    expect(WORKSPACE_FILE_RPC_MAX_RESPONSE_UTF8_BYTES).toBeLessThanOrEqual(EXTERNAL_ACTION_RESULT_MAX_SERIALIZED_BYTES);
    expect(WORKSPACE_FILE_LIST_MAX_RESPONSE_UTF8_BYTES).toBe(WORKSPACE_FILE_RPC_MAX_RESPONSE_UTF8_BYTES);
  });

  it('rejects a reply whose encrypted packet would outlast the relay heartbeat on the supported uplink', () => {
    // The daemon's pong queues behind the packet it uploads: past ~11 MB on the ~1.96 Mbit/s
    // floor the relay drops the whole machine socket, so 9 MB of JSON (~12 MB as base64) must page.
    const search = (bytes: number) => ({ ok: true, files: [{ path: 'large.txt', matches: [
      { line: 1, column16: 1, length16: 1, text: 'a'.repeat(bytes), before: [], after: [] },
    ] }], hasMore: false, coverage: 'complete' });
    expect(DaemonWorkspaceFileSearchResponseSchema.safeParse(search(9_000_000)).success).toBe(false);
    expect(DaemonWorkspaceFileSearchResponseSchema.safeParse(search(8_000_000)).success).toBe(true);
  });

  it('admits a complete response at its byte boundary and rejects one byte more', () => {
    const response = { ok: true, paths: [''], truncated: false };
    const framingBytes = new TextEncoder().encode(JSON.stringify(response)).byteLength;
    response.paths[0] = 'a'.repeat(WORKSPACE_FILE_LIST_MAX_RESPONSE_UTF8_BYTES - framingBytes);
    expect(DaemonWorkspaceFileListResponseSchema.safeParse(response).success).toBe(true);
    response.paths[0] += 'a';
    expect(DaemonWorkspaceFileListResponseSchema.safeParse(response).success).toBe(false);
  });

  it('admits a file corpus beyond 5000 rows within the Action result budget', () => {
    const paths = Array.from({ length: 6000 }, (_, index) => `src/${index}-${'component'.repeat(8)}.ts`);
    expect(DaemonWorkspaceFileListRequestSchema.safeParse({ rootPath: '/repo', limit: paths.length }).success).toBe(true);
    expect(DaemonWorkspaceFileListResponseSchema.safeParse({ ok: true, paths, truncated: false }).success).toBe(true);
  });

  it('admits substantial Unicode search and replace previews', () => {
    const match = { line: 1, column16: 1, length16: 1, text: '😀'.repeat(80_000), before: [], after: [] };
    expect(DaemonWorkspaceFileSearchResponseSchema.safeParse({ ok: true,
      files: [{ path: 'unicode.txt', matches: [match] }], hasMore: false, coverage: 'complete' }).success).toBe(true);
    expect(DaemonWorkspaceFileReplacePreviewResponseSchema.safeParse({ ok: true,
      files: [{ path: 'unicode.txt', hash: 'a'.repeat(64), matchCount: 1, matches: [{ ...match, replacedText: match.text }] }],
      skipped: { notText: 0 }, hasMore: false, coverage: 'complete' }).success).toBe(true);
  });

  it('rejects oversized successful replies, including writer receipts', () => {
    expect(DaemonWorkspaceFileListResponseSchema.safeParse({ ok: true,
      paths: ['a'.repeat(WORKSPACE_FILE_LIST_MAX_RESPONSE_UTF8_BYTES)], truncated: true }).success).toBe(false);
    const text = 'a'.repeat(WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES);
    const match = { line: 1, column16: 1, length16: 1, text, before: [], after: [] };
    expect(DaemonWorkspaceFileSearchResponseSchema.safeParse({ ok: true,
      files: [{ path: 'large.txt', matches: [match] }], hasMore: true, coverage: 'partial' }).success).toBe(false);
    expect(DaemonWorkspaceFileReplacePreviewResponseSchema.safeParse({ ok: true,
      files: [{ path: 'large.txt', hash: 'a'.repeat(64), matchCount: 1, matches: [{ ...match, replacedText: '' }] }],
      skipped: { notText: 0 }, hasMore: true, coverage: 'partial', cursor: { path: 'large.txt' } }).success).toBe(false);
    expect(DaemonWorkspaceFileReplaceApplyResponseSchema.safeParse({ ok: true,
      results: [{ path: 'large.txt', status: 'replaced', edits: [
        { startUtf16: 0, deleteLength: 0, insertText: text, originalText: '' },
      ] }] }).success).toBe(false);
  });
});
