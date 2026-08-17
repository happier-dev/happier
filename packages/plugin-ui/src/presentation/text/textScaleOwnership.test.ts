import { describe, expect, it } from 'vitest';

import { resolveHappierTextScaleOwnership } from './textScaleOwnership.js';

describe('shared text-scale ownership', () => {
  it('applies a mounted environment scale in metrics and disables native re-scaling', () => {
    expect(resolveHappierTextScaleOwnership({ environmentTextScale: 2 })).toEqual({
      metricScale: 2,
      allowHostFontScaling: false,
    });
  });

  it('keeps explicit app UI scaling additive with the native accessibility owner', () => {
    expect(resolveHappierTextScaleOwnership({
      explicitTextScale: 1.25,
      environmentTextScale: 2,
    })).toEqual({
      metricScale: 1.25,
      allowHostFontScaling: true,
    });
  });

  it('leaves an unmounted host on its native default', () => {
    expect(resolveHappierTextScaleOwnership({})).toEqual({
      metricScale: 1,
      allowHostFontScaling: true,
    });
  });
});
