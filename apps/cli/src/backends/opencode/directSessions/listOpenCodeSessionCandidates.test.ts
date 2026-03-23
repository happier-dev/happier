import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { listOpenCodeSessionCandidates } from './listOpenCodeSessionCandidates';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('listOpenCodeSessionCandidates', () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.HAPPIER_OPENCODE_SERVER_URL;

  beforeEach(() => {
    process.env.HAPPIER_OPENCODE_SERVER_URL = 'http://example.test';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (typeof originalUrl === 'string') {
      process.env.HAPPIER_OPENCODE_SERVER_URL = originalUrl;
    } else {
      delete process.env.HAPPIER_OPENCODE_SERVER_URL;
    }
  });

  it('lists OpenCode sessions via GET /session', async () => {
    const updated2 = Date.parse('2026-01-02T00:00:00.000Z');
    const updated1 = Date.parse('2026-01-01T00:00:00.000Z');
    globalThis.fetch = vi.fn(async (input) => {
      const url = typeof input === 'string' ? input : String((input as any)?.url ?? '');
      if (url.includes('/global/health')) {
        return jsonResponse({ healthy: true, version: '1.2.17' });
      }
      if (url.includes('/session/status')) {
        return jsonResponse({
          s2: { type: 'busy' },
          s1: { type: 'idle' },
        });
      }
      if (url.includes('/session') && !url.includes('/message') && !url.includes('/status')) {
        return jsonResponse([
          {
            id: 's1',
            title: 'First',
            directory: '/tmp/opencode-first',
            time: { updated: updated1 },
          },
          {
            id: 's2',
            title: 'Second',
            directory: '/tmp/opencode-second',
            time: { updated: updated2 },
          },
          {
            id: 's3',
            time: { created: Date.parse('2025-12-31T00:00:00.000Z') },
          },
        ]);
      }
      return jsonResponse({});
    }) as any;

    const first = await listOpenCodeSessionCandidates({
      source: { kind: 'opencodeServer', baseUrl: null, directory: null },
      limit: 2,
    });

    expect(first.candidates.map((c) => c.remoteSessionId)).toEqual(['s2', 's1']);
    expect(first.candidates[0]).toMatchObject({
      remoteSessionId: 's2',
      updatedAtMs: updated2,
      activity: 'running',
      details: {
        path: '/tmp/opencode-second',
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'opencode',
          provider: {
            backendMode: 'server',
            vendorSessionId: 's2',
            providerExtra: {
              v: 1,
              runtimeHandle: {
                backendMode: 'server',
                vendorSessionId: 's2',
              },
            },
          },
        },
      },
    });
    expect(first.candidates[1]).toMatchObject({
      remoteSessionId: 's1',
      updatedAtMs: updated1,
      activity: 'idle',
      details: {
        path: '/tmp/opencode-first',
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'opencode',
          provider: {
            backendMode: 'server',
            vendorSessionId: 's1',
            providerExtra: {
              v: 1,
              runtimeHandle: {
                backendMode: 'server',
                vendorSessionId: 's1',
              },
            },
          },
        },
      },
    });
    expect(first.nextCursor).toBeTruthy();

    const second = await listOpenCodeSessionCandidates({
      source: { kind: 'opencodeServer', baseUrl: null, directory: null },
      cursor: first.nextCursor ?? undefined,
      limit: 10,
    });

    expect(second.candidates.map((c) => c.remoteSessionId)).toEqual(['s3']);
    expect(second.nextCursor).toBeNull();
  });

  it('filters sessions by searchTerm', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = typeof input === 'string' ? input : String((input as any)?.url ?? '');
      if (url.includes('/global/health')) {
        return jsonResponse({ healthy: true, version: '1.2.17' });
      }
      if (url.includes('/session/status')) {
        return jsonResponse({});
      }
      if (url.includes('/session') && !url.includes('/message') && !url.includes('/status')) {
        return jsonResponse([{ id: 's1', title: 'First' }, { id: 's2', title: 'Second' }]);
      }
      return jsonResponse({});
    }) as any;

    const res = await listOpenCodeSessionCandidates({
      source: { kind: 'opencodeServer', baseUrl: null, directory: null },
      limit: 50,
      searchTerm: 'sec',
    });

    expect(res.candidates.map((c) => c.remoteSessionId)).toEqual(['s2']);
  });
});
