import { describe, expect, it } from 'vitest';

import { resolvePublishRiseTiming } from './publicProfilePublishRise';

describe('the first-publish rise (lab ppmotion M1)', () => {
  it('raises the band once, then brings in the result line after it', () => {
    const timing = resolvePublishRiseTiming({
      reducedMotion: false,
      bandHeightPx: 300,
      moment: 1,
    });
    if (timing === null) throw new Error('Expected timing for a publish moment');
    expect(timing.travelPx).toBeGreaterThan(0);
    expect(timing.riseMs).toBeGreaterThan(0);
    expect(timing.lineDelayMs).toBeGreaterThanOrEqual(timing.riseMs);
    expect(timing.lineRisePx).toBeGreaterThan(0);
  });

  it('under reduced motion shows the risen band and the line with one short cross-fade, nothing travels', () => {
    const timing = resolvePublishRiseTiming({
      reducedMotion: true,
      bandHeightPx: 300,
      moment: 1,
    });
    if (timing === null) throw new Error('Expected timing for a publish moment');
    expect(timing.travelPx).toBe(0);
    expect(timing.lineRisePx).toBe(0);
    expect(timing.lineDelayMs).toBe(0);
    expect(timing.riseMs).toBe(timing.lineEnterMs);
  });

  it('does nothing without a publish in front of the owner (a reload, a visitor, an Apply)', () => {
    expect(
      resolvePublishRiseTiming({
        reducedMotion: false,
        bandHeightPx: 300,
        moment: null,
      }),
    ).toBeNull();
  });
});
