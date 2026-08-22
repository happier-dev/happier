import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { registerDaemonControlRequestTiming } from './registerDaemonControlRequestTiming';

describe('registerDaemonControlRequestTiming', () => {
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
          '[CONTROL SERVER] Request received',
          {
            requestId: expect.any(String),
            method: 'POST',
            route: '/session/:sessionId/lifecycle',
          },
        ],
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
          '[CONTROL SERVER] Request received',
          {
            requestId: expect.any(String),
            method: 'GET',
            route: '<unmatched>',
          },
        ],
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
