import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { SURFACE_CONTEXT_THEME_FIXTURE } from '../../../../plugin-sdk/src/ui/surfaceContext.fixture.js';
import { OutcomeFunnel } from './OutcomeFunnel.js';

describe('neutral outcome funnel', () => {
  it('preserves supplied order and exact zero, signed and unknown steps while sharing the row proportion owner', () => {
    const mount = mountThroughReactNativeWeb(<OutcomeFunnel theme={SURFACE_CONTEXT_THEME_FIXTURE} label="Manufacturing batches"
      basis="Inspected batches" testID="funnel" size="tile"
      steps={[{ id: 'ready', label: 'Ready', value: 2 }, { id: 'produced', label: 'Produced', value: 4 },
        { id: 'zero', label: 'Rejected', value: 0 }, { id: 'signed', label: 'Corrections', value: -1 },
        { id: 'unknown', label: 'Uninspected', value: null, annotation: 'Sampling not complete' }]} />);
    try {
      const row = (index: number) => mount.container.querySelector<HTMLElement>(`[data-testid="funnel-row-${index}"]`);
      expect(row(0)).not.toBeNull();
      expect(row(0)!.getAttribute('aria-label')).toContain('Ready');
      expect(row(1)!.getAttribute('aria-label')).toContain('Produced');
      expect(row(2)!.getAttribute('aria-label')).toContain('Inspected batches: 0');
      expect(row(3)!.getAttribute('aria-label')).toContain('Inspected batches: -1');
      expect(row(4)!.getAttribute('aria-label')).toContain('Unknown');
      expect(row(4)!.getAttribute('aria-label')).toContain('Sampling not complete');
      expect(mount.container.querySelectorAll('[role="listitem"]')).toHaveLength(5);
      expect(mount.container.querySelector<HTMLElement>('[data-testid="funnel-fill-0"]')!.style.width).toBe('50%');
      expect(mount.container.querySelector<HTMLElement>('[data-testid="funnel-fill-1"]')!.style.width).toBe('100%');
    } finally { mount.unmount(); }
  });
});
