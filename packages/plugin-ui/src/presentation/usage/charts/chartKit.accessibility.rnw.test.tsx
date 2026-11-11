import { act } from 'react';
import { expect, it } from 'vitest';

import { SURFACE_CONTEXT_THEME_FIXTURE as theme } from '../../../../../plugin-sdk/src/ui/surfaceContext.fixture.js';
import { mountThroughReactNativeWeb } from '../../../rnwMount.testSupport.js';
import { UsageChartValues } from './chartKit.js';

it('distinguishes exact-value disclosures by chart before and after expansion', () => {
  const charts = ['Weekday tide · Tokens', 'Daylight · Tokens'];
  const mounted = mountThroughReactNativeWeb(<>{charts.map(label => <UsageChartValues key={label} theme={theme}
    label={label} labels={{ show: 'Exact values', hide: 'Hide values' }}
    table={{ columns: [{ label: 'Hour' }, { label: 'Tokens' }], rows: [['10:00', 1234]] }} />)}</>);
  try {
    for (const label of charts) {
      const toggle = mounted.container.querySelector<HTMLButtonElement>(`[role="button"][aria-label="${label} · Exact values"]`);
      expect(toggle, `Missing contextual disclosure for ${label}`).not.toBeNull();
      expect(toggle!.getAttribute('aria-expanded')).toBe('false');
      act(() => toggle!.click());
      expect(toggle!.getAttribute('aria-label')).toBe(`${label} · Hide values`);
      expect(toggle!.getAttribute('aria-expanded')).toBe('true');
      expect(mounted.container.querySelector(`[role="table"][aria-label="${label}"]`)).not.toBeNull();
      act(() => toggle!.click());
      expect(toggle!.getAttribute('aria-label')).toBe(`${label} · Exact values`);
    }
  } finally { mounted.unmount(); }
});
