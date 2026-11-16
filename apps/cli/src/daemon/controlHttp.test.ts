import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { runInHostedSessionScope, sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';

import { buildDaemonControlHttpHeaders, daemonPost } from './controlHttp';
import { deriveConnectedServiceRunMaterializeToken } from './connectedServices/runs/capabilityToken';
import { recoverExecutionRunConnectedServiceRuntimeFailure } from './controlClient';
import * as persistence from '@/persistence';

let envScope = createEnvKeyScope(['HAPPIER_TOKEN', 'HAPPIER_DAEMON_HTTP_TIMEOUT']);

afterEach(() => {
  envScope.restore();
  envScope = createEnvKeyScope(['HAPPIER_TOKEN', 'HAPPIER_DAEMON_HTTP_TIMEOUT']);
  vi.restoreAllMocks();
});

describe('daemon control HTTP authentication', () => {
  it('uses each hosted Session control timeout while retaining explicit deadlines and the host fallback', async () => {
    envScope.patch({ HAPPIER_DAEMON_HTTP_TIMEOUT: '3500' });
    const deadlines: Array<{ environment: string | undefined; ms: number }> = [];
    // Observe the clock boundary while the actual loopback transport stays real.
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      deadlines.push({ environment: sessionProcessEnvironment().HAPPIER_DAEMON_HTTP_TIMEOUT, ms });
      return new AbortController().signal;
    });
    const server = createServer((request, response) => {
      request.resume();
      response.end('{}');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const target = { pid: process.pid, httpPort: address.port, controlToken: 'control-token' };
    const observe = async () => {
      await new Promise<void>(resolve => setImmediate(resolve));
      return await Promise.all([
        daemonPost('/session-holder', {}, { target }),
        daemonPost('/spawn-session', {}, { target }),
        daemonPost('/session-holder', {}, { target, timeoutMs: 8800 }),
        daemonPost('/session-holder', {}, { target, timeoutMs: null }),
      ]);
    };
    try {
      const [a, b] = await Promise.all([
        runInHostedSessionScope({ environment: { NODE_ENV: 'test', HAPPIER_DAEMON_HTTP_TIMEOUT: '1300',
          HAPPIER_DAEMON_SPAWN_HTTP_TIMEOUT: '4700' } }, observe),
        runInHostedSessionScope({ environment: { NODE_ENV: 'test', HAPPIER_DAEMON_HTTP_TIMEOUT: '2400' } }, observe),
      ]);
      expect(a).toEqual([{}, {}, {}, {}]);
      expect(b).toEqual([{}, {}, {}, {}]);
      const selected = (environment: string) => deadlines.filter(item => item.environment === environment)
        .map(item => item.ms).sort((left, right) => left - right);
      expect(selected('1300')).toEqual([1300, 4700, 8800]);
      expect(selected('2400')).toEqual([2400, 2400, 8800]);
      await expect(daemonPost('/session-holder', {}, { target })).resolves.toEqual({});
      expect(deadlines.at(-1)).toEqual({ environment: '3500', ms: 3500 });
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('settles cancellation before a held daemon response is released', async () => {
    const opened = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const server = createServer((request, response) => {
      request.resume();
      response.once('close', () => closed.resolve());
      opened.resolve();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const controller = new AbortController();
    try {
      const pending = daemonPost('/held', {}, { timeoutMs: null, signal: controller.signal,
        target: { pid: process.pid, httpPort: address.port, controlToken: 'control-token' } });
      await opened.promise;
      controller.abort(new Error('Command interrupted by SIGINT'));
      expect(await pending).toMatchObject({ errorCode: 'cancelled' });
      await closed.promise;
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('delivers NDJSON progress before final completion on the same HTTP response', async () => {
    let release!: () => void;
    let observedAccept: string | undefined;
    const server = createServer((request, response) => {
      request.resume();
      observedAccept = request.headers.accept;
      response.setHeader('content-type', 'application/x-ndjson');
      response.write('{"phase":"waiting","label":"réessayer"}\n');
      release = () => response.end('{"phase":"finished"}\n');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    try {
      const frames: unknown[] = [];
      let finished = false;
      const pending = daemonPost('/progress', {}, { timeoutMs: null,
        target: { pid: process.pid, httpPort: address.port, controlToken: 'control-token' },
        onJsonLine: frame => { frames.push(frame); },
      }).then(result => { finished = true; return result; });
      await vi.waitFor(() => expect(frames).toEqual([{ phase: 'waiting', label: 'réessayer' }]));
      expect(finished).toBe(false);
      expect(observedAccept).toBe('application/x-ndjson');
      release();
      await expect(pending).resolves.toEqual({ phase: 'finished' });
      expect(frames).toEqual([{ phase: 'waiting', label: 'réessayer' }, { phase: 'finished' }]);
    } finally {
      release?.();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it.each(['malformed_progress', 'invalid_json', 'legacy_json'] as const)('handles %s from the recovery HTTP peer', async mode => {
    const server = createServer((request, response) => {
      request.resume();
      if (mode === 'legacy_json') {
        response.setHeader('content-type', 'application/json');
        response.end('{"status":"continue","input":"Continue","rematerialize":false}');
      } else {
        response.setHeader('content-type', 'application/x-ndjson');
        // A peer cannot promote an unvalidated shape into a waiting fact.
        response.write(mode === 'invalid_json' ? '{not-json}\n'
          : '{"type":"waiting","recovery":{"v":2,"status":"waiting"}}\n');
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    vi.spyOn(persistence, 'readDaemonState').mockResolvedValue({ pid: process.pid,
      httpPort: address.port, controlToken: 'control-token', startedAt: Date.now(), startedWithCliVersion: '0.3.0' });
    try {
      const waiting: unknown[] = [];
      await expect(recoverExecutionRunConnectedServiceRuntimeFailure({ runId: 'run', runnerPid: process.pid,
        activationId: '11111111-1111-4111-8111-111111111111', nativeResumeId: 'native', interruptedOriginId: 'turn', diagnostic: {},
      }, { signal: new AbortController().signal, onRecoveryWaiting: recovery => { waiting.push(recovery); } }))
        .resolves.toEqual(mode === 'legacy_json' ? { status: 'continue', input: 'Continue', rematerialize: false }
          : { status: 'failed', reason: 'runtime_recovery_unavailable' });
      expect(waiting).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it.each([302, 307].flatMap(status => [
    { status, crossOrigin: true },
    { status, crossOrigin: false },
  ]))('scopes daemon authority on HTTP $status (crossOrigin=$crossOrigin)', async ({ status, crossOrigin }) => {
    let initialRequests = 0;
    let initialCredential = false;
    let redirectedRequests = 0;
    let redirectedCredential = false;
    let redirectedBody = false;
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      if (new URL(request.url ?? '/', 'http://localhost').pathname === '/redirected') {
        redirectedRequests += 1;
        redirectedCredential ||= Boolean(request.headers['x-happier-daemon-token']);
        redirectedBody ||= body.length > 0;
        response.end('{}');
      } else {
        initialRequests += 1;
        initialCredential ||= Boolean(request.headers['x-happier-daemon-token']);
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing server address');
        response.writeHead(status, { location: crossOrigin
          ? `http://localhost:${address.port}/redirected?private=hidden`
          : '/redirected?private=hidden' });
        response.end();
      }
    });
    server.listen(0);
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    try {
      const pending = daemonPost('/redirect', { private: 'body' }, {
        target: { pid: process.pid, httpPort: address.port, controlToken: 'control-token' },
      });
      const refusesReplay = crossOrigin && status === 307;
      if (refusesReplay) await expect(pending).resolves.toMatchObject({ errorCode: 'credential_request_redirect_refused', retryable: false });
      else await expect(pending).resolves.toEqual({});
      expect(initialRequests).toBe(1);
      expect(initialCredential).toBe(true);
      expect(redirectedRequests).toBe(refusesReplay ? 0 : 1);
      expect(redirectedCredential).toBe(!crossOrigin);
      expect(redirectedBody).toBe(!crossOrigin && status === 307);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it.each([
    '/stop',
    '/plugins/catalog/read',
    '/session-activity-changed',
    '/connected-service-run/applied-parent-selection',
    '/connected-service-run/generation-current',
  ])('waits for %s beyond the generic control timeout while preserving caller cancellation', async (path) => {
    envScope.patch({ HAPPIER_DAEMON_HTTP_TIMEOUT: '100' });
    const expected = path === '/plugins/catalog/read'
      ? { kind: 'available', plugins: [], tools: [] }
      : path === '/session-activity-changed'
        ? { ok: true }
      : path === '/connected-service-run/generation-current'
        ? { ok: true, current: true }
        : { status: 'unavailable' };
    let releaseResponse!: () => void;
    let requestStarted!: () => void;
    let started = new Promise<void>((resolve) => { requestStarted = resolve; });
    const server = createServer((request, response) => {
      request.resume();
      releaseResponse = () => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(expected));
      };
      requestStarted();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const target = { pid: process.pid, httpPort: address.port, controlToken: 'control-token' };
    try {
      const catalog = daemonPost(path, {}, { target });
      await started;
      // Cross the actual generic-control boundary; the operation owner must
      // continue waiting for this same request rather than retrying it.
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      releaseResponse();
      await expect(catalog).resolves.toEqual(expected);

      started = new Promise<void>((resolve) => { requestStarted = resolve; });
      const cancellation = new AbortController();
      const cancelledCatalog = daemonPost(path, {}, { target, signal: cancellation.signal });
      await started;
      cancellation.abort();
      await expect(cancelledCatalog).resolves.toMatchObject({ errorCode: 'cancelled' });

      started = new Promise<void>((resolve) => { requestStarted = resolve; });
      const boundedCatalog = daemonPost(path, {}, { target, timeoutMs: 100 });
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
