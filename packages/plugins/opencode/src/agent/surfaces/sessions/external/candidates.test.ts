import { afterEach, describe, expect, it, vi } from 'vitest';

const openCodeClientMock = vi.hoisted(() => ({
  sessionList: vi.fn(),
  sessionStatusList: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock('./client.js', () => ({
  createOpenCodeExternalSessionClient: vi.fn(async () => openCodeClientMock),
}));

import {
  listOpenCodeSessionCandidates,
  parseOpenCodeSessionCandidate,
} from './candidates.js';

afterEach(() => {
  vi.restoreAllMocks();
  openCodeClientMock.sessionList.mockReset();
  openCodeClientMock.sessionStatusList.mockReset();
  openCodeClientMock.dispose.mockReset();
});

describe('listOpenCodeSessionCandidates', () => {
  it('reads the official OpenCode nested session update timestamp', () => {
    expect(parseOpenCodeSessionCandidate({
      id: 'oc-session-time',
      title: 'Timestamp fixture',
      time: {
        created: 1_700_000_000_000,
        updated: 1_700_000_123_456,
      },
    })).toMatchObject({
      remoteSessionId: 'oc-session-time',
      updatedAtMs: 1_700_000_123_456,
    });
  });

  it('rejects an id-only OpenCode row instead of assigning a clock-derived activity timestamp', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-15T00:00:00.000Z'));

    expect(parseOpenCodeSessionCandidate({
      id: 'oc-id-only',
      title: 'No stable update time',
    })).toBeNull();
    expect(now).not.toHaveBeenCalled();
  });

  it('reaches candidate 51 through a stable source continuation and preserves repeated ordering', async () => {
    const sessions = Array.from({ length: 51 }, (_, index) => ({
      id: `oc-session-${String(index + 1).padStart(3, '0')}`,
      title: `OpenCode session ${index + 1}`,
      time: { updated: 10_000 - index },
    }));
    openCodeClientMock.sessionList.mockImplementation(async (options: Readonly<{
      limit: number;
      cursor?: number;
    }>) => {
      const visible = options.cursor === undefined
        ? sessions
        : sessions.filter((session) => session.time.updated < options.cursor!);
      return visible.slice(0, options.limit);
    });
    openCodeClientMock.dispose.mockResolvedValue(undefined);
    const request = {
      source: { kind: 'opencodeServer' as const, baseUrl: 'http://127.0.0.1:49196/' },
      maxBytes: 64 * 1024,
      limit: 50,
    };

    const first = await listOpenCodeSessionCandidates(request);
    const repeated = await listOpenCodeSessionCandidates(request);
    expect(first.candidates.map((candidate) => candidate.remoteSessionId)).toEqual(
      sessions.slice(0, 50).map((session) => session.id),
    );
    expect(repeated.candidates.map((candidate) => candidate.remoteSessionId)).toEqual(
      first.candidates.map((candidate) => candidate.remoteSessionId),
    );
    expect(first.nextCursor).toEqual(expect.any(String));
    if (!first.nextCursor) throw new Error('expected candidate continuation');

    const second = await listOpenCodeSessionCandidates({ ...request, cursor: first.nextCursor });
    expect(second).toMatchObject({
      candidates: [expect.objectContaining({ remoteSessionId: 'oc-session-051' })],
      nextCursor: null,
    });
    expect(openCodeClientMock.sessionList).toHaveBeenCalledWith(expect.objectContaining({
      cursor: 9_952,
    }));
  });

  it('keeps an equal-timestamp candidate behind the page boundary reachable', async () => {
    const sessions = Array.from({ length: 51 }, (_, index) => ({
      id: `same-time-session-${String(index + 1).padStart(3, '0')}`,
      title: `Same-time session ${index + 1}`,
      time: { updated: 10_000 },
    }));
    openCodeClientMock.sessionList.mockImplementation(async (options: Readonly<{
      limit: number;
      cursor?: number;
    }>) => {
      const visible = options.cursor === undefined
        ? sessions
        : sessions.filter((session) => session.time.updated < options.cursor!);
      return visible.slice(0, options.limit);
    });
    openCodeClientMock.dispose.mockResolvedValue(undefined);
    const request = {
      source: { kind: 'opencodeServer' as const, baseUrl: 'http://127.0.0.1:49196/' },
      maxBytes: 64 * 1024,
      limit: 50,
    };

    const first = await listOpenCodeSessionCandidates(request);
    if (!first.nextCursor) throw new Error('expected equal-timestamp continuation');
    const second = await listOpenCodeSessionCandidates({ ...request, cursor: first.nextCursor });

    expect(second).toMatchObject({
      candidates: [expect.objectContaining({ remoteSessionId: 'same-time-session-051' })],
      nextCursor: null,
    });
    expect(openCodeClientMock.sessionList).toHaveBeenCalledWith(expect.objectContaining({
      cursor: 10_001,
      limit: 101,
    }));
  });

  it('performs full search across later source chunks and session ids without server title search', async () => {
    const sessions = [
      { id: 'other-session-3', title: 'A title without the query', time: { updated: 3 } },
      { id: 'other-session-2', title: 'A title without the query', time: { updated: 2 } },
      { id: 'needle-session-id', title: 'A title without the query', time: { updated: 1 } },
    ];
    openCodeClientMock.sessionList.mockImplementation(async (options: Readonly<{
      limit: number;
      search?: string;
      cursor?: number;
    }>) => {
      if (options.search) return [];
      const visible = options.cursor === undefined
        ? sessions
        : sessions.filter((session) => session.time.updated < options.cursor!);
      return visible.slice(0, options.limit);
    });
    openCodeClientMock.dispose.mockResolvedValue(undefined);

    const result = await listOpenCodeSessionCandidates({
      source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:49196/' },
      maxBytes: 64 * 1024,
      limit: 1,
      searchTerm: 'needle-session-id',
      searchMode: 'full',
    });

    expect(result).toMatchObject({
      candidates: [expect.objectContaining({ remoteSessionId: 'needle-session-id' })],
      nextCursor: null,
    });
    expect(openCodeClientMock.sessionList).toHaveBeenCalledWith({ limit: 2 });
    expect(openCodeClientMock.sessionList).toHaveBeenCalledWith(expect.objectContaining({
      cursor: 4,
      limit: 3,
    }));
    expect(openCodeClientMock.sessionList).toHaveBeenCalledWith(expect.objectContaining({
      cursor: 3,
      limit: 3,
    }));
  });

  it('replaces the private V1 candidate carrier with the bounded OpenCode runtime descriptor model', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-24T00:00:00.000Z'));
    openCodeClientMock.sessionList.mockResolvedValueOnce([
      {
        id: 'oc-session-1',
        title: 'OpenCode session',
        updatedAtMs: 123,
      },
    ]);
    openCodeClientMock.sessionStatusList.mockResolvedValueOnce({});
    openCodeClientMock.dispose.mockResolvedValueOnce(undefined);

    const result = await listOpenCodeSessionCandidates({
      source: {
        kind: 'opencodeServer',
        baseUrl: 'http://127.0.0.1:49196/',
      },
      maxBytes: 1_024,
      limit: 10,
    });

    expect(result.candidates).toEqual([
      {
        remoteSessionId: 'oc-session-1',
        title: 'OpenCode session',
        updatedAtMs: 123,
        runtimeDescriptor: {
          v: 1,
          agentId: 'opencode',
          agent: {
            backendMode: 'server',
            providerSessionId: 'oc-session-1',
            serverBaseUrl: 'http://127.0.0.1:49196/',
            serverBaseUrlExplicit: true,
            agentExtra: {
              owner: 'opencode',
              schemaId: 'opencode.agentRuntimeDescriptorExtra',
              v: 1,
              runtimeHandle: {
                backendMode: 'server',
                providerSessionId: 'oc-session-1',
                serverBaseUrl: 'http://127.0.0.1:49196/',
                serverBaseUrlExplicit: true,
              },
            },
          },
        },
      },
    ]);
  });
});
