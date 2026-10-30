import { createServer, globalAgent } from 'node:http';
import { connect, type Socket } from 'node:net';

import axios from 'axios';
import { describe, it, expect } from 'vitest';

import { getAxiosProxyOptionsForUrl } from './axiosProxy';
import { getDirectHttpAgents, getHttpsProxyAgent } from './agents';

async function withProxyProbe(check: (probe: {
  targetUrl: string;
  proxyUrl: string;
  authorities: string[];
}) => Promise<void>): Promise<void> {
  const sockets = new Set<Socket>();
  const authorities: string[] = [];
  const target = createServer((_request, response) => response.end('from-target'));
  const proxy = createServer();
  for (const server of [target, proxy]) {
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
  }
  try {
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress === 'string') throw new Error('Expected an IP target address');
    proxy.on('connect', (request, downstream, head) => {
      authorities.push(request.url ?? '');
      const upstream = connect(targetAddress.port, '127.0.0.1', () => {
        downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        upstream.pipe(downstream);
        downstream.pipe(upstream);
      });
      sockets.add(upstream);
      upstream.on('close', () => sockets.delete(upstream));
      upstream.on('error', () => downstream.destroy());
      downstream.on('error', () => upstream.destroy());
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const proxyAddress = proxy.address();
    if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('Expected an IP proxy address');
    await check({
      targetUrl: `http://127.0.0.1:${targetAddress.port}/proxy-probe`,
      proxyUrl: `http://127.0.0.1:${proxyAddress.port}`,
      authorities,
    });
  } finally {
    for (const socket of sockets) socket.destroy();
    await Promise.all([target, proxy].map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })));
  }
}

describe('getAxiosProxyOptionsForUrl', () => {
  it('always disables axios native proxy handling', () => {
    const opts = getAxiosProxyOptionsForUrl({ targetUrl: 'https://example.com', env: { NODE_ENV: 'test' } });
    expect(opts.proxy).toBe(false);
    expect(opts.httpAgent).toBeTruthy();
    expect(opts.httpsAgent).toBeTruthy();
  });

  it('routes traffic through the configured proxy and selects its HTTPS agent', async () => {
    await withProxyProbe(async ({ targetUrl, proxyUrl, authorities }) => {
      const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl };
      const opts = getAxiosProxyOptionsForUrl({ targetUrl, env });
      const httpsOpts = getAxiosProxyOptionsForUrl({ targetUrl: 'https://example.com', env });
      expect(httpsOpts.httpsAgent).toBe(getHttpsProxyAgent(proxyUrl));
      expect(opts.proxy).toBe(false);
      await expect(axios.get(targetUrl, { ...opts, adapter: 'http' })).resolves.toMatchObject({ data: 'from-target' });
      expect(authorities).toEqual([new URL(targetUrl).host]);
    });
  });

  it('uses direct traffic and agents when NO_PROXY bypasses the configured proxy', async () => {
    await withProxyProbe(async ({ targetUrl, proxyUrl, authorities }) => {
      const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, NO_PROXY: '*' };
      const opts = getAxiosProxyOptionsForUrl({ targetUrl, env });
      const httpsOpts = getAxiosProxyOptionsForUrl({ targetUrl: 'https://example.com', env });
      expect(httpsOpts.httpsAgent).toBe(getDirectHttpAgents().httpsAgent);
      expect(opts.proxy).toBe(false);
      await expect(axios.get(targetUrl, { ...opts, adapter: 'http' })).resolves.toMatchObject({ data: 'from-target' });
      expect(authorities).toEqual([]);
    });
  });

  it('reuses one direct connection for 60 sequential requests', async () => {
    let connections = 0;
    let requestsServed = 0;
    const server = createServer((_request, response) => {
      requestsServed += 1;
      response.end('ok');
    });
    server.on('connection', () => { connections += 1; });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected an IP test server address');

    // Node keeps the constructed keep-alive option on the Agent; its type declarations omit that field.
    const nodeGlobalAgent = globalAgent as typeof globalAgent & { keepAlive: boolean };
    const previousGlobalKeepAlive = nodeGlobalAgent.keepAlive;
    nodeGlobalAgent.keepAlive = false;
    const targetUrl = `http://127.0.0.1:${address.port}/idle-probe`;
    const options = getAxiosProxyOptionsForUrl({ targetUrl, env: { NODE_ENV: 'test' } });
    try {
      for (let request = 0; request < 60; request += 1) {
        await axios.get(targetUrl, { ...options, adapter: 'http' });
      }
      expect(requestsServed).toBe(60);
      expect(connections).toBe(1);
    } finally {
      nodeGlobalAgent.keepAlive = previousGlobalKeepAlive;
      const directAgent = options.httpAgent;
      if (directAgent && typeof directAgent === 'object' && 'destroy' in directAgent
        && typeof directAgent.destroy === 'function') directAgent.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

