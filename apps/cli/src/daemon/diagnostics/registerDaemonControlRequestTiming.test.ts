import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { registerDaemonControlRequestTiming } from './registerDaemonControlRequestTiming';

describe('registerDaemonControlRequestTiming', () => {
  it('retains the first safe exception cause with the failed request without logging private content', async () => {
    const warn = vi.fn();
    const app = fastify({ logger: false });
    registerDaemonControlRequestTiming(app, { debug: vi.fn(), warn });
    app.post('/ssh-tunnels/ensure', async () => {
      const error = Object.assign(new Error('never-log-exception'), { code: 'ENOSPC' });
      error.stack = 'Error: never-log-exception\n    at write (/repo/apps/cli/src/daemon/ssh/tunnels/registry.ts:55:13)';
      throw error;
    });
    try {
      const response = await app.inject({
        method: 'POST', url: '/ssh-tunnels/ensure?token=never-log-query',
        headers: { authorization: 'Bearer never-log-header' }, payload: { password: 'never-log-body' },
      });
      expect(response.statusCode).toBe(500);
      expect(warn.mock.calls).toEqual([['[CONTROL SERVER] Request completed', expect.objectContaining({
        requestId: expect.any(String),
        route: '/ssh-tunnels/ensure', statusCode: 500,
        errorClass: 'Error', errorCode: 'ENOSPC',
        stackFrames: [{ file: '/repo/apps/cli/src/daemon/ssh/tunnels/registry.ts', line: 55, column: 13 }],
      })]]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('never-log');
    } finally { await app.close(); }
  });

  it('suppresses successful ping floods, keeps failures visible, and leaves probes at debug', async () => {
    const debug = vi.fn();
    const warn = vi.fn();
    const app = fastify({ logger: false });
    registerDaemonControlRequestTiming(app, { debug, warn });
    let statusCode = 200;
    app.post('/ping', async (_request, reply) => reply.code(statusCode).send({ ok: statusCode === 200 }));
    try {
      await app.inject({ method: 'POST', url: '/ping' });
      await app.inject({ method: 'POST', url: '/ping' });
      expect(debug.mock.calls).toEqual([]);
      expect(warn.mock.calls).toEqual([]);
      statusCode = 401;
      await app.inject({ method: 'POST', url: '/ping' });
      expect(warn.mock.calls).toEqual([['[CONTROL SERVER] Request completed', expect.objectContaining({ route: '/ping', statusCode: 401 })]]);
      await app.inject({ method: 'HEAD', url: '/never-log-path?token=never-log-query' });
      expect(debug.mock.calls).toEqual([['[CONTROL SERVER] Request completed', expect.objectContaining({ route: '<unmatched>', method: 'HEAD', statusCode: 404 })]]);
      expect(JSON.stringify([debug.mock.calls, warn.mock.calls])).not.toContain('never-log');
    } finally { await app.close(); }
  });
  it('logs only the registered route template around the real request lifecycle', async () => {
    let nowMs = 100;
    const debug = vi.fn();
    const app = fastify({ logger: false });
    registerDaemonControlRequestTiming(app, {
      nowMs: () => nowMs,
      debug,
    });
    app.post('/session/:sessionId/lifecycle', async () => {
      nowMs = 145;
      return { ok: true, secretResult: 'never-log-result' };
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/session/secret-path-value/lifecycle?token=never-log-query-values',
        headers: { authorization: 'Bearer never-log-header' },
        payload: { secretBody: 'never-log-body' },
      });

      expect(response.statusCode).toBe(200);
      expect(debug.mock.calls).toEqual([
        [
          '[CONTROL SERVER] Request completed',
          {
            requestId: expect.any(String),
            method: 'POST',
            route: '/session/:sessionId/lifecycle',
            statusCode: 200,
            durationMs: 45,
          },
        ],
      ]);
      expect(JSON.stringify(debug.mock.calls)).not.toContain('never-log');
      expect(JSON.stringify(debug.mock.calls)).not.toContain('secret-path-value');
    } finally {
      await app.close();
    }
  });

  it('uses a safe constant for an unmatched route', async () => {
    const debug = vi.fn();
    const app = fastify({ logger: false });
    registerDaemonControlRequestTiming(app, { debug, nowMs: () => 100 });

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/secret-unmatched-path?token=never-log-query-values',
      });

      expect(response.statusCode).toBe(404);
      expect(debug.mock.calls).toEqual([
        [
          '[CONTROL SERVER] Request completed',
          {
            requestId: expect.any(String),
            method: 'GET',
            route: '<unmatched>',
            statusCode: 404,
            durationMs: 0,
          },
        ],
      ]);
      expect(JSON.stringify(debug.mock.calls)).not.toContain('secret-unmatched-path');
    } finally {
      await app.close();
    }
  });
});
