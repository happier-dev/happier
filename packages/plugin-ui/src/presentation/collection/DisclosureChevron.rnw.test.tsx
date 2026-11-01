import { describe, expect, it } from 'vitest';

import * as Presentation from '@happier-dev/plugin-ui/presentation';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';

type TurnProps = Readonly<{ expanded: boolean; reducedMotion?: boolean; testID?: string; children: React.ReactNode }>;

describe('HappierDisclosureTurn', () => {
  it('turns the one glyph a quarter turn when the disclosure opens, without a transition under reduced motion', async () => {
    // A missing public export renders nothing: the intended authoring-gap RED.
    const Turn = (Presentation as typeof Presentation & {
      HappierDisclosureTurn?: React.ComponentType<TurnProps>;
    }).HappierDisclosureTurn;
    const glyph = <span data-testid="glyph">›</span>;
    const surface = (expanded: boolean, reducedMotion?: boolean) => (Turn
      ? <Turn expanded={expanded} reducedMotion={reducedMotion} testID="turn">{glyph}</Turn>
      : null);
    const view = mountThroughReactNativeWeb(surface(false));
    try {
      const turn = () => view.container.querySelector<HTMLElement>('[data-testid="turn"]');
      expect(turn(), 'the host binds its own glyph through the public presentation entry').not.toBeNull();
      // Decorative: the header's pressable owns the expanded state and the label.
      expect(turn()?.getAttribute('aria-hidden')).toBe('true');
      expect(turn()?.querySelector('[data-testid="glyph"]')).not.toBeNull();
      expect(turn()?.style.transform).toContain('rotate(0deg)');
      expect(turn()?.style.transitionProperty).toBe('transform');

      await view.render(surface(true));
      // Closed points at the row's content (right); open points at what it revealed (down).
      expect(turn()?.style.transform).toContain('rotate(90deg)');

      await view.render(surface(true, true));
      expect(turn()?.style.transform).toContain('rotate(90deg)');
      expect(turn()?.style.transitionProperty ?? '').toBe('');
    } finally {
      view.unmount();
    }
  });
});
