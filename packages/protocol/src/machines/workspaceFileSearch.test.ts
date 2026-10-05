import { describe, expect, it } from 'vitest';
import { DaemonWorkspaceFileSearchRequestSchema, DaemonWorkspaceFileSearchResponseSchema,
  WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES } from './workspaceFiles.js';

describe('workspace content-search wire boundary', () => {
  it('admits literal whitespace and bounds context while rejecting undeclared process controls', () => {
    expect(DaemonWorkspaceFileSearchRequestSchema.safeParse({ rootPath: '/repo', query: '  ' }).success).toBe(true);
    expect(DaemonWorkspaceFileSearchRequestSchema.safeParse({ rootPath: '/repo', query: 'a', contextLines: 3 }).success).toBe(false);
    expect(DaemonWorkspaceFileSearchRequestSchema.safeParse({ rootPath: '/repo', query: 'a', args: ['--files'] }).success).toBe(false);
  });
  it('rejects payloads over the shared machine ceiling and incomplete scans claiming complete coverage', () => {
    const file = { path: 'a.txt', matches: [{ line: 1, column16: 1, length16: 1,
      text: 'é'.repeat(WORKSPACE_FILE_SEARCH_MAX_RESPONSE_UTF8_BYTES), before: [], after: [] }] };
    expect(DaemonWorkspaceFileSearchResponseSchema.safeParse({ ok: true, files: [file], hasMore: false, coverage: 'complete' }).success).toBe(false);
    expect(DaemonWorkspaceFileSearchResponseSchema.safeParse({ ok: true, files: [], hasMore: true,
      coverage: 'complete' }).success).toBe(false);
    expect(DaemonWorkspaceFileSearchResponseSchema.safeParse({ ok: true, files: [], hasMore: true,
      coverage: 'partial' }).success).toBe(true);
  });
});
