import { describe, expect, it, vi } from 'vitest';

import type { LoadedLinkedDirectSession } from './loadLinkedDirectSession';

const resolveTakeoverSpawnOptionsMock = vi.fn();

vi.mock('@/backends/catalog', () => ({
  getDirectSessionProviderOps: async () => ({
    resolveTakeoverSpawnOptions: resolveTakeoverSpawnOptionsMock,
  }),
}));

import { resolveDirectTakeoverSpawnOptions } from './resolveDirectTakeoverSpawnOptions';

describe('resolveDirectTakeoverSpawnOptions', () => {
  it('delegates to the provider-specific takeover resolver', async () => {
    const linked = {
      rawSession: {} as never,
      metadata: {},
      sessionPath: '/repo',
      providerId: 'codex',
      machineId: 'machine-1',
      remoteSessionId: 'thread-1',
      source: { kind: 'codexHome', home: 'user' },
      codexBackendMode: null,
    } satisfies LoadedLinkedDirectSession;

    resolveTakeoverSpawnOptionsMock.mockResolvedValueOnce({
      directory: '/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      existingSessionId: 'sess_happy_direct_codex',
      resume: 'thread-1',
      approvedNewDirectoryCreation: true,
      transcriptStorage: 'direct',
    });

    const result = await resolveDirectTakeoverSpawnOptions({
      linked,
      sessionId: 'sess_happy_direct_codex',
    });

    expect(resolveTakeoverSpawnOptionsMock).toHaveBeenCalledWith({
      linked,
      sessionId: 'sess_happy_direct_codex',
    });
    expect(result).toEqual({
      directory: '/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      existingSessionId: 'sess_happy_direct_codex',
      resume: 'thread-1',
      approvedNewDirectoryCreation: true,
      transcriptStorage: 'direct',
    });
  });
});
