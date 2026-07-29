import { randomBytes } from 'node:crypto';
import { readFileSync as readFileSyncNative, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV,
  resolveConnectedAccountRequestAuthCapabilityPath,
} from './capabilityFile.js';
import {
  CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_HEADER,
  buildConnectedAccountRequestAuthClientSource,
} from './clientSource.js';

const roots: string[] = [];
const originalFetch = globalThis.fetch;
const generatedReadHookGlobal = globalThis as typeof globalThis & {
  __happierRequestAuthAfterRead?: (path: string) => void;
};

const purpose = {
  consumer: {
    pluginId: 'happier.agent.test',
    localId: 'consumer',
  },
  purpose: 'model-request',
} as const;

const requestAuthResponseMaxBytes = 256 * 1024;

function createChunkedResponse(
  body: string,
  status: number,
): Readonly<{
  response: Response;
  producedBytes: () => number;
  wasCancelled: () => boolean;
}> {
  const encoded = new TextEncoder().encode(body);
  let offset = 0;
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= encoded.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + 1024, encoded.byteLength);
      controller.enqueue(encoded.slice(offset, end));
      offset = end;
    },
    cancel() {
      cancelled = true;
    },
  }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
  return {
    response,
    producedBytes: () => offset,
    wasCancelled: () => cancelled,
  };
}

