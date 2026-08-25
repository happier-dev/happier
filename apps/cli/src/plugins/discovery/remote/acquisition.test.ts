import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  openRemoteAcquisition,
  type RemoteAcquisitionAddressResolver,
  type RemoteAcquisitionDestinationPolicy,
} from './acquisition';

const ARCHIVE_POLICY: RemoteAcquisitionDestinationPolicy = Object.freeze({
  scheme: 'httpOrHttps',
  redirects: 'anyAssessedOrigin',
  privateNetwork: 'followCallerDestination',
});

const INDEX_POLICY: RemoteAcquisitionDestinationPolicy = Object.freeze({
  scheme: 'https',
  redirects: 'sameOrigin',
  privateNetwork: 'refuse',
});

/**
 * DNS is the one system boundary this owner touches. Every fixture host is
 * public unless a case says otherwise, so admission is decided by the resolved
 * addresses rather than by how a hostname is spelled.
 */
function resolverFor(
  answersByHostname: Readonly<Record<string, readonly string[]>>,
): RemoteAcquisitionAddressResolver {
  return async (hostname) => {
    const answers = answersByHostname[hostname] ?? ['93.184.216.34'];
    return answers.map((address) => ({
      address,
      family: address.includes(':') ? 6 as const : 4 as const,
    }));
  };
}

const servers: Server[] = [];

async function startLoopbackServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

describe('openRemoteAcquisition destination policy', () => {
  it('refuses a public archive that redirects into loopback before the hop is fetched', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => (
      String(url) === 'https://cdn.example.test/plugin.tgz'
        ? new Response(null, {
            status: 302,
            headers: { location: 'http://metadata.example.test/latest/meta-data/' },
          })
        : new Response('secret', { status: 200 })
    ));

    await expect(openRemoteAcquisition({
      url: 'https://cdn.example.test/plugin.tgz',
      headers: { accept: 'application/octet-stream' },
      policy: ARCHIVE_POLICY,
      timeoutMs: 5_000,
      errorLabel: 'Remote plugin archive',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveAddresses: resolverFor({
        'cdn.example.test': ['93.184.216.34'],
        'metadata.example.test': ['169.254.169.254'],
      }),
    })).rejects.toThrow(/private, local, reserved, or invalid address/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('admits a cross-origin redirect between assessed public hops', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => (
      String(url) === 'https://releases.example.test/plugin.tgz'
        ? new Response(null, {
            status: 302,
            headers: { location: 'https://objects.example.test/signed/plugin.tgz' },
          })
        : new Response('archive-bytes', { status: 200 })
    ));

    const opened = await openRemoteAcquisition({
      url: 'https://releases.example.test/plugin.tgz',
      headers: { accept: 'application/octet-stream' },
      policy: ARCHIVE_POLICY,
      timeoutMs: 5_000,
      errorLabel: 'Remote plugin archive',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveAddresses: resolverFor({}),
    });

    await expect(opened.response.text()).resolves.toBe('archive-bytes');
    await opened.dispose();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('keeps a caller-named private destination reachable for the whole chain', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => (
      String(url) === 'http://dev-box.example.test/plugin.tgz'
        ? new Response(null, {
            status: 302,
            headers: { location: 'http://dev-box.example.test/artifacts/plugin.tgz' },
          })
        : new Response('archive-bytes', { status: 200 })
    ));

    const opened = await openRemoteAcquisition({
      url: 'http://dev-box.example.test/plugin.tgz',
      headers: { accept: 'application/octet-stream' },
      policy: ARCHIVE_POLICY,
      timeoutMs: 5_000,
      errorLabel: 'Remote plugin archive',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveAddresses: resolverFor({ 'dev-box.example.test': ['192.168.1.20'] }),
    });

    await expect(opened.response.text()).resolves.toBe('archive-bytes');
    await opened.dispose();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('bounds a redirect loop instead of following it forever', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'https://cdn.example.test/next' },
    }));

    await expect(openRemoteAcquisition({
      url: 'https://cdn.example.test/plugin.tgz',
      headers: {},
      policy: ARCHIVE_POLICY,
      timeoutMs: 5_000,
      errorLabel: 'Remote plugin archive',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveAddresses: resolverFor({}),
    })).rejects.toThrow(/exceeded 5 redirects/);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it('refuses a URL that carries embedded credentials', async () => {
    const fetchImpl = vi.fn();
    await expect(openRemoteAcquisition({
      url: 'https://user:secret@cdn.example.test/plugin.tgz',
      headers: {},
      policy: ARCHIVE_POLICY,
      timeoutMs: 5_000,
      errorLabel: 'Remote plugin archive',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveAddresses: resolverFor({}),
    })).rejects.toThrow(/credential-free/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses every private destination under the index-source policy, including the caller hop', async () => {
    const fetchImpl = vi.fn();
    await expect(openRemoteAcquisition({
      url: 'https://index.example.test/catalog.json',
      headers: {},
      policy: INDEX_POLICY,
      timeoutMs: 5_000,
      errorLabel: 'Marketplace index source',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveAddresses: resolverFor({ 'index.example.test': ['10.0.0.4'] }),
    })).rejects.toThrow(/private, local, reserved, or invalid address/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('connects to the addresses it assessed rather than re-resolving the name at connect time', async () => {
    // The hostname has no DNS record at all: only the pinned lookup, built from
    // the addresses this owner classified, can complete the connection. If the
    // transport resolved the name itself — the window a rebinding attack needs —
    // there would be nothing to resolve and the request would fail.
    const port = await startLoopbackServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end('pinned-archive-bytes');
    });
    const resolveAddresses = vi.fn(async () => [{ address: '127.0.0.1', family: 4 as const }]);

    const opened = await openRemoteAcquisition({
      url: `http://archive.pinning.invalid:${port}/plugin.tgz`,
      headers: { accept: 'application/octet-stream' },
      policy: ARCHIVE_POLICY,
      timeoutMs: 5_000,
      errorLabel: 'Remote plugin archive',
      resolveAddresses,
    });

    try {
      await expect(opened.response.text()).resolves.toBe('pinned-archive-bytes');
    } finally {
      await opened.dispose();
    }
    expect(resolveAddresses).toHaveBeenCalledWith('archive.pinning.invalid');
  });

  it('downloads a real loopback archive through the pinned transport it owns', async () => {
    const port = await startLoopbackServer((request, response) => {
      if (request.url === '/plugin.tgz') {
        response.writeHead(302, { location: `http://127.0.0.1:${port}/artifacts/plugin.tgz` });
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end('loopback-archive-bytes');
    });

    const opened = await openRemoteAcquisition({
      url: `http://127.0.0.1:${port}/plugin.tgz`,
      headers: { accept: 'application/octet-stream' },
      policy: ARCHIVE_POLICY,
      timeoutMs: 5_000,
      errorLabel: 'Remote plugin archive',
    });

    try {
      expect(opened.response.status).toBe(200);
      await expect(opened.response.text()).resolves.toBe('loopback-archive-bytes');
    } finally {
      await opened.dispose();
    }
  });
});
