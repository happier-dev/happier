import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const validateExternalMachineSourceMock = vi.fn();
const resolveExternalSessionSurfaceOpsMock = vi.fn();
const resolveTranscriptRefreshBindingMock = vi.fn();
const loadLinkedExternalSessionMock = vi.fn();
const readCredentialsMock = vi.fn();

vi.mock('@/api/session/external/security/validateExternalMachineSource', () => ({
  validateExternalMachineSource: (...args: unknown[]) => validateExternalMachineSourceMock(...args),
}));

vi.mock('./providerOpsResolution', () => ({
  resolveExternalSessionSurfaceOps: (...args: unknown[]) => resolveExternalSessionSurfaceOpsMock(...args),
}));
vi.mock('@/api/session/external/secureRefresh/resolveExternalSessionTranscriptRefreshBinding', () => ({
  resolveExternalSessionTranscriptRefreshBinding: (...args: unknown[]) =>
    resolveTranscriptRefreshBindingMock(...args),
}));
vi.mock('@/api/session/external/takeover/loadLinkedExternalSession', () => ({
  loadLinkedExternalSession: (...args: unknown[]) => loadLinkedExternalSessionMock(...args),
}));
vi.mock('@/persistence', () => ({
  readCredentials: (...args: unknown[]) => readCredentialsMock(...args),
}));

vi.mock('sharp', () => ({
  default: () => ({
    metadata: async () => ({ width: 1, height: 1 }),
  }),
}));

let transcriptActionsModule: typeof import('./transcriptActions');
const secureRefreshCursor = 'happier_external_cursor_v1:Y3Vyc29yLTE';
const secureRefreshCursorIdentity = `external_session_cursor_binding_v1:${'a'.repeat(64)}`;

