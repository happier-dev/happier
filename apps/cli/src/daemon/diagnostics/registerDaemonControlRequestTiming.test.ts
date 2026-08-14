import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { registerDaemonControlRequestTiming } from './registerDaemonControlRequestTiming';

describe('registerDaemonControlRequestTiming', () => {
  it('logs safe route receipt and completion timing through the real request lifecycle', async () => {
    let nowMs = 100;
    const debug = vi.fn();
    const app = fastify({ logger: false });
    registerDaemonControlRequestTiming(app, {
      nowMs: () => nowMs,
      debug,
    });
    app.post('/connected-service-turn-lifecycle', async () => {
      nowMs = 145;
      return { ok: true };
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/connected-service-turn-lifecycle?secret=never-log-query-values',
        payload: { sessionId: 'secret-session-id' },
      });

      expect(response.statusCode).toBe(200);
      expect(debug.mock.calls).toEqual([
        [
          '[CONTROL SERVER] Request received',
          {
            requestId: expect.any(String),
            method: 'POST',
            route: '/connected-service-turn-lifecycle',
          },
        ],
        [
          '[CONTROL SERVER] Request completed',
          {
            requestId: expect.any(String),
            method: 'POST',
            route: '/connected-service-turn-lifecycle',
            statusCode: 200,
            durationMs: 45,
          },
        ],
      ]);
      expect(JSON.stringify(debug.mock.calls)).not.toContain('secret');
    } finally {
      await app.close();
    }
  });
});
