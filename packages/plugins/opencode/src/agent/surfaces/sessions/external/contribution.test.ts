import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentExternalSessionsManagedEndpointRead,
} from '@happier-dev/plugin-sdk/sessions/external';

import { buildOpenCodeAgentRuntimeDescriptorV1 } from '../../../identity/runtimeDescriptor.js';
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
  managedEndpointRead: AgentExternalSessionsManagedEndpointRead;
}> = {}) {
  return {
    signal: new AbortController().signal,
    deadlineAtMs: Date.now() + 10_000,
    maxSerializedBytes: 100_000,
    // Every OpenCode read — attached or owned — is served by the host managed
    // endpoint now, so the default stands in for the host: it holds the
    // endpoint address and issues the request. Tests keep asserting the
    // resulting absolute URL through the stubbed global fetch.
    managedEndpointRead: async ({ pathAndQuery }: Readonly<{ pathAndQuery: string }>) => {
      const response = await globalThis.fetch(`${baseUrl}${pathAndQuery}`, { method: 'GET' });
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: response.body,
      };
    },
    ...overrides,
  };
}

describe('OpenCode public External Sessions contribution', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads an explicit external source through the managed endpoint without promoting its address into the source', async () => {
    const directFetch = vi.fn();
    vi.stubGlobal('fetch', directFetch);
    const requested: string[] = [];
    const managedEndpointRead = vi.fn<AgentExternalSessionsManagedEndpointRead>(
      async ({ pathAndQuery }) => {
        requested.push(pathAndQuery);
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
          body: new Response(JSON.stringify([
            { id: 'external-session', title: 'External', time: { updated: 3 } },
          ])).body,
        };
      },
    );
    const contribution = createOpenCodeExternalSessionsContribution({ env: {} });

    const resolved = await contribution.resolveSource({
      source: {
        kind: 'opencodeServer',
        baseUrl,
        directory: '/tmp/project',
      },
      ...invocation({ managedEndpointRead }),
    });
    expect(resolved).toEqual({
      ok: true,
      value: {
        source: {
          kind: 'opencodeServer',
          baseUrl,
          directory: '/tmp/project',
        },
      },
    });
    if (!resolved.ok) throw new Error('Expected managed configured source');

    const listed = await contribution.listCandidates({
      source: resolved.value.source,
      maxItems: 2,
      ...invocation({ managedEndpointRead }),
    });
    expect(listed).toMatchObject({
      ok: true,
      value: {
        candidates: [
          expect.objectContaining({
            remoteSessionId: 'external-session',
            linkData: { runtimeDescriptorV1: expect.any(Object) },
          }),
        ],
      },
    });
    if (!listed.ok) throw new Error('Expected managed candidates');
    expect(Object.keys(listed.value.candidates[0] ?? {}).sort()).toEqual([
      'linkData',
      'remoteSessionId',
      'title',
      'updatedAtMs',
    ]);
    // The endpoint address stays with the managed service; it is never
    // promoted into the resolved source, and no client-owned transport exists
    // to bypass it.
    expect(requested).toEqual(['/experimental/session?directory=%2Ftmp%2Fproject&limit=3']);
    expect(directFetch).not.toHaveBeenCalled();
  });

  it('resolves a configured managed source without promoting endpoint authority', async () => {
    const managedEndpointRead = vi.fn<AgentExternalSessionsManagedEndpointRead>(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: {},
      body: new Response('{}').body,
    }));

    const result = await createOpenCodeExternalSessionsContribution({ env }).resolveSource({
      source: { kind: 'opencodeServer' },
      ...invocation({ managedEndpointRead }),
    });

    expect(result).toEqual({
      ok: true,
      value: {
        source: {
          kind: 'opencodeServer',
          managedEndpoint: true,
        },
      },
    });
    expect(managedEndpointRead).not.toHaveBeenCalled();
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

  it('reports newer transcript paging as typed unsupported instead of an authoritative empty page', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(createOpenCodeExternalSessionsContribution({ env }).pageTranscript({
      source,
      remoteSessionId: 'session-1',
      direction: 'newer',
      maxItems: 10,
      ...invocation(),
    })).resolves.toMatchObject({
      ok: false,
      code: 'unsupported',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('serves one semantic item per page when a smaller item limit meets one tool pair', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input);
      const body = url.pathname === '/session/session-1'
        ? {
            id: 'session-1',
            time: { created: 1 },
          }
        : [{
            info: { id: 'message-tools', role: 'assistant', time: { created: 1 } },
            parts: [{
              type: 'tool',
              sessionID: 'session-1',
              messageID: 'message-tools',
              callID: 'call-tools',
              tool: 'bash',
              state: { status: 'completed', input: { command: 'pwd' }, output: '/repo\\n' },
            }],
          }];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    const contribution = createOpenCodeExternalSessionsContribution({ env });

    // One native message holds both the call and its terminal result; a page
    // smaller than the pair serves one item at a time and resumes inside the
    // exact message instead of failing nonretryably.
    const first = await contribution.pageTranscript({
      source,
      remoteSessionId: 'session-1',
      direction: 'older',
      maxItems: 1,
      ...invocation(),
    });
    expect(first).toMatchObject({ ok: true });
    if (!first.ok) throw new Error('Expected a bounded tool page');
    expect(first.value.items.map((item) => item.id)).toEqual([
      'opencode:session-1:message-tools:tool-result:call-tools',
    ]);
    expect(first.value.hasMore).toBe(true);

    const second = await contribution.pageTranscript({
      source,
      remoteSessionId: 'session-1',
      direction: 'older',
      cursor: first.value.nextCursor ?? undefined,
      maxItems: 1,
      ...invocation(),
    });
    expect(second).toMatchObject({ ok: true });
    if (!second.ok) throw new Error('Expected the intra-message continuation page');
    expect(second.value.items.map((item) => item.id)).toEqual([
      'opencode:session-1:message-tools:tool-call:call-tools',
    ]);
    expect(second.value.hasMore).toBe(false);
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
      `${baseUrl}/experimental/session?directory=%2Ftmp%2Fproject&limit=3&search=Needle`,
    ]);
  });

  it('routes explicitly attached candidate discovery through the configured endpoint', async () => {
    const transportFetch = vi.fn(async () => new Response(JSON.stringify([
      { id: 'managed-session', title: 'Managed', time: { updated: 3 } },
    ]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', transportFetch);

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
  });

  it('uses the invocation-bound reader for managed candidate and transcript reads', async () => {
    const recycledUnauthenticatedFetch = vi.fn(async () => new Response('[]', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', recycledUnauthenticatedFetch);
    const contribution = createOpenCodeExternalSessionsContribution({ env });
    const managedSource = {
      kind: 'opencodeServer' as const,
      managedEndpoint: true as const,
    };
    const managedEndpointRead = vi.fn<AgentExternalSessionsManagedEndpointRead>(
      async ({ pathAndQuery }) => {
        const body = pathAndQuery === '/experimental/session?limit=3'
          ? JSON.stringify([
            { id: 'managed-session', title: 'Managed', time: { updated: 3, created: 1 } },
          ])
          : pathAndQuery === '/session/managed-session'
            ? JSON.stringify({
                id: 'managed-session',
                directory: '/tmp/project',
                time: { created: 1 },
              })
            : pathAndQuery.startsWith('/session/managed-session/message')
              ? '[]'
              : '{}';
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
          body: new Response(body).body,
        };
      },
    );

    await expect(contribution.listCandidates({
      source: managedSource,
      maxItems: 2,
      ...invocation({ managedEndpointRead }),
    })).resolves.toMatchObject({
      ok: true,
      value: {
        candidates: [expect.objectContaining({ remoteSessionId: 'managed-session' })],
      },
    });
    await expect(contribution.pageTranscript({
      source: managedSource,
      remoteSessionId: 'managed-session',
      direction: 'older',
      maxItems: 2,
      ...invocation({ managedEndpointRead }),
    })).resolves.toMatchObject({
      ok: true,
    });
    await expect(contribution.readAfterTranscript({
      source: managedSource,
      remoteSessionId: 'managed-session',
      cursor: 'tail',
      maxItems: 2,
      ...invocation({ managedEndpointRead }),
    })).resolves.toMatchObject({
      ok: true,
      value: { outcome: 'already_current' },
    });
    const linked = await contribution.resolveLinkIdentity({
      source: managedSource,
      remoteSessionId: 'managed-session',
      ...invocation({ managedEndpointRead }),
    });
    if (!linked.ok) throw new Error('Expected managed linked identity');
    expect(linked.value.source).toEqual({
      kind: 'opencodeServer',
      managedEndpoint: true,
      directory: '/tmp/project',
    });

    const reconstructed = await contribution.resolveLinkedIdentity({
      source: linked.value.source,
      remoteSessionId: linked.value.remoteSessionId,
      linkData: linked.value.linkData,
      ...invocation({ managedEndpointRead }),
    });
    if (!reconstructed.ok) throw new Error('Expected reconstructed managed identity');
    expect(reconstructed.value.source).toEqual({
      kind: 'opencodeServer',
      managedEndpoint: true,
      directory: '/tmp/project',
    });
    expect(managedEndpointRead).toHaveBeenCalled();
    expect(recycledUnauthenticatedFetch).not.toHaveBeenCalled();
  });

  it('reconstructs an explicit external linked source without endpoint authority fields', async () => {
    const contribution = createOpenCodeExternalSessionsContribution({ env });

    const linked = await contribution.resolveLinkIdentity({
      source,
      remoteSessionId: 'external-session',
      ...invocation(),
    });
    expect(linked).toMatchObject({
      ok: true,
      value: {
        source: {
          kind: 'opencodeServer',
          directory: source.directory,
        },
      },
    });
    if (!linked.ok) throw new Error('Expected a linked external identity');

    await expect(contribution.resolveLinkedIdentity({
      source: linked.value.source,
      remoteSessionId: linked.value.remoteSessionId,
      linkData: linked.value.linkData,
      ...invocation(),
    })).resolves.toMatchObject({
      ok: true,
      value: {
        source: {
          kind: 'opencodeServer',
          directory: source.directory,
        },
      },
    });
  });

  it('performs complete id-and-title search instead of rejecting the public full-search mode', async () => {
    const requested: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      requested.push(input);
      return new Response(JSON.stringify([
        { id: 'other-session', title: 'A title without the query', time: { updated: 2 } },
        { id: 'needle-session-id', title: 'A title without the query', time: { updated: 1 } },
      ]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    const result = await createOpenCodeExternalSessionsContribution({ env }).listCandidates({
      source,
      maxItems: 2,
      searchTerm: 'needle-session-id',
      searchMode: 'full',
      ...invocation(),
    });

    expect(result).toEqual({
      ok: true,
      value: {
        candidates: [expect.objectContaining({ remoteSessionId: 'needle-session-id' })],
        nextCursor: null,
      },
    });
    expect(requested).toEqual([
      `${baseUrl}/experimental/session?directory=%2Ftmp%2Fproject&limit=3`,
    ]);
  });

  it('continues a global candidate page from the active project into another project without index preparation', async () => {
    const activeProjectSessions = Array.from({ length: 50 }, (_, index) => ({
      id: `session-${String(index + 1).padStart(3, '0')}`,
      title: `Session ${index + 1}`,
      time: { updated: 10_000 - index },
    }));
    const globalSessions = [
      ...activeProjectSessions,
      {
        id: 'other-project-session-051',
        title: 'Other project session',
        time: { updated: 9_949 },
      },
    ];
    const requested: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input);
      requested.push(url.toString());
      if (url.pathname === '/session') {
        return new Response(JSON.stringify(
          activeProjectSessions.slice(0, Number(url.searchParams.get('limit'))),
        ), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      const cursor = url.searchParams.get('cursor');
      const visible = cursor === null
        ? globalSessions
        : globalSessions.filter((session) => session.time.updated < Number(cursor));
      return new Response(JSON.stringify(visible.slice(0, Number(url.searchParams.get('limit')))), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    const contribution = createOpenCodeExternalSessionsContribution({ env });
    const globalSource = {
      kind: 'opencodeServer' as const,
      baseUrl,
    };

    const first = await contribution.listCandidates({
      source: globalSource,
      maxItems: 50,
      ...invocation(),
    });
    expect(first).toMatchObject({
      ok: true,
      value: {
        candidates: Array.from({ length: 50 }, () => expect.any(Object)),
        nextCursor: expect.any(String),
      },
    });
    if (!first.ok || !first.value.nextCursor) throw new Error('Expected a candidate continuation');
    expect(first.value).not.toHaveProperty('preparation');

    const second = await contribution.listCandidates({
      source: globalSource,
      maxItems: 50,
      cursor: first.value.nextCursor,
      ...invocation(),
    });

    expect(second).toMatchObject({
      ok: true,
      value: {
        candidates: [expect.objectContaining({ remoteSessionId: 'other-project-session-051' })],
        nextCursor: null,
      },
    });
    if (!second.ok) throw new Error('Expected a global source continuation');
    expect(second.value).not.toHaveProperty('preparation');
    expect(requested).toContain(
      `${baseUrl}/experimental/session?limit=52&cursor=9952`,
    );
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

  // The admitted External Sessions source is the identity the host persisted and
  // re-presents; the runtime descriptor is derived data. If reconstruction hands
  // back a different address the host refuses the link as `source_invalid`, so a
  // reverse-proxied OpenCode simply stops working after persistence.
  it.each([
    ['a bare origin', 'https://opencode.example.test'],
    ['a reverse-proxy path', 'https://opencode.example.test/proxy/opencode'],
  ])('preserves %s admitted OpenCode source byte-for-byte across link persistence', async (_label, admittedBaseUrl) => {
    const contribution = createOpenCodeExternalSessionsContribution({ env: {} });
    const admittedSource = {
      kind: 'opencodeServer' as const,
      baseUrl: admittedBaseUrl,
      directory: '/tmp/project',
    };
    const runtimeDescriptorV1 = buildOpenCodeAgentRuntimeDescriptorV1({
      backendMode: 'server',
      providerSessionId: 'session-canonical',
      serverBaseUrl: admittedBaseUrl,
      serverBaseUrlExplicit: true,
    });

    const linked = await contribution.resolveLinkIdentity({
      source: admittedSource,
      remoteSessionId: 'session-candidate',
      linkData: { runtimeDescriptorV1 },
      ...invocation(),
    });
    expect(linked).toMatchObject({
      ok: true,
      value: {
        source: admittedSource,
        remoteSessionId: 'session-canonical',
        linkData: {
          opencodeSessionId: 'session-canonical',
          opencodeBackendMode: 'server',
          opencodeServerBaseUrl: admittedBaseUrl,
          opencodeServerBaseUrlExplicit: true,
        },
      },
    });
    if (!linked.ok) throw new Error('Expected a linked identity');
    expect(linked.value.source).toEqual(admittedSource);

    const reconstructed = await contribution.resolveLinkedIdentity({
      source: linked.value.source,
      remoteSessionId: linked.value.remoteSessionId,
      linkData: linked.value.linkData,
      ...invocation(),
    });
    expect(reconstructed).toMatchObject({
      ok: true,
      value: {
        source: admittedSource,
        remoteSessionId: 'session-canonical',
        linkData: {
          opencodeSessionId: 'session-canonical',
          opencodeBackendMode: 'server',
          opencodeServerBaseUrl: admittedBaseUrl,
          opencodeServerBaseUrlExplicit: true,
        },
      },
    });
    if (!reconstructed.ok) throw new Error('Expected a reconstructed identity');
    expect(reconstructed.value.source).toEqual(admittedSource);
  });

  // Re-pointing the configured server is an ordinary edit. The persisted
  // descriptor records where the session used to be reached; it is not the
  // authority for which server the user just admitted.
  it('never lets a persisted runtime descriptor rewrite a re-pointed admitted source', async () => {
    const contribution = createOpenCodeExternalSessionsContribution({ env: {} });
    const admittedSource = {
      kind: 'opencodeServer' as const,
      baseUrl: 'https://opencode.example.test/proxy/new',
      directory: '/tmp/project',
    };
    const stalePersistedDescriptor = buildOpenCodeAgentRuntimeDescriptorV1({
      backendMode: 'server',
      providerSessionId: 'session-canonical',
      serverBaseUrl: 'https://opencode.example.test/proxy/old',
      serverBaseUrlExplicit: true,
    });

    const reconstructed = await contribution.resolveLinkedIdentity({
      source: admittedSource,
      remoteSessionId: 'session-canonical',
      linkData: {
        runtimeDescriptorV1: stalePersistedDescriptor,
        opencodeSessionId: 'session-canonical',
        opencodeBackendMode: 'server',
        opencodeServerBaseUrl: 'https://opencode.example.test/proxy/old',
        opencodeServerBaseUrlExplicit: true,
      },
      ...invocation(),
    });
    if (!reconstructed.ok) throw new Error('Expected a reconstructed identity');
    expect(reconstructed.value.source).toEqual(admittedSource);
  });

  it('keeps a managed source authoritative over a URL-bearing canonical runtime descriptor', async () => {
    const contribution = createOpenCodeExternalSessionsContribution({ env: {} });
    const runtimeDescriptorV1 = buildOpenCodeAgentRuntimeDescriptorV1({
      backendMode: 'server',
      providerSessionId: 'session-managed-canonical',
      serverBaseUrl: baseUrl,
      serverBaseUrlExplicit: true,
    });

    await expect(contribution.resolveLinkIdentity({
      source: {
        kind: 'opencodeServer',
        managedEndpoint: true,
        directory: '/tmp/managed-project',
      },
      remoteSessionId: 'session-candidate',
      linkData: {
        runtimeDescriptorV1,
        opencodeServerBaseUrl: 'http://stale-managed.example/',
        opencodeServerBaseUrlExplicit: true,
        vendorSafe: { retained: true },
      },
      ...invocation(),
    })).resolves.toEqual({
      ok: true,
      value: {
        source: {
          kind: 'opencodeServer',
          managedEndpoint: true,
          directory: '/tmp/managed-project',
        },
        remoteSessionId: 'session-managed-canonical',
        linkData: {
          opencodeSessionId: 'session-managed-canonical',
          opencodeBackendMode: 'server',
          vendorSafe: { retained: true },
          runtimeDescriptorV1: buildOpenCodeAgentRuntimeDescriptorV1({
            backendMode: 'server',
            providerSessionId: 'session-managed-canonical',
          }),
        },
      },
    });
  });

  it('keeps a managed source authoritative over URL-bearing persisted runtime metadata', async () => {
    const contribution = createOpenCodeExternalSessionsContribution({ env: {} });
    const persistedRuntimeDescriptorV1 = buildOpenCodeAgentRuntimeDescriptorV1({
      backendMode: 'server',
      providerSessionId: 'session-managed-persisted',
      serverBaseUrl: baseUrl,
      serverBaseUrlExplicit: true,
    });

    await expect(contribution.resolveLinkedIdentity({
      source: {
        kind: 'opencodeServer',
        managedEndpoint: true,
        directory: '/tmp/managed-project',
      },
      remoteSessionId: 'session-fallback',
      linkData: {
        runtimeDescriptorV1: persistedRuntimeDescriptorV1,
        opencodeServerBaseUrl: 'http://stale-managed.example/',
        opencodeServerBaseUrlExplicit: true,
        vendorSafe: { retained: true },
      },
      ...invocation(),
    })).resolves.toEqual({
      ok: true,
      value: {
        source: {
          kind: 'opencodeServer',
          managedEndpoint: true,
          directory: '/tmp/managed-project',
        },
        remoteSessionId: 'session-managed-persisted',
        linkData: {
          opencodeSessionId: 'session-managed-persisted',
          opencodeBackendMode: 'server',
          vendorSafe: { retained: true },
          runtimeDescriptorV1: buildOpenCodeAgentRuntimeDescriptorV1({
            backendMode: 'server',
            providerSessionId: 'session-managed-persisted',
          }),
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
        source,
        linkData: {
          opencodeSessionId: 'session-canonical',
          opencodeBackendMode: 'server',
          opencodeServerBaseUrl: baseUrl,
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

  it('keeps a successful empty list distinct from malformed success and transport failure', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('[]', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('{}', {
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
    await expect(contribution.listCandidates(request)).resolves.toMatchObject({
      ok: false,
      code: 'agent_unavailable',
      retryable: true,
    });
  });
});
