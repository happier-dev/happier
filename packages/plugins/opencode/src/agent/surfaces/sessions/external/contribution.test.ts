import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildOpenCodeAgentRuntimeDescriptorV1 } from '../../../identity/runtimeDescriptor.js';
import {
  registerOpenCodeManagedServerEndpoint,
} from '../../../runtime/server/endpoint.js';
import { createOpenCodeServerTransport } from '../../../runtime/server/transport.js';
import { createOpenCodeExternalSessionsContribution } from './contribution.js';

const baseUrl = 'http://127.0.0.1:49196';
const source = {
  kind: 'opencodeServer' as const,
  baseUrl,
  directory: '/tmp/project',
};
const env = {
  HAPPIER_OPENCODE_SERVER_URL: baseUrl,
};

function invocation(overrides: Partial<{
  signal: AbortSignal;
  deadlineAtMs: number;
  maxSerializedBytes: number;
}> = {}) {
  return {
    signal: new AbortController().signal,
    deadlineAtMs: Date.now() + 10_000,
    maxSerializedBytes: 100_000,
    ...overrides,
  };
}

describe('OpenCode public External Sessions contribution', () => {
  const endpointRegistrations: Array<Readonly<{ dispose: () => void }>> = [];

  afterEach(() => {
    while (endpointRegistrations.length > 0) {
      endpointRegistrations.pop()?.dispose();
    }
    vi.unstubAllGlobals();
  });

  it('honors cancellation before touching the OpenCode server', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();

    const result = await createOpenCodeExternalSessionsContribution({ env }).listCandidates({
      source,
      maxItems: 10,
      ...invocation({ signal: controller.signal }),
    });

    expect(result).toMatchObject({ ok: false, code: 'cancelled' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses bounded official list search and reports an honest incomplete top-N result', async () => {
    const requested: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      requested.push(input);
      return new Response(JSON.stringify([
        { id: 'session-3', title: 'Needle three', time: { updated: 3 } },
        { id: 'session-2', title: 'Needle two', time: { updated: 2 } },
        { id: 'session-1', title: 'Needle one', time: { updated: 1 } },
      ]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    const result = await createOpenCodeExternalSessionsContribution({ env }).listCandidates({
      source,
      maxItems: 2,
      searchTerm: 'Needle',
      searchMode: 'fast',
      ...invocation(),
    });

    expect(result).toEqual({
      ok: true,
      value: {
        candidates: [
          expect.objectContaining({ remoteSessionId: 'session-3' }),
          expect.objectContaining({ remoteSessionId: 'session-2' }),
        ],
        nextCursor: null,
        searchIncomplete: true,
      },
    });
    expect(requested).toEqual([
      `${baseUrl}/session?directory=%2Ftmp%2Fproject&limit=3&search=Needle`,
    ]);
  });

  it('routes candidate discovery through the registered endpoint-bound transport', async () => {
    const transportFetch = vi.fn(async () => new Response(JSON.stringify([
      { id: 'managed-session', title: 'Managed', time: { updated: 3 } },
    ]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const transport = createOpenCodeServerTransport({
      baseUrl,
      instanceId: 'candidate-instance',
      readManagedServerSnapshot: () => ({
        instanceId: 'candidate-instance',
        state: 'healthy',
        baseUrl,
      }),
      fetchImpl: transportFetch,
    });
    endpointRegistrations.push(registerOpenCodeManagedServerEndpoint({
      baseUrl,
      credential: null,
      transport,
    }));
    const globalFetch = vi.fn(async () => {
      throw new Error('global fetch must not run for a registered endpoint');
    });
    vi.stubGlobal('fetch', globalFetch);

    await expect(createOpenCodeExternalSessionsContribution({ env }).listCandidates({
      source,
      maxItems: 2,
      ...invocation(),
    })).resolves.toMatchObject({
      ok: true,
      value: {
        candidates: [
          expect.objectContaining({ remoteSessionId: 'managed-session' }),
        ],
      },
    });
    expect(transportFetch).toHaveBeenCalledOnce();
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('rejects full search instead of silently degrading the legacy id-and-title contract', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await createOpenCodeExternalSessionsContribution({ env }).listCandidates({
      source,
      maxItems: 2,
      searchTerm: 'session',
      searchMode: 'full',
      ...invocation(),
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'unsupported',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves official backward cursors and bounded read-after continuity', async () => {
    const requested: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      requested.push(input);
      const url = new URL(input);
      if (url.pathname === '/session/session-1') {
        return new Response(JSON.stringify({
          id: 'session-1',
          time: { created: 100, updated: 200 },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      const before = url.searchParams.get('before');
      const messages = before
        ? [{
          info: { id: 'message-0', role: 'user', time: { created: 0 } },
          parts: [{ type: 'text', text: 'older' }],
        }]
        : url.searchParams.get('limit') === '3'
          ? [
            {
              info: { id: 'message-2', role: 'assistant', time: { created: 2 } },
              parts: [{ type: 'text', text: 'answer' }],
            },
            {
              info: { id: 'message-3', role: 'user', time: { created: 3 } },
              parts: [{ type: 'text', text: 'new' }],
            },
          ]
          : [
            {
              info: { id: 'message-1', role: 'user', time: { created: 1 } },
              parts: [{ type: 'text', text: 'question' }],
            },
            {
              info: { id: 'message-2', role: 'assistant', time: { created: 2 } },
              parts: [{ type: 'text', text: 'answer' }],
            },
          ];
      return new Response(JSON.stringify(messages), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          ...(before ? {} : url.searchParams.get('limit') === '2'
            ? { 'x-next-cursor': 'official-older' }
            : {}),
        },
      });
    }));
    const contribution = createOpenCodeExternalSessionsContribution({ env });

    const first = await contribution.pageTranscript({
      source,
      remoteSessionId: 'session-1',
      direction: 'older',
      maxItems: 2,
      ...invocation(),
    });
    expect(first).toMatchObject({
      ok: true,
      value: {
        nextCursor: expect.any(String),
        hasMore: true,
      },
    });
    if (!first.ok || !first.value.tailCursor) throw new Error('Missing tail cursor');

    const older = await contribution.pageTranscript({
      source,
      remoteSessionId: 'session-1',
      direction: 'older',
      cursor: first.value.nextCursor ?? undefined,
      maxItems: 2,
      ...invocation(),
    });
    expect(older).toMatchObject({
      ok: true,
      value: {
        items: [expect.objectContaining({ id: 'opencode:session-1:message-0' })],
        nextCursor: null,
      },
    });

    const after = await contribution.readAfterTranscript({
      source,
      remoteSessionId: 'session-1',
      cursor: first.value.tailCursor,
      maxItems: 2,
      ...invocation(),
    });
    expect(after).toMatchObject({
      ok: true,
      value: {
        outcome: 'advanced',
        items: [expect.objectContaining({ id: 'opencode:session-1:message-3' })],
        boundary: expect.any(String),
      },
    });
    expect(requested.some((url) => url.includes('before=official-older'))).toBe(true);
    expect(requested.some((url) => url.includes('limit=3'))).toBe(true);
  });

  it('round-trips the canonical OpenCode runtime identity through public linkData', async () => {
    const contribution = createOpenCodeExternalSessionsContribution({ env: {} });
    const runtimeDescriptorV1 = buildOpenCodeAgentRuntimeDescriptorV1({
      backendMode: 'server',
      providerSessionId: 'session-canonical',
      serverBaseUrl: baseUrl,
      serverBaseUrlExplicit: true,
    });

    const linked = await contribution.resolveLinkIdentity({
      source,
      remoteSessionId: 'session-candidate',
      linkData: { runtimeDescriptorV1 },
      ...invocation(),
    });
    expect(linked).toMatchObject({
      ok: true,
      value: {
        source: {
          ...source,
          baseUrl: `${baseUrl}/`,
        },
        remoteSessionId: 'session-canonical',
        linkData: {
          runtimeDescriptorV1,
          opencodeSessionId: 'session-canonical',
          opencodeBackendMode: 'server',
          opencodeServerBaseUrl: `${baseUrl}/`,
          opencodeServerBaseUrlExplicit: true,
        },
      },
    });
    if (!linked.ok) throw new Error('Expected a linked identity');

    expect(await contribution.resolveLinkedIdentity({
      source: linked.value.source,
      remoteSessionId: linked.value.remoteSessionId,
      linkData: linked.value.linkData,
      ...invocation(),
    })).toMatchObject({
      ok: true,
      value: {
        source: {
          ...source,
          baseUrl: `${baseUrl}/`,
        },
        remoteSessionId: 'session-canonical',
        linkData: {
          runtimeDescriptorV1,
          opencodeSessionId: 'session-canonical',
          opencodeBackendMode: 'server',
          opencodeServerBaseUrl: `${baseUrl}/`,
          opencodeServerBaseUrlExplicit: true,
        },
      },
    });
  });

  it('canonicalizes persisted default links from the vendor-owned session directory', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input);
      expect(url.pathname).toBe('/session/session-persisted');
      expect(url.searchParams.has('directory')).toBe(false);
      return new Response(JSON.stringify({
        id: 'session-persisted',
        directory: '/tmp/persisted-project',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    await expect(createOpenCodeExternalSessionsContribution({ env }).resolveLinkedIdentity({
      source: {
        kind: 'opencodeServer',
        baseUrl,
      },
      remoteSessionId: 'session-persisted',
      linkData: {},
      ...invocation(),
    })).resolves.toMatchObject({
      ok: true,
      value: {
        source: {
          kind: 'opencodeServer',
          baseUrl,
          directory: '/tmp/persisted-project',
        },
        remoteSessionId: 'session-persisted',
      },
    });
  });

  it('fails closed when a default link has no vendor-verifiable directory', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      id: 'session-unscoped',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    await expect(createOpenCodeExternalSessionsContribution({ env }).resolveLinkIdentity({
      source: {
        kind: 'opencodeServer',
        baseUrl,
      },
      remoteSessionId: 'session-unscoped',
      ...invocation(),
    })).resolves.toMatchObject({
      ok: false,
      code: 'agent_unavailable',
      retryable: true,
    });
  });

  it('preserves providerExtra precedence for canonical persisted link identities', async () => {
    const contribution = createOpenCodeExternalSessionsContribution({ env: {} });
    const runtimeDescriptorV1 = {
      v: 1,
      agentId: 'opencode',
      agent: {
        backendMode: 'acp',
        providerSessionId: 'session-stale',
        serverBaseUrl: 'http://legacy.example/',
        providerExtra: {
          owner: 'opencode',
          schemaId: 'opencode.agentRuntimeDescriptorExtra',
          v: 1,
          runtimeHandle: {
            backendMode: 'server',
            providerSessionId: 'session-canonical',
            serverBaseUrl: `${baseUrl}/`,
            serverBaseUrlExplicit: true,
          },
        },
      },
    };

    const result = await contribution.resolveLinkIdentity({
      source,
      remoteSessionId: 'session-candidate',
      linkData: { runtimeDescriptorV1 },
      ...invocation(),
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        remoteSessionId: 'session-canonical',
        source: {
          ...source,
          baseUrl: `${baseUrl}/`,
        },
        linkData: {
          opencodeSessionId: 'session-canonical',
          opencodeBackendMode: 'server',
          opencodeServerBaseUrl: `${baseUrl}/`,
          opencodeServerBaseUrlExplicit: true,
          runtimeDescriptorV1: {
            agent: {
              backendMode: 'server',
              providerSessionId: 'session-canonical',
              serverBaseUrl: `${baseUrl}/`,
            },
          },
        },
      },
    });
  });

  it('keeps a successful empty list distinct from transport failure', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('[]', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('offline', {
        status: 503,
        statusText: 'Service Unavailable',
      }));
    vi.stubGlobal('fetch', fetchMock);
    const contribution = createOpenCodeExternalSessionsContribution({ env });
    const request = {
      source,
      maxItems: 2,
      ...invocation(),
    };

    await expect(contribution.listCandidates(request)).resolves.toEqual({
      ok: true,
      value: {
        candidates: [],
        nextCursor: null,
      },
    });
    await expect(contribution.listCandidates(request)).resolves.toMatchObject({
      ok: false,
      code: 'agent_unavailable',
      retryable: true,
    });
  });
});
