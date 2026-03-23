import { describe, expect, it } from 'vitest';

import {
  DaemonFilesystemListDirectoryRequestSchema,
  DaemonFilesystemListDirectoryResponseSchema,
  DaemonFilesystemListRootsResponseSchema,
} from './machineFileBrowser.js';

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
