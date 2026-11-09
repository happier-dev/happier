import { describe, expect, it } from 'vitest';

import {
  DaemonFilesystemListDirectoryRequestSchema,
  DaemonFilesystemListDirectoryResponseSchema,
  DaemonFilesystemListRootsResponseSchema,
} from './fileBrowser.js';
import {
  DaemonWorkspaceFileListRequestSchema,
  DaemonWorkspaceFileListResponseSchema,
} from './workspaceFiles.js';

describe('machineFileBrowser', () => {
  it('parses successful list roots responses', () => {
    const parsed = DaemonFilesystemListRootsResponseSchema.parse({
      ok: true,
      roots: [{ id: '/', label: '/', path: '/' }],
    });

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.roots[0]?.path).toBe('/');
    }
  });

  it('parses directory list requests with optional flags', () => {
    const parsed = DaemonFilesystemListDirectoryRequestSchema.parse({
      path: '/Users/leeroy',
      includeFiles: false,
      maxEntries: 200,
    });

    expect(parsed).toEqual({
      path: '/Users/leeroy',
      includeFiles: false,
      maxEntries: 200,
    });
  });

  it('rejects malformed optional ignore metadata', () => {
    expect(DaemonFilesystemListDirectoryRequestSchema.safeParse({ path: '/repo', includeGitIgnore: 'yes' }).success).toBe(false);
    expect(DaemonFilesystemListDirectoryResponseSchema.safeParse({
      ok: true, path: '/repo', truncated: false, gitIgnoreAvailable: 'yes', entries: [],
    }).success).toBe(false);
    expect(DaemonFilesystemListDirectoryResponseSchema.safeParse({
      ok: true, path: '/repo', truncated: false, entries: [{ name: 'noise', path: '/repo/noise', type: 'file', gitIgnored: 'yes' }],
    }).success).toBe(false);
  });

  it('parses successful directory list responses with truncation metadata', () => {
    const parsed = DaemonFilesystemListDirectoryResponseSchema.parse({
      ok: true,
      path: '/Users/leeroy',
      entries: [
        { name: 'Documents', path: '/Users/leeroy/Documents', type: 'directory', modified: 1234 },
      ],
      truncated: false,
    });

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.entries[0]?.type).toBe('directory');
      expect(parsed.truncated).toBe(false);
    }
  });
});

describe('workspace file-list protocol', () => {
  it('accepts only the typed workspace root, query, visibility, and result limit', () => {
    expect(DaemonWorkspaceFileListRequestSchema.parse({
      rootPath: '/repo',
      query: 'readme',
      includeHidden: true,
      limit: 50,
    })).toEqual({ rootPath: '/repo', query: 'readme', includeHidden: true, limit: 50 });

    expect(DaemonWorkspaceFileListRequestSchema.safeParse({
      rootPath: '/repo',
      args: ['--files', '/etc'],
    }).success).toBe(false);
    expect(DaemonWorkspaceFileListRequestSchema.safeParse({
      rootPath: '/repo',
      cwd: '/etc',
    }).success).toBe(false);
  });

  it('represents truncation and process failure explicitly', () => {
    expect(DaemonWorkspaceFileListResponseSchema.parse({
      ok: true,
      paths: ['README.md'],
      truncated: true,
    })).toEqual({ ok: true, paths: ['README.md'], truncated: true });
    expect(DaemonWorkspaceFileListResponseSchema.parse({
      ok: false,
      errorCode: 'ripgrep_failed',
      exitCode: 2,
    })).toEqual({ ok: false, errorCode: 'ripgrep_failed', exitCode: 2 });
  });
});
