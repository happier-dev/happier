import { Text, View } from 'react-native';
import { describe, expect, it, onTestFinished } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import {
  HAPPIER_STATE_SIZE_METRICS,
  HappierSurfaceStateFit,
  HappierSurfaceStateFrame,
} from './InfoState.js';

describe('HappierSurfaceStateFrame placement', () => {
  it('lifts a sized state in a pane, and drops the lift in a container that shrink-wraps it (a popover)', () => {
    const frame = (
      <HappierSurfaceStateFrame testID="state" size="details">
        <Text>No machines yet</Text>
      </HappierSurfaceStateFrame>
    );
    const view = mountThroughReactNativeWeb(
      <>
        <View testID="pane">{frame}</View>
        <HappierSurfaceStateFit.Provider value="content">
          <HappierSurfaceStateFrame testID="hug" size="details">
            <Text>No machines yet</Text>
          </HappierSurfaceStateFrame>
        </HappierSurfaceStateFit.Provider>
      </>,
    );
    onTestFinished(() => view.unmount());
    const padding = (testID: string) =>
      view.container.querySelector<HTMLElement>(`[data-testid="${testID}"]`)!
        .style.paddingBottom;
    expect(padding('state')).toBe(
      `${24 + HAPPIER_STATE_SIZE_METRICS.details.liftPx}px`,
    );
    // The popover's room is the state's own: its space below matches the space above.
    expect(padding('hug')).toBe('24px');
  });
});
