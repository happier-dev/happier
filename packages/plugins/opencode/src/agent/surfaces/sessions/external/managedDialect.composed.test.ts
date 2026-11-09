import { describe, expect, it, vi } from 'vitest';

import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import type {
  AgentExternalSessionsManagedEndpointRead,
  AgentExternalSessionSource,
} from '@happier-dev/plugin-sdk/sessions/external';

import { createOpenCodeExternalSessionsContribution } from './contribution.js';
import { resolveOpenCodeExternalSessionsManagedService } from './managedServer.js';

/**
 * One composed proof that the executable Happier resolves for a browse-owned
 * OpenCode server decides **both** halves of that server's contract: the
 * readiness route the managed-service declaration probes, and the request routes
 * every External Sessions read then uses against it.
 *
 * The gap this pins: a beta-only machine resolves `opencode2`, whose server
 * mounts `/api/*` and no `/global/*` at all
 * (`comparators/opencode` at `10765ff2a9da8c3b88e4de873aa383a49c318912`,
 * `packages/protocol/src/api.ts`). Declaring V1 readiness left that server
 * permanently unhealthy, and V1 request routes would 404 on every read even once
 * it was reachable.
 *
 * Only the process/tool boundary (`ExecService.systemTools`) and the HTTP
 * boundary (the host's managed-endpoint reader) are faked; the contribution,
 * candidate walk, transcript projection and route selection are the real code.
 */

const V2_EXECUTABLE = '/usr/local/bin/opencode2';
const STABLE_EXECUTABLE = '/usr/local/bin/opencode';

function createExec(executablePath: string): Readonly<{
  exec: ExecService;
  resolve: ReturnType<typeof vi.fn>;
}> {
  const resolve = vi.fn(async () => ({ executablePath }));
  // Boundary fixture: the composed code under test reads only `executablePath`
  // from the host's system-tool resolution, and the real `ExecService` carries
  // process/spawn surfaces this test must never reach.
  const exec = { systemTools: { resolve } } as unknown as ExecService;
  return { exec, resolve };
}

type RecordedRequest = string;

function createManagedEndpointRead(
  respond: (pathAndQuery: string) => unknown,
): Readonly<{
  read: AgentExternalSessionsManagedEndpointRead;
  requests: RecordedRequest[];
}> {
  const requests: RecordedRequest[] = [];
  const read: AgentExternalSessionsManagedEndpointRead = async ({ pathAndQuery }) => {
    requests.push(pathAndQuery);
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      body: new Response(JSON.stringify(respond(pathAndQuery))).body,
    };
  };
  return { read, requests };
}

const MANAGED_SOURCE: AgentExternalSessionSource = {
  kind: 'opencodeServer',
  managedEndpoint: true,
  directory: '/tmp/project',
};

const V2_SESSION = {
  id: 'ses_v2',
  title: 'Beta session',
  time: { created: 1_700_000_000_000, updated: 1_700_000_100_000 },
  location: { directory: '/tmp/project' },
};

const V2_MESSAGE = {
  id: 'msg_v2',
  type: 'user',
  text: 'hello from the beta server',
  time: { created: 1_700_000_050_000 },
};

function v2Response(pathAndQuery: string): unknown {
  const path = pathAndQuery.split('?')[0] ?? '';
  if (path === '/api/info') return { version: '2.0.15', pid: 123, urls: [], paths: { tmp: '/tmp' } };
  if (path === '/api/session') return { data: [V2_SESSION], cursor: { next: 'vendor-next' } };
  if (path === '/api/session/active') return { data: { [V2_SESSION.id]: { type: 'running' } } };
  if (path === `/api/session/${V2_SESSION.id}`) return { data: V2_SESSION };
  if (path === `/api/session/${V2_SESSION.id}/message`) return { data: [V2_MESSAGE], cursor: {} };
  throw new Error(`unexpected V2 request: ${pathAndQuery}`);
}

function v1Response(pathAndQuery: string): unknown {
  const path = pathAndQuery.split('?')[0] ?? '';
  if (path === '/global/health') return { healthy: true };
  if (path === '/experimental/session') {
    return [{
      id: 'ses_v1',
      title: 'Stable session',
      time: { created: 1_700_000_000_000, updated: 1_700_000_100_000 },
      directory: '/tmp/project',
    }];
  }
  throw new Error(`unexpected V1 request: ${pathAndQuery}`);
}

function invocation(read: AgentExternalSessionsManagedEndpointRead, exec: ExecService) {
  return {
    signal: new AbortController().signal,
    deadlineAtMs: Date.now() + 60_000,
    maxSerializedBytes: 256_000,
    managedEndpointRead: read,
    exec,
  };
}

