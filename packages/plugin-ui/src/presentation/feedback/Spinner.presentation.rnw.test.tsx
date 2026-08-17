import { describe, expect, it } from 'vitest';

import { resolveHappierWebSpinnerPresentation } from './Spinner.js';

describe('shared web-spinner presentation', () => {
  it('keeps a reduced-motion spinner visible while removing its continuous animation', () => {
    const presentation = resolveHappierWebSpinnerPresentation({
      animating: true,
      animationEnabled: true,
      color: 'red',
      reducedMotion: true,
      size: 12,
    });

    expect(presentation?.style).toMatchObject({
      width: 12,
      height: 12,
      borderColor: 'red',
      opacity: 1,
    });
    expect(presentation?.style.animationName).toBeUndefined();
    expect(presentation?.style.animationIterationCount).toBeUndefined();
    expect(presentation?.style.willChange).toBeUndefined();
  });

  it('uses the small-spinner stepped timing and hides a stopped hidden spinner', () => {
    expect(resolveHappierWebSpinnerPresentation({
      animating: false,
      hidesWhenStopped: true,
    })).toBeNull();

    const presentation = resolveHappierWebSpinnerPresentation({
      animating: true,
      animationEnabled: true,
      size: 'small',
    });

    expect(presentation?.style.animationName).toBe('happierActivitySpinnerSpin');
    expect(presentation?.style.animationTimingFunction).toBe('steps(6, end)');
  });
});
