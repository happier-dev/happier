import { describe, expect, it, vi } from 'vitest';

import {
  createEventShapeLoggerForLog,
  summarizeValueShapeForLog,
} from './eventShapeForLog';

describe('diagnostics/eventShapeForLog', () => {
  it('summarizes object shapes without leaking string contents', () => {
    const input = {
      type: 'agent_message',
      message: 'SUPER_SECRET_VALUE',
      nested: {
        token: 'tok_abc123',
        ok: 123,
      },
      list: ['also_secret'],
    };

    const summary = summarizeValueShapeForLog(input);
    const asText = JSON.stringify(summary);

    expect(asText).toContain('"keys"');
    expect(asText).toContain('message');
    expect(asText).toContain('nested');
    expect(asText).not.toContain('SUPER_SECRET_VALUE');
    expect(asText).not.toContain('tok_abc123');
    expect(asText).not.toContain('also_secret');
  });

  it('handles circular references without throwing', () => {
    const input: any = { a: 1 };
    input.self = input;

    expect(() => summarizeValueShapeForLog(input)).not.toThrow();
  });

  it('deduplicates repeated shapes and logs only when the shape changes', () => {
    const logger = { debug: vi.fn() };
    const shapeLogger = createEventShapeLoggerForLog({ logger, scope: 'test', maxEntries: 10 });

    shapeLogger.log('event', { type: 'x', message: 'SECRET' });
    shapeLogger.log('event', { type: 'x', message: 'DIFFERENT_SECRET' });
    shapeLogger.log('event', { type: 'x', message: 'DIFFERENT_SECRET', extra: 1 });

    // First call logs (new shape), second call is same shape (same keys/types), third call logs again (extra key).
    expect(logger.debug).toHaveBeenCalledTimes(2);
  });
});

