import { Text } from 'react-native';
import { describe, expect, it, onTestFinished } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { HappierSurfaceStateFrame } from './InfoState.js';

describe('HappierSurfaceStateFrame', () => {
  it('gives an unsized card a definite width (its frame, up to the measure), so its words wrap inside the screen (L4)', () => {
    // A centred card with no width shrink-wrapped its words: on iOS a long description laid out at its natural
    // width (up to 560) and spilled past both screen edges (Companion empty state, the sign-in continuation card;
    // PHONE-GEOMETRY-1110 L4).
    const view = mountThroughReactNativeWeb(
      <HappierSurfaceStateFrame testID="state">
        <Text>
          Pair a companion to see what it is doing, from any device you sign in
          on.
        </Text>
      </HappierSurfaceStateFrame>,
    );
    onTestFinished(() => view.unmount());
    const card = view.container.querySelector<HTMLElement>(
      '[data-testid="state-card"]',
    )!;
    expect(card.style.width).toBe('100%');
    expect(card.style.maxWidth).toBe('560px');
  });
});