describe('external session transcript actions', () => {
  beforeAll(async () => {
    transcriptActionsModule = await import('./transcriptActions');
  }, 180_000);

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns an explicit advanced secure-refresh result only for the current qualified binding', async () => {
    const binding = {
      v: 1 as const,
      machineId: 'machine-1',
      sessionId: 'sess-1',
      link: { generation: 'link-1', remoteSessionId: 'remote-1' },
      source: {
        qualifiedIdentity: {
          v: 1 as const,
          agent: { pluginId: 'happier.claude', localId: 'claude' },
          source: { kind: 'claudeConfig', contractVersion: 1 as const },
        },
        generation: 'source-1',
      },
      contributionGeneration: 'contribution-1',
      cursorIdentity: secureRefreshCursorIdentity,
    };
    resolveTranscriptRefreshBindingMock.mockResolvedValue(binding);
    readCredentialsMock.mockResolvedValue({ token: 'token' });
    loadLinkedExternalSessionMock.mockResolvedValue({
      ok: true,
      session: {
        agentId: 'claude',
        source: { kind: 'claudeConfig', homeDir: '/tmp' },
        remoteSessionId: 'remote-1',
      },
    });
    resolveExternalSessionSurfaceOpsMock.mockResolvedValue({
      readAfterTranscript: async () => ({
        outcome: 'advanced',
        items: [{ id: 'item-2', createdAtMs: 2, raw: { role: 'assistant' } }],
        nextCursor: 'happier_external_cursor_v1:Y3Vyc29yLTI',
        boundary: 'item-2',
      }),
    });

    await expect(transcriptActionsModule.executeExternalSessionTranscriptReadAfterAction({
      v: 1,
      binding,
      cursor: secureRefreshCursor,
    })).resolves.toEqual({
      v: 1,
      binding,
      result: {
        outcome: 'advanced',
        items: [{ id: 'item-2', createdAtMs: 2, raw: { role: 'assistant' } }],
        nextCursor: 'happier_external_cursor_v1:Y3Vyc29yLTI',
        boundary: 'item-2',
      },
    });
  });

  it('preserves an explicit Agent gap outcome with zero items', async () => {
    const binding = {
      v: 1 as const,
      machineId: 'machine-1',
      sessionId: 'sess-1',
      link: { generation: 'link-1', remoteSessionId: 'remote-1' },
      source: {
        qualifiedIdentity: {
          v: 1 as const,
          agent: { pluginId: 'happier.claude', localId: 'claude' },
          source: { kind: 'claudeConfig', contractVersion: 1 as const },
        },
        generation: 'source-1',
      },
      contributionGeneration: 'contribution-1',
      cursorIdentity: secureRefreshCursorIdentity,
    };
    resolveTranscriptRefreshBindingMock.mockResolvedValue(binding);
    readCredentialsMock.mockResolvedValue({ token: 'token' });
    loadLinkedExternalSessionMock.mockResolvedValue({
      ok: true,
      session: {
        agentId: 'claude',
        source: { kind: 'claudeConfig', homeDir: '/tmp' },
        remoteSessionId: 'remote-1',
      },
    });
    resolveExternalSessionSurfaceOpsMock.mockResolvedValue({
      readAfterTranscript: async () => ({ outcome: 'gap_or_cursor_expired' }),
    });

    await expect(transcriptActionsModule.executeExternalSessionTranscriptReadAfterAction({
      v: 1,
      binding,
      cursor: secureRefreshCursor,
    })).resolves.toEqual({
      v: 1,
      binding,
      result: { outcome: 'gap_or_cursor_expired' },
    });
  });

  it('classifies an advanced secure-refresh result without cursor progress as a gap with zero items', async () => {
    const binding = {
      v: 1 as const,
      machineId: 'machine-1',
      sessionId: 'sess-1',
      link: { generation: 'link-1', remoteSessionId: 'remote-1' },
      source: {
        qualifiedIdentity: {
          v: 1 as const,
          agent: { pluginId: 'happier.claude', localId: 'claude' },
          source: { kind: 'claudeConfig', contractVersion: 1 as const },
        },
        generation: 'source-1',
      },
      contributionGeneration: 'contribution-1',
      cursorIdentity: secureRefreshCursorIdentity,
    };
    resolveTranscriptRefreshBindingMock.mockResolvedValue(binding);
    readCredentialsMock.mockResolvedValue({ token: 'token' });
    loadLinkedExternalSessionMock.mockResolvedValue({
      ok: true,
      session: {
        agentId: 'claude',
        source: { kind: 'claudeConfig', homeDir: '/tmp' },
        remoteSessionId: 'remote-1',
      },
    });
    resolveExternalSessionSurfaceOpsMock.mockResolvedValue({
      readAfterTranscript: async () => ({
        outcome: 'advanced',
        items: [{ id: 'replayed-item', createdAtMs: 2, raw: { role: 'assistant' } }],
        nextCursor: secureRefreshCursor,
        boundary: 'replayed-item',
      }),
    });

    await expect(transcriptActionsModule.executeExternalSessionTranscriptReadAfterAction({
      v: 1,
      binding,
      cursor: secureRefreshCursor,
    })).resolves.toEqual({
      v: 1,
      binding,
      result: { outcome: 'gap_or_cursor_expired' },
    });
  });

  it('applies zero source items when the encrypted request cursor derives a stale binding identity', async () => {
    const binding = {
      v: 1 as const,
      machineId: 'machine-1',
      sessionId: 'sess-1',
      link: { generation: 'link-old', remoteSessionId: 'remote-1' },
      source: {
        qualifiedIdentity: {
          v: 1 as const,
          agent: { pluginId: 'happier.claude', localId: 'claude' },
          source: { kind: 'claudeConfig', contractVersion: 1 as const },
        },
        generation: 'source-1',
      },
      contributionGeneration: 'contribution-1',
      cursorIdentity: secureRefreshCursorIdentity,
    };
    resolveTranscriptRefreshBindingMock.mockResolvedValue({
      ...binding,
      cursorIdentity: `external_session_cursor_binding_v1:${'b'.repeat(64)}`,
    });

    await expect(transcriptActionsModule.executeExternalSessionTranscriptReadAfterAction({
      v: 1,
      binding,
      cursor: secureRefreshCursor,
    })).resolves.toEqual({
      v: 1,
      binding,
      result: { outcome: 'source_replaced' },
    });
    expect(resolveExternalSessionSurfaceOpsMock).not.toHaveBeenCalled();
  });

  it('applies zero source items when the qualified binding changes during readAfter', async () => {
    const binding = {
      v: 1 as const,
      machineId: 'machine-1',
      sessionId: 'sess-1',
      link: { generation: 'link-1', remoteSessionId: 'remote-1' },
      source: {
        qualifiedIdentity: {
          v: 1 as const,
          agent: { pluginId: 'happier.claude', localId: 'claude' },
          source: { kind: 'claudeConfig', contractVersion: 1 as const },
        },
        generation: 'source-1',
      },
      contributionGeneration: 'contribution-1',
      cursorIdentity: secureRefreshCursorIdentity,
    };
    resolveTranscriptRefreshBindingMock
      .mockResolvedValueOnce(binding)
      .mockResolvedValueOnce({
        ...binding,
        contributionGeneration: 'contribution-2',
      });
    readCredentialsMock.mockResolvedValue({ token: 'token' });
    loadLinkedExternalSessionMock.mockResolvedValue({
      ok: true,
      session: {
        agentId: 'claude',
        source: { kind: 'claudeConfig', homeDir: '/tmp' },
        remoteSessionId: 'remote-1',
      },
    });
    resolveExternalSessionSurfaceOpsMock.mockResolvedValue({
      readAfterTranscript: async () => ({
        outcome: 'advanced',
        items: [{
          id: 'item-from-retired-generation',
          createdAtMs: 2,
          raw: { role: 'assistant' },
        }],
        nextCursor: 'happier_external_cursor_v1:Y3Vyc29yLTI',
        boundary: 'item-from-retired-generation',
      }),
    });

    await expect(transcriptActionsModule.executeExternalSessionTranscriptReadAfterAction({
      v: 1,
      binding,
      cursor: secureRefreshCursor,
    })).resolves.toEqual({
      v: 1,
      binding,
      result: { outcome: 'source_replaced' },
    });
    expect(resolveTranscriptRefreshBindingMock).toHaveBeenCalledTimes(2);
  });

  it('keeps direct-session media browsing transient with scoped read files only', async () => {
    const sourceDirectory = await mkdtemp(join(tmpdir(), 'happier-transient-media-source-'));
    const verifiedDirectory = await mkdtemp(join(tmpdir(), 'happier-transient-media-verified-'));
    const outsideDirectory = await mkdtemp(join(tmpdir(), 'happier-transient-media-outside-'));
    const sourceDirectoryMediaPath = join(sourceDirectory, '.opencode', 'media', 'source-directory-owned.png');
    const providerMediaPath = join(verifiedDirectory, '.opencode', 'media', 'provider-owned.png');
    const sensitiveMediaPath = join(outsideDirectory, 'sensitive.png');
    await mkdir(join(sourceDirectory, '.opencode', 'media'), { recursive: true });
    await mkdir(join(verifiedDirectory, '.opencode', 'media'), { recursive: true });
    await writeFile(sourceDirectoryMediaPath, 'source-directory-media');
    await writeFile(providerMediaPath, 'provider-media');
    await writeFile(sensitiveMediaPath, 'sensitive-media');
    validateExternalMachineSourceMock.mockResolvedValue({
      ok: true,
      source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096', directory: sourceDirectory },
    });
    resolveExternalSessionSurfaceOpsMock.mockResolvedValue({
      resolveTranscriptMediaReadRoots: async () => [verifiedDirectory],
      pageTranscript: async () => ({
        items: [
          {
            id: 'direct-item-1',
            localId: 'direct-item-1',
            createdAtMs: 123,
            raw: {
              role: 'agent',
              content: { type: 'output', data: { type: 'message', message: 'preview only' } },
              meta: {
                happier: {
                  kind: 'session_media.v1',
                  payload: {
                    media: [{
                      id: 'provider-media-1',
                      role: 'output',
                      category: 'generated',
                      mediaKind: 'image',
                      mimeType: 'image/png',
                      name: 'provider-owned.png',
                      path: providerMediaPath,
                      sizeBytes: 12,
                      origin: { source: 'provider-generated' },
                    }, {
                      id: 'provider-media-source-directory',
                      role: 'output',
                      category: 'generated',
                      mediaKind: 'image',
                      mimeType: 'image/png',
                      name: 'source-directory-owned.png',
                      path: sourceDirectoryMediaPath,
                      sizeBytes: 12,
                      origin: { source: 'provider-generated' },
                    }, {
                      id: 'provider-media-2',
                      role: 'output',
                      category: 'generated',
                      mediaKind: 'image',
                      mimeType: 'image/png',
                      name: 'sensitive.png',
                      path: sensitiveMediaPath,
                      sizeBytes: 12,
                      origin: { source: 'provider-generated' },
                    }],
                  },
                },
              },
            },
          },
        ],
        nextCursor: null,
        tailCursor: null,
        hasMore: false,
      }),
    });

    try {
      const { executeExternalSessionTranscriptPageAction } = transcriptActionsModule;
      const response = await executeExternalSessionTranscriptPageAction({
        machineId: 'machine-1',
        agentId: 'opencode',
        remoteSessionId: 'provider-session-1',
        source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096', directory: sourceDirectory },
        direction: 'older',
      });

      expect(response.ok).toBe(true);
      if (!response.ok) throw new Error('expected transcript page to succeed');
      expect(JSON.stringify(response.items)).toContain(providerMediaPath);
      expect(JSON.stringify(response.items)).toContain(sourceDirectoryMediaPath);
      expect(JSON.stringify(response.items)).toContain(sensitiveMediaPath);
      expect(JSON.stringify(response.items)).not.toContain('.happier/uploads/generated');
      expect((response as { transientMediaReadFiles?: readonly string[] }).transientMediaReadFiles).toEqual([
        providerMediaPath,
      ]);
    } finally {
      await rm(sourceDirectory, { recursive: true, force: true });
      await rm(verifiedDirectory, { recursive: true, force: true });
      await rm(outsideDirectory, { recursive: true, force: true });
    }
  });
});
