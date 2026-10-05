import { describe, expect, it } from 'vitest';

import { happierMaterialBackgroundColor } from './material.js';

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
