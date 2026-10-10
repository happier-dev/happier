import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { createEnvKeyScope } from '@/testkit/env/envScope';

import { buildDaemonControlHttpHeaders, daemonPost } from './controlHttp';
import { deriveConnectedServiceRunMaterializeToken } from './connectedServices/runs/capabilityToken';

let envScope = createEnvKeyScope(['HAPPIER_TOKEN', 'HAPPIER_DAEMON_HTTP_TIMEOUT']);

afterEach(() => {
  envScope.restore();
  envScope = createEnvKeyScope(['HAPPIER_TOKEN', 'HAPPIER_DAEMON_HTTP_TIMEOUT']);
});

describe('daemon control HTTP authentication', () => {
  it('waits for catalog preparation beyond the generic control timeout while preserving caller cancellation', async () => {
    envScope.patch({ HAPPIER_DAEMON_HTTP_TIMEOUT: '100' });
    let releaseResponse!: () => void;
    let requestStarted!: () => void;
    let started = new Promise<void>((resolve) => { requestStarted = resolve; });
    const server = createServer((request, response) => {
      request.resume();
      releaseResponse = () => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ kind: 'available', plugins: [], tools: [] }));
      };
      requestStarted();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const target = { pid: process.pid, httpPort: address.port, controlToken: 'control-token' };
    try {
      const catalog = daemonPost('/plugins/catalog/read', {}, { target });
      await started;
      // Cross the actual generic-control boundary; the catalog owner must
      // continue waiting for this same request rather than retrying it.
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      releaseResponse();
      await expect(catalog).resolves.toEqual({ kind: 'available', plugins: [], tools: [] });

      started = new Promise<void>((resolve) => { requestStarted = resolve; });
      const cancellation = new AbortController();
      const cancelledCatalog = daemonPost('/plugins/catalog/read', {}, { target, signal: cancellation.signal });
      await started;
      cancellation.abort();
      await expect(cancelledCatalog).resolves.toMatchObject({ errorCode: 'cancelled' });

      started = new Promise<void>((resolve) => { requestStarted = resolve; });
      const boundedCatalog = daemonPost('/plugins/catalog/read', {}, { target, timeoutMs: 100 });
      await started;
      await expect(boundedCatalog).resolves.toMatchObject({ errorCode: 'timeout' });
    } finally {
      releaseResponse?.();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('keeps an ambient API Token out of daemon-control headers', () => {
    envScope.patch({ HAPPIER_TOKEN: 'hap_v1_automation_token_secret' });

    expect(buildDaemonControlHttpHeaders('daemon-control-token')).toEqual({
      'Content-Type': 'application/json',
      Connection: 'close',
      'x-happier-daemon-token': 'daemon-control-token',
    });
  });

  it('preserves structured HTTP refusals and scopes run-materialization authority', async () => {
    const observedTokens: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      observedTokens.push(request.headers['x-happier-daemon-token'] as string | undefined);
      response.statusCode = 409;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ success: false, requiresUserApproval: true, errorCode: 'approval_required' }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const target = { pid: process.pid, httpPort: address.port, controlToken: 'control-token' };
    try {
      const expected = { success: false, requiresUserApproval: true, errorCode: 'approval_required' };
      await expect(daemonPost('/existing-control', {}, { target })).resolves.toEqual(expected);
      await expect(daemonPost('/connected-service-run/materialize', {}, { target, authScope: 'connected-service-run-materialize' })).resolves.toEqual(expected);
      expect(observedTokens).toEqual(['control-token', deriveConnectedServiceRunMaterializeToken('control-token')]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
