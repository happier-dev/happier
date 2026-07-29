import { describe, expect, it, vi } from 'vitest';

import {
  findSensitiveArtifactFiles,
  type SensitiveArtifactScanEntry,
} from './sensitiveArtifactScan';

function fileEntry(name: string): SensitiveArtifactScanEntry {
  return {
    name,
    isSymbolicLink: () => false,
    isDirectory: () => false,
    isFile: () => true,
  };
}

function directoryEntry(name: string): SensitiveArtifactScanEntry {
  return {
    name,
    isSymbolicLink: () => false,
    isDirectory: () => true,
    isFile: () => false,
  };
}

describe('sensitive artifact scan', () => {
  it('keeps best-effort callers tolerant of a missing root', async () => {
    await expect(findSensitiveArtifactFiles({
      rootPath: '/missing',
      sensitiveValues: ['secret'],
      deps: {
        readdir: async () => {
          throw new Error('missing root');
        },
        readFile: async () => Buffer.alloc(0),
      },
    })).resolves.toEqual([]);
  });

  it('fails closed when the strict scan root cannot be read', async () => {
    await expect(findSensitiveArtifactFiles({
      rootPath: '/missing',
      sensitiveValues: ['secret'],
      strict: true,
      deps: {
        readdir: async () => {
          throw new Error('missing root');
        },
        readFile: async () => Buffer.alloc(0),
      },
    })).rejects.toThrow('missing root');
  });

  it('fails closed when a strict artifact file cannot be read', async () => {
    const readFile = vi.fn(async () => {
      throw new Error('unreadable sqlite wal');
    });

    await expect(findSensitiveArtifactFiles({
      rootPath: '/handoff',
      sensitiveValues: ['secret'],
      strict: true,
      deps: {
        readdir: async () => [fileEntry('server.sqlite-wal')],
        readFile,
      },
    })).rejects.toThrow('unreadable sqlite wal');
    expect(readFile).toHaveBeenCalledWith(
      '/handoff/server.sqlite-wal',
    );
  });

  it('traverses every strict subtree including best-effort skip directories', async () => {
    await expect(findSensitiveArtifactFiles({
      rootPath: '/handoff',
      sensitiveValues: ['secret'],
      strict: true,
      deps: {
        readdir: async (path) => path === '/handoff'
          ? [directoryEntry('node_modules')]
          : [fileEntry('credential.json')],
        readFile: async () => Buffer.from('secret'),
      },
    })).resolves.toEqual([
      '/handoff/node_modules/credential.json',
    ]);
  });
});
