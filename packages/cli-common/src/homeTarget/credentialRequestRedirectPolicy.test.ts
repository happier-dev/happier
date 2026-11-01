import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { fetchWithCredentialRedirectRefusal, resolveCredentialRequestRedirect } from './credentialRequestRedirectPolicy.js';

describe('credential redirect policy through real HTTP', () => {
  it('preserves the global fetch receiver when using the default transport', async () => {
    vi.stubGlobal('fetch', async function (this: unknown) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return new Response('ok');
    });
    try {
      const response = await fetchWithCredentialRedirectRefusal('https://home.test/ordinary');
      expect(await response.text()).toBe('ok');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the browser opaque-redirect exception closed without inspecting an unavailable destination', async () => {
    // Browser network responses expose these readonly fields; constructors cannot create that response type.
    const opaque = new Response(null);
    Object.defineProperties(opaque, { status: { value: 0 }, type: { value: 'opaqueredirect' } });
    await expect(fetchWithCredentialRedirectRefusal('https://home.test/redirect',
      { headers: { Authorization: 'Bearer fixture' } }, async () => opaque))
      .rejects.toMatchObject({ code: 'credential_request_redirect_refused', retryable: false, status: 0 });
  });

  it('keeps same-origin credentials and replayable bodies, strips them cross-origin, and preserves public redirects', async () => {
    const received: { authorization?: string; body: string }[] = [];
    let privateHeaderInitiallyPresent = false;
    let privateHeaderForwarded = false;
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      if (request.url?.startsWith('/redirect/')) {
        privateHeaderInitiallyPresent ||= request.headers['x-api-key'] === 'fixture-private-key';
        const port = (server.address() as { port: number }).port;
        const [, , status, origin] = request.url.split('/');
        response.writeHead(Number(status), { location: `http://${origin === 'same' ? '127.0.0.1' : '127.0.0.2'}:${port}/result` }).end();
      } else {
        privateHeaderForwarded ||= Boolean(request.headers['x-api-key']);
        received.push({ authorization: request.headers.authorization, body });
        response.end('ok');
      }
    });
    await new Promise<void>(resolve => server.listen(0, '0.0.0.0', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    const origin = `http://127.0.0.1:${address.port}`;
    const init = { method: 'POST', headers: { Authorization: 'Bearer fixture' }, body: 'fixture-body' };
    try {
      await (await fetchWithCredentialRedirectRefusal(`${origin}/redirect/307/same`, init)).text();
      await (await fetchWithCredentialRedirectRefusal(new Request(`${origin}/redirect/307/same`, init))).text();
      await (await fetchWithCredentialRedirectRefusal(`${origin}/redirect/302/cross`, init)).text();
      for (const status of [307, 308]) {
        await expect(fetchWithCredentialRedirectRefusal(`${origin}/redirect/${status}/cross`, init))
          .rejects.toMatchObject({ code: 'credential_request_redirect_refused', retryable: false, status });
      }
      // Fetch keeps PUT bodies on301; it must not create another secret-replay path.
      await expect(fetchWithCredentialRedirectRefusal(`${origin}/redirect/301/cross`, { ...init, method: 'PUT' }))
        .rejects.toMatchObject({ code: 'credential_request_redirect_refused', retryable: false, status: 301 });
      await (await fetchWithCredentialRedirectRefusal(`${origin}/redirect/307/cross`)).text();
      await (await fetchWithCredentialRedirectRefusal(`${origin}/redirect/307/cross`,
        { headers: { 'X-Api-Key': 'fixture-private-key' } }, globalThis.fetch, new Set(['x-api-key']))).text();
      expect(received).toEqual([
        { authorization: 'Bearer fixture', body: 'fixture-body' },
        { authorization: 'Bearer fixture', body: 'fixture-body' },
        { authorization: undefined, body: '' },
        { authorization: undefined, body: '' },
        { authorization: undefined, body: '' },
      ]);
      expect(privateHeaderInitiallyPresent).toBe(true);
      expect(privateHeaderForwarded).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('drops a host-filled private header permanently after leaving its origin', () => {
    const first = resolveCredentialRequestRedirect({ status: 307, requestUrl: 'https://home.test/start',
      location: 'https://other.test/result', method: 'GET', hasSecretBody: false,
      headers: { Authorization: 'Bearer fixture', 'X-Api-Key': 'fixture-key', Accept: 'application/json' },
      privateCredentialHeaderNames: new Set(['x-api-key']) });
    expect(first?.headers).toEqual({ Accept: 'application/json' });
    const returning = resolveCredentialRequestRedirect({ status: 302, requestUrl: first!.url,
      location: 'https://home.test/return', method: first!.method, headers: first!.headers, hasSecretBody: false });
    expect(returning?.headers).toEqual({ Accept: 'application/json' });
  });
});
