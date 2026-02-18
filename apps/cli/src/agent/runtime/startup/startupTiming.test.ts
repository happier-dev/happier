import { describe, expect, it } from 'vitest';

import { createStartupTiming } from './startupTiming';

describe('createStartupTiming', () => {
  it('records marks relative to timing start', () => {
    let now = 1_000;
    const timing = createStartupTiming({ enabled: true, nowMs: () => now });

    now = 1_010;
    timing.mark('vendor_spawn_invoked');

    expect(timing.getMark('vendor_spawn_invoked')).toBe(10);
  });

  it('records spans relative to timing start and formats durations', () => {
    let now = 5_000;
    const timing = createStartupTiming({ enabled: true, nowMs: () => now });

    now = 5_020;
    const end = timing.startSpan('initialize_backend_api_context');
    now = 5_055;
    end();

    expect(timing.getSpan('initialize_backend_api_context')).toEqual({ startMs: 20, endMs: 55 });
    expect(
      timing.formatSummaryLine({
        prefix: '[timing]',
        includeIds: ['initialize_backend_api_context'],
      }),
    ).toBe('[timing] initialize_backend_api_context=35ms');
  });
});

