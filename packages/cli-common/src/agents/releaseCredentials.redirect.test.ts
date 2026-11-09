import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';

import { fetchGitHubLatestRelease, fetchGitHubReleaseByTag } from '@happier-dev/release-runtime';

describe('credential-bearing GitHub release requests', () => {
  for (const channel of ['fetch', 'node'] as const) {
    it.each([
      { status: 307, crossOrigin: false },
      { status: 302, crossOrigin: true },
      { status: 307, crossOrigin: true },
    ])(`${channel} follows bodyless redirects with exact-origin credentials ($status, cross=$crossOrigin)`, async ({ status, crossOrigin }) => {
      let initialRequests = 0;
      let initialCredentials = false;
      let secondHopRequests = 0;
      let secondHopCredentials = false;
      let secondHopBody = false;
      const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        if (request.url?.startsWith('/redirected')) {
          secondHopRequests += 1;
          secondHopCredentials ||= Boolean(request.headers.authorization);
          secondHopBody ||= Buffer.concat(chunks).length > 0;
          response.writeHead(200, { 'content-type': 'application/json' }).end('{"tag_name":"cli-stable","assets":[]}');
          return;
        }
        initialRequests += 1;
        initialCredentials ||= Boolean(request.headers.authorization);
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Expected an HTTP listener');
        response.writeHead(status, { location: `http://${crossOrigin ? '127.0.0.2' : '127.0.0.1'}:${address.port}/redirected?private=hidden` }).end();
      });
      await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
      try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Expected an HTTP listener');
        const origin = `http://127.0.0.1:${address.port}`;
        const release = await fetchGitHubReleaseByTag({ githubRepo: 'happier-dev/happier',
          githubToken: 'synthetic-test-credential', tag: 'cli-stable', apiBaseUrl: origin,
          ...(channel === 'fetch' ? { fetchImpl: fetch } : {}) });
        expect(release).toEqual({ tag_name: 'cli-stable', assets: [] });
        expect(initialRequests).toBe(1);
        expect(initialCredentials).toBe(true);
        expect({ secondHopRequests, secondHopCredentials, secondHopBody }).toEqual({
          secondHopRequests: 1, secondHopCredentials: !crossOrigin, secondHopBody: false,
        });
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    });

    it(`${channel} accepts a successful credential-bearing metadata response`, async () => {
      let requests = 0;
      let credentialPresent = false;
      const server = createServer((request, response) => {
        requests += 1;
        credentialPresent = Boolean(request.headers.authorization);
        response.writeHead(200, { 'content-type': 'application/json' }).end('{"tag_name":"cli-stable","assets":[]}');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Expected an HTTP listener');
        const origin = `http://127.0.0.1:${address.port}`;
        const fetchImpl: typeof fetch = async (_url, init) => await fetch(`${origin}/release`, init);
        const input = { githubRepo: 'happier-dev/happier', githubToken: 'synthetic-test-credential' };
        const release = channel === 'fetch'
          ? await fetchGitHubLatestRelease({ ...input, fetchImpl })
          : await fetchGitHubReleaseByTag({ ...input, tag: 'cli-stable', apiBaseUrl: origin });
        expect(release).toEqual({ tag_name: 'cli-stable', assets: [] });
        expect(requests).toBe(1);
        expect(credentialPresent).toBe(true);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    });

    it(`${channel} keeps public credential-free redirects usable`, async () => {
      let requests = 0;
      let credentialPresent = false;
      const server = createServer((request, response) => {
        requests += 1;
        credentialPresent ||= Boolean(request.headers.authorization);
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Expected an HTTP listener');
        if (request.url?.startsWith('/repos/') || request.url === '/release') {
          response.writeHead(302, { location: `http://127.0.0.2:${address.port}/public-asset` }).end();
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' }).end('{"tag_name":"cli-stable","assets":[]}');
      });
      await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
      try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Expected an HTTP listener');
        const origin = `http://127.0.0.1:${address.port}`;
        const release = await fetchGitHubReleaseByTag({ githubRepo: 'happier-dev/happier',
          tag: 'cli-stable', apiBaseUrl: origin, ...(channel === 'fetch' ? { fetchImpl: fetch } : {}) });
        expect(release).toEqual({ tag_name: 'cli-stable', assets: [] });
        expect(requests).toBe(2);
        expect(credentialPresent).toBe(false);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    });
  }
});
