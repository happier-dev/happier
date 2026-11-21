import { createServer } from 'node:http';
import { once } from 'node:events';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import { createProviderConnectionHttpTransport } from './providerConnectionHttpTransport';
import { readProviderBrokerResponseBody } from './providerBroker.testkit';

async function fixture(protocol: 'openai-responses' | 'anthropic', address = '127.0.0.1', upstreamStatus = 200) {
  const requests: { path: string; headers: Readonly<Record<string, unknown>>; body: string }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ path: request.url!, headers: request.headers, body: Buffer.concat(chunks).toString() });
    if (request.url?.includes('redirect=yes')) {
      response.writeHead(307, { location: '/do-not-follow' }).end();
      return;
    }
    response.writeHead(upstreamStatus, { 'content-type': 'text/event-stream', 'x-echo': 'source-secret', 'set-cookie': 'private=1' });
    response.write('data: source-');
    if (!request.url?.includes('hold=yes')) setImmediate(() => response.end('secret\n\n'));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const listenAddress = server.address();
  if (!listenAddress || typeof listenAddress === 'string') throw new Error('Expected TCP upstream');
  const redaction = createProviderRedactionLease({ values: ['source-secret', 'companion-secret'] });
  const close = vi.fn(redaction.close);
  const onResponse = vi.fn(async (_status: number, _signal: AbortSignal) => {});
  const abort = new AbortController();
  const projection = await createProviderConnectionHttpTransport().open({
    applicationEndpointTemplateId: 'downstream',
    applicationBaseUrl: protocol === 'anthropic' ? 'http://127.0.0.1' : 'http://127.0.0.1/v1',
    endpoint: {
      normalizedUrl: `http://admitted.provider.invalid:${listenAddress.port}/gateway`,
      resolvedAddresses: [address],
      publicHeaders: { 'x-configured': 'policy' },
    },
    signal: abort.signal,
    isCurrent: async () => true,
    acquireRequestCredential: async () => ({
      credential: { kind: 'httpHeader', name: 'authorization', value: 'Bearer source-secret',
        additionalCredentials: [{ kind: 'httpHeader', name: 'x-companion', value: 'companion-secret' }] },
      queryParameters: { teamId: 'configured-team' },
      redact: redaction.redact,
      containsSensitiveValue: redaction.containsSensitiveValue,
      createStreamingSanitizer: redaction.createStreamingSanitizer,
      close,
      onResponse,
    }),
  });
  if (!projection) throw new Error('Expected opened Provider transport');
  return { access: projection.access, requests, close, abort, onResponse };
}

describe('Provider Connection pinned HTTP transport', () => {
  it('makes one dispatch to the admitted address and replaces only the configured query parameter', async () => {
    const { access, requests, close } = await fixture('openai-responses');
    const response = await access.request({
      pathAndQuery: '/v1/responses?teamId=untrusted&trace=a&teamId=also-untrusted&trace=b',
      method: 'POST',
      headers: { authorization: 'Bearer caller', 'x-companion': 'caller companion' },
      body: new TextEncoder().encode('{"model":"upstream-model"}'),
    });
    expect(response.status).toBe(200);
    expect(response.headers).toEqual({ 'content-type': 'text/event-stream', date: expect.any(String) });
    const body = new TextDecoder().decode(await readProviderBrokerResponseBody(response.body));
    expect(body).toContain('data: ');
    expect(body).not.toContain('source-secret');
    expect(requests).toHaveLength(1);
    const target = new URL(requests[0]!.path, 'https://example.test');
    expect(target.pathname).toBe('/gateway/responses');
    expect(target.searchParams.getAll('teamId')).toEqual(['configured-team']);
    expect(target.searchParams.getAll('trace')).toEqual(['a', 'b']);
    expect(requests[0]).toMatchObject({ headers: {
      host: expect.stringMatching(/^admitted\.provider\.invalid:/),
      authorization: 'Bearer source-secret',
      'x-companion': 'companion-secret',
      'x-configured': 'policy',
      'accept-encoding': 'identity',
    }, body: '{"model":"upstream-model"}' });
    expect(close).toHaveBeenCalledOnce();
  });

  it('keeps the full Messages path and refuses a redirect without another dispatch', async () => {
    const { access, requests, close } = await fixture('anthropic');
    const response = await access.request({ method: 'POST', pathAndQuery: '/v1/messages?redirect=yes' });
    expect(response.status).toBe(502);
    expect(requests.map(request => new URL(request.path, 'https://example.test').pathname)).toEqual(['/gateway/v1/messages']);
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([401, 403])('reports upstream HTTP %i to the acquired lease without replaying the request', async status => {
    const { access, requests, close, onResponse } = await fixture('openai-responses', '127.0.0.1', status);
    const response = await access.request({ method: 'POST', pathAndQuery: '/v1/responses' });
    expect(response.status).toBe(status);
    expect(onResponse).toHaveBeenCalledExactlyOnceWith(status, expect.any(AbortSignal));
    const body = new TextDecoder().decode(await readProviderBrokerResponseBody(response.body));
    expect(body).toContain('data: ');
    expect(body).not.toContain('source-secret');
    expect(close).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(1);
  });

  it('does not fall back when the admitted address cannot reach the upstream', async () => {
    const { access, requests, close } = await fixture('openai-responses', '127.0.0.2');
    const response = await access.request({ method: 'POST', pathAndQuery: '/v1/responses' });
    expect(response.status).toBe(502);
    expect(requests).toHaveLength(0);
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes the held redaction lease when its caller cancels a live stream', async () => {
    const { access, abort, requests, close } = await fixture('openai-responses');
    const response = await access.request({ method: 'POST', pathAndQuery: '/v1/responses?hold=yes' });
    expect(response.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(close).not.toHaveBeenCalled();
    abort.abort();
    expect(close).toHaveBeenCalledOnce();
    await response.body?.cancel();
  });
});