describe('managed External Sessions dialect', () => {
  it('declares V2 readiness for a browse-owned server whose resolved executable is opencode2', async () => {
    const { exec, resolve } = createExec(V2_EXECUTABLE);

    const spec = await resolveOpenCodeExternalSessionsManagedService({
      source: MANAGED_SOURCE,
      signal: new AbortController().signal,
      exec,
    });

    expect(spec?.healthCheck).toMatchObject({
      kind: 'http',
      target: { kind: 'servicePath', path: '/api/health' },
    });
    expect(resolve).toHaveBeenCalledOnce();
  });

  it('keeps the legacy readiness route for a browse-owned stable opencode server', async () => {
    const { exec } = createExec(STABLE_EXECUTABLE);

    const spec = await resolveOpenCodeExternalSessionsManagedService({
      source: MANAGED_SOURCE,
      signal: new AbortController().signal,
      exec,
    });

    expect(spec?.healthCheck).toMatchObject({
      target: { kind: 'servicePath', path: '/global/health' },
    });
  });

  it('negotiates an attached server without inferring its dialect from a local executable', async () => {
    // Happier did not spawn this process, so no executable fact exists for it.
    // Its authenticated readiness therefore tries the released V2 contract and
    // retained V1 contract in order, while the local resolver is not consulted.
    const { exec, resolve } = createExec(V2_EXECUTABLE);

    const spec = await resolveOpenCodeExternalSessionsManagedService({
      source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096' },
      signal: new AbortController().signal,
      exec,
    });

    expect(spec?.healthCheck).toMatchObject({
      kind: 'http',
      alternatives: [
        { target: { kind: 'servicePath', path: '/api/info' } },
        { target: { kind: 'servicePath', path: '/global/health' } },
      ],
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('reads attached dialect and candidates from the portable managed response body', async () => {
    const { exec } = createExec(V2_EXECUTABLE);
    const { read } = createManagedEndpointRead(v2Response);
    // The host boundary promises the portable reader subset, not a DOM stream.
    const portableRead: AgentExternalSessionsManagedEndpointRead = async (request) => {
      const response = await read(request);
      const body = response.body;
      return {
        ...response,
        body: body === null ? null : {
          cancel: (reason?: unknown) => body.cancel(reason),
          getReader: () => body.getReader(),
        },
      };
    };
    const contribution = createOpenCodeExternalSessionsContribution({ env: {} });
    const result = await contribution.listCandidates({
      ...invocation(portableRead, exec),
      source: MANAGED_SOURCE,
      maxItems: 10,
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.candidates.map(candidate => candidate.remoteSessionId))
      .toEqual([V2_SESSION.id]);
  });

  it('lists candidates over the V2 session route and envelope', async () => {
    const { exec } = createExec(V2_EXECUTABLE);
    const { read, requests } = createManagedEndpointRead(v2Response);
    const contribution = createOpenCodeExternalSessionsContribution({ env: {} });

    const result = await contribution.listCandidates({
      ...invocation(read, exec),
      source: MANAGED_SOURCE,
      maxItems: 10,
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.candidates.map((candidate) => candidate.remoteSessionId))
      .toEqual([V2_SESSION.id]);
    expect(requests).toEqual([
      '/api/info',
      '/api/session?directory=%2Ftmp%2Fproject&limit=10',
    ]);
  });

  it('continues a V2 candidate page through the server opaque cursor', async () => {
    const { exec } = createExec(V2_EXECUTABLE);
    const { read, requests } = createManagedEndpointRead(v2Response);
    const contribution = createOpenCodeExternalSessionsContribution({ env: {} });

    const first = await contribution.listCandidates({
      ...invocation(read, exec),
      source: MANAGED_SOURCE,
      maxItems: 1,
    });
    expect(first.ok).toBe(true);
    const nextCursor = first.ok ? first.value.nextCursor : null;
    expect(nextCursor).toBeTypeOf('string');

    await contribution.listCandidates({
      ...invocation(read, exec),
      source: MANAGED_SOURCE,
      maxItems: 1,
      ...(nextCursor ? { cursor: nextCursor } : {}),
    });

    expect(requests[3]).toBe('/api/session?limit=1&cursor=vendor-next');
  });

  it('pages a transcript over the V2 session and message routes', async () => {
    const { exec } = createExec(V2_EXECUTABLE);
    const { read, requests } = createManagedEndpointRead(v2Response);
    const contribution = createOpenCodeExternalSessionsContribution({ env: {} });

    const page = await contribution.pageTranscript({
      ...invocation(read, exec),
      source: MANAGED_SOURCE,
      remoteSessionId: V2_SESSION.id,
      direction: 'older',
      maxItems: 10,
    });

    expect(page.ok).toBe(true);
    expect(page.ok && page.value.items.map((item) => item.messageRole)).toEqual(['user']);
    expect(requests).toEqual([
      '/api/info',
      `/api/session/${V2_SESSION.id}`,
      `/api/session/${V2_SESSION.id}/message?limit=10`,
      `/api/session/${V2_SESSION.id}`,
    ]);
  });

  it('keeps a stable opencode browse on the proven V1 routes', async () => {
    const { exec } = createExec(STABLE_EXECUTABLE);
    const { read, requests } = createManagedEndpointRead(v1Response);
    const contribution = createOpenCodeExternalSessionsContribution({ env: {} });

    const result = await contribution.listCandidates({
      ...invocation(read, exec),
      source: MANAGED_SOURCE,
      maxItems: 10,
    });

    expect(result.ok).toBe(true);
    expect(requests).toEqual([
      '/api/info',
      '/global/health',
      '/experimental/session?directory=%2Ftmp%2Fproject&limit=11',
    ]);
  });

  it('does not treat an unrelated 200 HTML /api/info response as V2', async () => {
    const { exec } = createExec(STABLE_EXECUTABLE);
    const requests: string[] = [];
    const read: AgentExternalSessionsManagedEndpointRead = async ({ pathAndQuery }) => {
      requests.push(pathAndQuery);
      if (pathAndQuery === '/api/info') {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'text/html' },
          body: new Response('<html>proxy landing page</html>').body,
        };
      }
      const value = v1Response(pathAndQuery);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
        body: new Response(JSON.stringify(value)).body,
      };
    };
    const contribution = createOpenCodeExternalSessionsContribution({ env: {} });

    const result = await contribution.listCandidates({
      ...invocation(read, exec),
      source: MANAGED_SOURCE,
      maxItems: 10,
    });

    expect(result.ok).toBe(true);
    expect(requests).toEqual([
      '/api/info',
      '/global/health',
      '/experimental/session?directory=%2Ftmp%2Fproject&limit=11',
    ]);
  });
});
