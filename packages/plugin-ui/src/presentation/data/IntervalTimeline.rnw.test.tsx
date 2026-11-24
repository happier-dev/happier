import { describe, expect, it } from 'vitest';

import { SURFACE_CONTEXT_THEME_FIXTURE as theme } from '../../../../plugin-sdk/src/ui/surfaceContext.fixture.js';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { IntervalTimeline } from './IntervalTimeline.js';

const query = (root: HTMLElement, id: string) =>
  root.querySelector<HTMLElement>(`[data-testid="${id}"]`);

/** The nearest ancestor that draws its own bottom rule, or null. */
function ruledAncestor(node: HTMLElement | null): HTMLElement | null {
  for (let current = node; current !== null; current = current.parentElement) {
    if (
      current.style.borderBottomWidth !== '' &&
      current.style.borderBottomWidth !== '0px'
    )
      return current;
  }
  return null;
}

describe('a narrow rows timeline (a phone waterfall)', () => {
  // DBW review R4 #4: on a phone a span is two lines, its label and time, then its bar. Rows part by a rule, so a child's
  // bar reads as its own label's and never as one more row on the axis.
  it('parts each two-line row from the next and from the axis', () => {
    const mount = mountThroughReactNativeWeb(
      <IntervalTimeline
        theme={theme}
        label="Request timeline"
        size="full"
        domain={{ start: 0, end: 188 }}
        testID="timeline"
        geometry={{ width: 340, height: 400 }}
        intervals={[
          {
            id: 'root',
            label: 'GET /invoices/:id',
            start: 0,
            end: 188,
            value: '188 ms',
          },
          {
            id: 'child',
            label: 'select id, total_cents from invoices',
            start: 5,
            end: 183,
            depth: 1,
            identifier: true,
            value: '178 ms',
          },
        ]}
      />,
    );
    try {
      const rootRow = ruledAncestor(
        query(mount.container, 'timeline-interval-root'),
      );
      const childRow = ruledAncestor(
        query(mount.container, 'timeline-interval-child'),
      );
      expect(rootRow).not.toBeNull();
      expect(childRow).not.toBeNull();
      expect(childRow).not.toBe(rootRow);
      // The child's label and bar share its own row.
      expect(childRow!.textContent).toContain('select id');
      expect(childRow!.textContent).not.toContain('GET /invoices');
      const axis = query(mount.container, 'timeline-axis');
      expect(axis!.style.marginTop).not.toBe('');
      expect(axis!.style.marginTop).not.toBe('0px');
    } finally {
      mount.unmount();
    }
  });
});
