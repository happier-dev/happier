import { describe, expect, it } from 'vitest';
import {
  DaemonWorkspaceFileListResponseSchema,
  DaemonWorkspaceFileReplaceApplyResponseSchema,
  DaemonWorkspaceFileReplacePreviewResponseSchema,
  DaemonWorkspaceFileSearchResponseSchema,
  WORKSPACE_FILE_LIST_MAX_RESPONSE_UTF8_BYTES,
  WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES,
} from './workspaceFiles.js';

describe('workspace file response budgets', () => {
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
