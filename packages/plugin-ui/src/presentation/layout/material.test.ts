import { describe, expect, it } from 'vitest';

import { happierMaterialBackgroundColor, resolveHappierSurfaceFinish, happierSurfaceGradientWebStyle } from './material.js';

describe('surface finish policy', () => {
  const gradient = { colors: ['transparent', 'rgba(0, 0, 0, 0.024)'], locations: [0.3, 1], start: { x: 0.5, y: 0 }, end: { x: 0.5, y: 1 } } as const;
  it('resolves every role through one policy, preserves the overlay, and lets overrides win', () => {
    const gradients = { card: gradient, floating: gradient, composer: gradient, primaryButton: gradient, secondaryButton: gradient };
    for (const role of Object.keys(gradients) as Array<keyof typeof gradients>) {
      expect(resolveHappierSurfaceFinish({ role, gradients })).toBe(gradient);
      expect(resolveHappierSurfaceFinish({ role, gradients, finish: 'flat' })).toBeNull();
      expect(resolveHappierSurfaceFinish({ role, gradients, finish: 'flat', parts: { [role]: { finish: 'soft' } } })).toBe(gradient);
      for (const state of [{ pressed: true }, { disabled: true }, { focused: true }, { invalid: true }]) {
        expect(resolveHappierSurfaceFinish({ role, gradients, state })).toBeNull();
      }
    }
    expect(resolveHappierSurfaceFinish({ role: 'card', gradients, nested: true })).toBeNull();
  });
  it('paints transparent web stops on the existing padding-box without introducing a fill', () => {
    expect(happierSurfaceGradientWebStyle(gradient)).toEqual({ backgroundImage: 'linear-gradient(180deg, transparent 30%, rgba(0, 0, 0, 0.024) 100%)', backgroundClip: 'padding-box' });
    expect(happierSurfaceGradientWebStyle(null)).toBeNull();
  });
});

describe('material background paint', () => {
  it('leaves native colors to the real native material renderer', () => {
    expect(happierMaterialBackgroundColor('rgba(20, 30, 40, 0.7)', 'floating', false)).toBe('rgba(20, 30, 40, 0.7)');
    expect(happierMaterialBackgroundColor('dynamic-native-color', 'content', false, true)).toBe('dynamic-native-color');
  });

  it('projects web opacity through the host variables, retaining an opaque default when the host is absent', () => {
    expect(happierMaterialBackgroundColor('var(--working-paper)', 'content', true)).toBe(
      'var(--happier-glass-content-background-color, color-mix(in srgb, var(--working-paper) var(--happier-glass-content-opacity, 100%), transparent))',
    );
    expect(happierMaterialBackgroundColor('#112233', 'chrome', true, true)).toBe(
      'var(--happier-glass-chrome-nested-background-color, color-mix(in srgb, #112233 var(--happier-glass-chrome-nested-opacity, 100%), transparent))',
    );
  });
});
