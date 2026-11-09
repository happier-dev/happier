import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { Text } from '@/components/ui/text/Text';
import { PublishRiseLine } from './publicProfilePublishRise';

// The entrance's own completion is the behaviour under test, so timing callbacks settle.
vi.mock('react-native-reanimated', async () =>
  (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock({
    settleTimingCallbacks: true,
  }),
);

const lineOpacity = (screen: Awaited<ReturnType<typeof renderScreen>>) => {
  let node = screen.findByTestId('line');
  while (node) {
    const style = [node.props?.style]
      .flat(Infinity)
      .find((s) => s && typeof s === 'object' && 'opacity' in s);
    if (style) return (style as { opacity: number }).opacity;
    node = node.parent;
  }
  return undefined;
};

describe('the publish result line', () => {
  it('enters once per publish: after it has entered, a remount in another slot (Edit ↔ Preview) shows it settled', async () => {
    const entered = vi.fn();
    function Owner() {
      const [moment, setMoment] = React.useState<number | null>(1);
      const [slot, setSlot] = React.useState<'edit' | 'preview'>('edit');
      const line = (
        <PublishRiseLine
          moment={moment}
          onEntered={() => {
            entered();
            setMoment(null);
          }}
        >
          <Text testID="line">Published</Text>
        </PublishRiseLine>
      );
      return (
        <>
          <Text
            testID="switch"
            onPress={() =>
              setSlot((current) => (current === 'edit' ? 'preview' : 'edit'))
            }
          >
            switch
          </Text>
          {slot === 'edit' ? (
            <React.Fragment key="edit">{line}</React.Fragment>
          ) : (
            <React.Fragment key="preview">{line}</React.Fragment>
          )}
        </>
      );
    }
    const screen = await renderScreen(<Owner />);
    expect(entered).toHaveBeenCalledTimes(1);
    await screen.pressByTestIdAsync('switch');
    expect(lineOpacity(screen)).toBe(1);
    await screen.pressByTestIdAsync('switch');
    expect(lineOpacity(screen)).toBe(1);
    expect(entered).toHaveBeenCalledTimes(1);
  });
});
