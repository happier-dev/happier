import { expect, it, vi } from 'vitest';

import { SURFACE_CONTEXT_THEME_FIXTURE as theme } from '../../../../../plugin-sdk/src/ui/surfaceContext.fixture.js';
import { mountThroughReactNativeWeb } from '../../../rnwMount.testSupport.js';
import { UsageChartGhost } from './UsageChartGhost.js';

it('hides decorative chart SVGs without forwarding native accessibility props to the DOM', () => {
  const errors = vi.spyOn(console, 'error');
  const chart = mountThroughReactNativeWeb(<UsageChartGhost theme={theme}
    paint={{ accent: '#007aff', paper: '#fff', dark: false }} shape="sky" width={390} />);
  try {
    expect(errors.mock.calls.filter(args => args.some(arg => String(arg).includes('non-boolean attribute')))).toEqual([]);
    const drawing = chart.container.querySelector('svg');
    expect(drawing).not.toBeNull();
    expect(drawing!.getAttribute('aria-hidden')).toBe('true');
    expect(drawing!.hasAttribute('accessible')).toBe(false);
  } finally { chart.unmount(); errors.mockRestore(); }
});