afterEach(async () => {
  globalThis.fetch = originalFetch;
  delete generatedReadHookGlobal.__happierRequestAuthAfterRead;
  delete process.env[CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV];
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function loadGeneratedClient() {
  const root = await mkdtemp(join(tmpdir(), 'happier-request-auth-client-'));
  roots.push(root);
  const modulePath = join(root, 'client.mjs');
  await writeFile(modulePath, [
    'import { readFileSync as requestAuthNativeReadFileSync } from "node:fs";',
    'const readFileSync = (path, options) => {',
    '  const value = requestAuthNativeReadFileSync(path, options);',
    '  globalThis.__happierRequestAuthAfterRead?.(String(path));',
    '  return value;',
    '};',
    buildConnectedAccountRequestAuthClientSource({
      capabilityPathEnv: CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV,
    }),
  ].join('\n'), 'utf8');
  return await import(`${modulePath}?v=${Date.now()}-${Math.random()}`) as Readonly<{
    lookupConnectedAccountRequestAuth: (input: Readonly<{ purpose: unknown; signal?: AbortSignal }>) => Promise<unknown>;
    reportConnectedAccountAuthFailure: (input: Readonly<{
      credentialContext: unknown;
      normalizedFailure: unknown;
      signal?: AbortSignal;
    }>) => Promise<unknown>;
    reportConnectedAccountQuotaFailure: (input: Readonly<{
      credentialContext: unknown;
      normalizedFailure: unknown;
      signal?: AbortSignal;
    }>) => Promise<unknown>;
  }>;
}

async function configureFiles(materializationId = 'run-1') {
  const root = await mkdtemp(join(tmpdir(), 'happier-request-auth-materialized-'));
  roots.push(root);
  const capability = await writeTestCapabilityFile(root, materializationId);
  process.env[CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV] = capability.path;
  return { root, capability };
}

async function writeTestCapabilityFile(root: string, materializationId: string, httpPort = 43210) {
  const path = resolveConnectedAccountRequestAuthCapabilityPath(root);
  await mkdir(join(root, 'request-auth'), { recursive: true });
  const document = {
    v: 2,
    materializationId,
    subjectScopeDigest: 'd'.repeat(64),
    capability: randomBytes(32).toString('base64url'),
    httpPort,
  } as const;
  await writeFile(path, `${JSON.stringify(document)}\n`, { encoding: 'utf8', mode: 0o600 });
  return { path, document };
}

function writeTestCapabilityFileSync(
  path: string,
  materializationId: string,
  capability: string,
  httpPort = 43210,
): void {
  writeFileSync(path, `${JSON.stringify({
    v: 2,
    materializationId,
    subjectScopeDigest: 'd'.repeat(64),
    capability,
    httpPort,
  })}\n`, { encoding: 'utf8', mode: 0o600 });
}

describe('generated connected-account request-auth client source', () => {
  it('rereads the scoped capability on every independent operation and never reads the master token', async () => {
    const { root, capability } = await configureFiles();
    const firstDocument = capability.document;
    const seenCapabilities: string[] = [];
    globalThis.fetch = vi.fn(async (_url, init) => {
      const headers = init?.headers as Record<string, string>;
      seenCapabilities.push(headers['x-happier-connected-account-capability']);
      return new Response(JSON.stringify({
        ok: true,
        value: {
          accessToken: 'access',
          credentialContext: {
            account: {
              service: {
                pluginId: 'happier.connected-account.test',
                localId: 'subscription',
              },
              accountId: 'work',
            },
            credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const client = await loadGeneratedClient();

    await client.lookupConnectedAccountRequestAuth({ purpose });
    const replacement = await writeTestCapabilityFile(root, 'run-1');
    const secondDocument = replacement.document;
    await client.lookupConnectedAccountRequestAuth({ purpose });

    expect(seenCapabilities).toEqual([firstDocument.capability, secondDocument.capability]);
    expect(seenCapabilities).not.toContain('master-token');
  });

  it.each([
    {
      label: 'materialization id whitespace',
      patch: { materializationId: ' run-1 ' },
    },
    {
      label: 'subject scope digest whitespace',
      patch: { subjectScopeDigest: ` ${'d'.repeat(64)} ` },
    },
    {
      label: 'capability whitespace',
      patch: { capability: ` ${'A'.repeat(43)} ` },
    },
    {
      label: 'a 257-byte materialization id',
      patch: { materializationId: 'm'.repeat(257) },
    },
    {
      label: 'a Unicode materialization id above 256 UTF-8 bytes',
      patch: { materializationId: '😀'.repeat(65) },
    },
  ])('rejects $label before crossing the private transport', async ({ patch }) => {
    const { capability } = await configureFiles();
    await writeFile(capability.path, `${JSON.stringify({
      ...capability.document,
      ...patch,
    })}\n`, { encoding: 'utf8', mode: 0o600 });
    const fetchMock = vi.fn(async () => {
      throw new Error('unexpected_private_transport_crossing');
    });
    globalThis.fetch = fetchMock;
    const client = await loadGeneratedClient();

    await expect(client.lookupConnectedAccountRequestAuth({
      purpose,
    })).rejects.toThrow('happier_request_auth_capability_file_invalid');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a materialization id at the exact 256-byte UTF-8 boundary', async () => {
    await configureFiles('😀'.repeat(64));
    const fetchRequestAuth = vi.fn(async () => new Response('Not Found', {
      status: 404,
      headers: { 'content-type': 'text/plain' },
    }));
    globalThis.fetch = fetchRequestAuth as typeof fetch;
    const client = await loadGeneratedClient();

    await expect(client.lookupConnectedAccountRequestAuth({ purpose }))
      .rejects.toMatchObject({ status: 404 });
    expect(fetchRequestAuth).toHaveBeenCalledOnce();
  });

  it('uses distinct strict lookup/auth/quota operations with no forceRefresh or replay field', async () => {
    await configureFiles();
    const bodies: unknown[] = [];
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      urls.push(String(url));
      bodies.push(JSON.parse(String(init?.body)));
      const value = String(url).endsWith('/lookup')
        ? {
            accessToken: 'access',
            credentialContext: {
              account: {
                service: {
                  pluginId: 'happier.connected-account.test',
                  localId: 'subscription',
                },
                accountId: 'work',
              },
              credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
            },
          }
        : { status: 'current_changed' };
      return new Response(JSON.stringify({ ok: true, value }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const client = await loadGeneratedClient();
    const lease = await client.lookupConnectedAccountRequestAuth({ purpose }) as {
      credentialContext: unknown;
    };
    const evidence = {
      class: 'authentication',
      evidence: {
        httpStatus: 401,
        limitCategory: 'auth_invalid',
        quotaScope: 'unknown',
        evidenceSource: { kind: 'structured' },
      },
    };
    await client.reportConnectedAccountAuthFailure({
      credentialContext: lease.credentialContext,
      normalizedFailure: evidence,
    });
    await client.reportConnectedAccountQuotaFailure({
      credentialContext: lease.credentialContext,
      normalizedFailure: {
        class: 'quota',
        evidence: {
          httpStatus: 429,
          limitCategory: 'rate_limit',
          quotaScope: 'unknown',
          evidenceSource: { kind: 'structured' },
        },
      },
    });

    expect(urls.map((url) => new URL(url).pathname)).toEqual([
      '/connected-accounts/request-auth/lookup',
      '/connected-accounts/request-auth/auth-failure',
      '/connected-accounts/request-auth/quota-failure',
    ]);
    expect(bodies[0]).toEqual({ purpose });
    expect(JSON.stringify(bodies)).not.toContain('forceRefresh');
    expect(JSON.stringify(bodies)).not.toContain('"retry"');
    expect(bodies[1]).toMatchObject({
      normalizedFailure: evidence,
    });
    expect(bodies[2]).toMatchObject({
      normalizedFailure: {
        class: 'quota',
        evidence: {
          limitCategory: 'rate_limit',
          quotaScope: 'unknown',
          evidenceSource: { kind: 'structured' },
        },
      },
    });
  });

  it('rejects unpinned terminal provenance before crossing the private transport', async () => {
    await configureFiles();
    const fetchRequestAuth = vi.fn();
    globalThis.fetch = fetchRequestAuth as typeof fetch;
    const client = await loadGeneratedClient();
    const credentialContext = {
      account: {
        service: {
          pluginId: 'happier.connected-account.test',
          localId: 'subscription',
        },
        accountId: 'work',
      },
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
      failingAccessTokenFingerprint: `sha256:${'a'.repeat(64)}`,
    };

    await expect(client.reportConnectedAccountQuotaFailure({
      credentialContext,
      normalizedFailure: {
        class: 'quota',
        evidence: {
          limitCategory: 'capacity',
          quotaScope: 'unknown',
          evidenceSource: {
            kind: 'pinnedProviderTerminal',
            producer: 'pi',
            producerVersion: '0.83.0',
            provider: 'anthropic',
            signatureId: 'anthropic-overloaded-error-v1',
          },
        },
      },
    })).rejects.toThrow('happier_request_auth_schema_invalid');
    expect(fetchRequestAuth).not.toHaveBeenCalled();
  });

  it('forwards cancellation and maps typed private transport failures', async () => {
    await configureFiles();
    globalThis.fetch = vi.fn(async (_url, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;
    const client = await loadGeneratedClient();
    const controller = new AbortController();
    const lookup = client.lookupConnectedAccountRequestAuth({ purpose, signal: controller.signal });
    controller.abort(new Error('cancelled'));
    await expect(lookup).rejects.toThrow('cancelled');

    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: { code: 'request_auth_not_active' },
    }), { status: 409, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    await expect(client.lookupConnectedAccountRequestAuth({ purpose }))
      .rejects.toMatchObject({ code: 'request_auth_not_active', status: 409 });
  });

  it('fails typed and closed when an older daemon has no private request-auth route', async () => {
    await configureFiles();
    const fetchRequestAuth = vi.fn(async (_input: string | URL | Request) => new Response('Not Found', {
      status: 404,
      headers: { 'content-type': 'text/plain' },
    }));
    globalThis.fetch = fetchRequestAuth as typeof fetch;
    const client = await loadGeneratedClient();

    await expect(client.lookupConnectedAccountRequestAuth({ purpose }))
      .rejects.toMatchObject({
        name: 'ConnectedAccountRequestAuthTransportError',
        code: 'happier_request_auth_status_404',
        status: 404,
      });
    expect(fetchRequestAuth).toHaveBeenCalledOnce();
    expect(new URL(String(fetchRequestAuth.mock.calls[0]?.[0])).pathname)
      .toBe('/connected-accounts/request-auth/lookup');
  });

  it.each([
    {
      label: 'success',
      status: 200,
      envelope: {
        ok: true,
        value: {
          accessToken: 'oversized',
          credentialContext: {
            account: {
              service: {
                pluginId: 'happier.connected-account.test',
                localId: 'subscription',
              },
              accountId: 'work',
            },
            credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
          },
        },
      },
      expected: {
        code: 'happier_request_auth_response_too_large',
        status: 200,
      },
    },
    {
      label: 'error',
      status: 409,
      envelope: {
        ok: false,
        error: { code: 'request_auth_not_active' },
      },
      expected: {
        code: 'happier_request_auth_response_too_large',
        status: 409,
      },
    },
    {
      label: 'unauthorized',
      status: 401,
      envelope: {
        ok: false,
        error: { code: 'request_auth_unauthorized' },
      },
      expected: {
        code: 'request_auth_unavailable',
        status: 503,
      },
    },
  ])('bounds an oversized $label response while preserving 401 unavailability', async ({
    status,
    envelope,
    expected,
  }) => {
    await configureFiles();
    const body = JSON.stringify(envelope).padEnd(requestAuthResponseMaxBytes * 2, ' ');
    const streamed = createChunkedResponse(body, status);
    const fetchRequestAuth = vi.fn(async () => streamed.response);
    globalThis.fetch = fetchRequestAuth as typeof fetch;
    const client = await loadGeneratedClient();

    await expect(client.lookupConnectedAccountRequestAuth({ purpose }))
      .rejects.toMatchObject({
        name: 'ConnectedAccountRequestAuthTransportError',
        ...expected,
      });
    expect(fetchRequestAuth).toHaveBeenCalledOnce();
    expect(streamed.producedBytes()).toBeLessThan(new TextEncoder().encode(body).byteLength);
    expect(streamed.wasCancelled()).toBe(true);
    expect(streamed.response.body?.locked).toBe(false);
  });

  it('releases the response stream lock after a bounded read failure', async () => {
    await configureFiles();
    let pullCount = 0;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        if (pullCount === 1) {
          controller.enqueue(new TextEncoder().encode('{"ok":'));
          return;
        }
        controller.error(new Error('private response stream failed'));
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const fetchRequestAuth = vi.fn(async () => response);
    globalThis.fetch = fetchRequestAuth as typeof fetch;
    const client = await loadGeneratedClient();

    await expect(client.lookupConnectedAccountRequestAuth({ purpose }))
      .rejects.toMatchObject({
        name: 'ConnectedAccountRequestAuthTransportError',
        code: 'happier_request_auth_response_read_failed',
        status: 200,
      });
    expect(fetchRequestAuth).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it('accepts a valid response at the exact 256 KiB boundary', async () => {
    await configureFiles();
    const envelope = {
      ok: true,
      value: {
        accessToken: 'boundary',
        credentialContext: {
          account: {
            service: {
              pluginId: 'happier.connected-account.test',
              localId: 'subscription',
            },
            accountId: 'work',
          },
          credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        },
      },
    };
    const body = JSON.stringify(envelope).padEnd(requestAuthResponseMaxBytes, ' ');
    globalThis.fetch = vi.fn(async () => new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    const client = await loadGeneratedClient();

    await expect(client.lookupConnectedAccountRequestAuth({ purpose }))
      .resolves.toMatchObject({ accessToken: 'boundary' });
  });

  it('reclassifies an atomically replaced endpoint/capability tuple after 401 without resending', async () => {
    const { capability } = await configureFiles();
    const replacementCapability = randomBytes(32).toString('base64url');
    const replacementPort = 43211;
    let publicationTriggered = false;
    generatedReadHookGlobal.__happierRequestAuthAfterRead = (path) => {
      if (publicationTriggered || path !== capability.path) return;
      publicationTriggered = true;
      writeTestCapabilityFileSync(
        capability.path,
        'run-1',
        replacementCapability,
        replacementPort,
      );
    };
    const observed: Array<Readonly<{ port: number; capability: string }>> = [];
    const fetchRequestAuth = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      observed.push({
        port: Number(new URL(String(input)).port),
        capability: String(
          (init?.headers as Record<string, string>)[
            CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_HEADER
          ],
        ),
      });
      return new Response(JSON.stringify({
        ok: false,
        error: { code: 'request_auth_unauthorized' },
      }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    });
    globalThis.fetch = fetchRequestAuth as typeof fetch;
    const client = await loadGeneratedClient();

    await expect(client.lookupConnectedAccountRequestAuth({ purpose }))
      .rejects.toMatchObject({
        name: 'ConnectedAccountRequestAuthTransportError',
        code: 'request_auth_unavailable',
        status: 503,
      });
    expect(observed).toEqual([{
      port: capability.document.httpPort,
      capability: capability.document.capability,
    }]);
    expect(fetchRequestAuth).toHaveBeenCalledOnce();
    expect(readFileSyncNative(capability.path, 'utf8')).toContain(replacementCapability);
  });

  it('reclassifies 401 when the capability becomes unreadable without resending or rereading', async () => {
    const { capability } = await configureFiles();
    const post401Reads: string[] = [];
    let responseStarted = false;
    generatedReadHookGlobal.__happierRequestAuthAfterRead = (path) => {
      if (responseStarted) post401Reads.push(path);
    };
    const fetchRequestAuth = vi.fn(async () => {
      responseStarted = true;
      writeFileSync(capability.path, '{', {
        encoding: 'utf8',
        mode: 0o600,
      });
      return new Response(JSON.stringify({
        ok: false,
        error: { code: 'request_auth_unauthorized' },
      }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    });
    globalThis.fetch = fetchRequestAuth as typeof fetch;
    const client = await loadGeneratedClient();

    await expect(client.lookupConnectedAccountRequestAuth({ purpose }))
      .rejects.toMatchObject({
        name: 'ConnectedAccountRequestAuthTransportError',
        code: 'request_auth_unavailable',
        status: 503,
      });
    expect(post401Reads).toEqual([]);
    expect(fetchRequestAuth).toHaveBeenCalledOnce();
  });

  it('reclassifies a stable 401 without resending and lets the next explicit call use the settled replacement tuple', async () => {
    const { capability } = await configureFiles();
    const replacementCapability = randomBytes(32).toString('base64url');
    const replacementPort = 43212;
    const observed: Array<Readonly<{ port: number; capability: string }>> = [];
    const fetchRequestAuth = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const tuple = {
        port: Number(new URL(String(input)).port),
        capability: String(
          (init?.headers as Record<string, string>)[
            CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_HEADER
          ],
        ),
      };
      observed.push(tuple);
      if (tuple.capability === replacementCapability && tuple.port === replacementPort) {
        return new Response(JSON.stringify({
          ok: true,
          value: {
            accessToken: 'replacement-lease',
            credentialContext: {
              account: {
                service: {
                  pluginId: 'happier.connected-account.test',
                  localId: 'subscription',
                },
                accountId: 'work',
              },
              credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
            },
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        ok: false,
        error: { code: 'request_auth_unauthorized' },
      }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    });
    globalThis.fetch = fetchRequestAuth as typeof fetch;
    const client = await loadGeneratedClient();

    await expect(client.lookupConnectedAccountRequestAuth({ purpose }))
      .rejects.toMatchObject({
        code: 'request_auth_unavailable',
        status: 503,
      });
    expect(fetchRequestAuth).toHaveBeenCalledOnce();

    writeTestCapabilityFileSync(
      capability.path,
      'run-1',
      replacementCapability,
      replacementPort,
    );
    await expect(client.lookupConnectedAccountRequestAuth({ purpose }))
      .resolves.toMatchObject({ accessToken: 'replacement-lease' });
    expect(observed).toEqual([
      { port: 43210, capability: capability.document.capability },
      { port: replacementPort, capability: replacementCapability },
    ]);
    expect(fetchRequestAuth).toHaveBeenCalledTimes(2);
  });
});
