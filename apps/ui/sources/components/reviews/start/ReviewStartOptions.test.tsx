import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import {
  ReviewStartOptions,
  type ReviewStartCostConsent,
} from './ReviewStartOptions';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);

function Harness(
  props: Readonly<{
    cost?: Omit<ReviewStartCostConsent, 'accepted' | 'onAcceptedChange'>;
    onChange?: (
      state: Readonly<{
        then: 'report' | 'fix';
        walkthrough: boolean;
        accepted: boolean;
      }>,
    ) => void;
  }>,
) {
  const [then, setThen] = React.useState<'report' | 'fix'>('report');
  const [walkthrough, setWalkthrough] = React.useState(false);
  const [accepted, setAccepted] = React.useState(false);
  React.useEffect(() => {
    props.onChange?.({ then, walkthrough, accepted });
  }, [accepted, props, then, walkthrough]);
  return (
    <ReviewStartOptions
      then={then}
      onThenChange={setThen}
      walkthrough={walkthrough}
      onWalkthroughChange={setWalkthrough}
      costs={
        props.cost
          ? [{ ...props.cost, accepted, onAcceptedChange: setAccepted }]
          : []
      }
    />
  );
}

describe('ReviewStartOptions', () => {
  it('keeps Then, Walk me through it and a folded Advanced that names its contents', async () => {
    const states: Readonly<{ then: string; walkthrough: boolean }>[] = [];
    const screen = await renderScreen(
      <Harness onChange={(state) => states.push(state)} />,
    );
    expect(screen.getTextContent()).toContain('Narrator, keys and accounts');
    await screen.pressByTestIdAsync('review-start-then:fix');
    await screen.pressByTestIdAsync('review-start-walkthrough');
    expect(states.at(-1)).toMatchObject({ then: 'fix', walkthrough: true });
    await screen.unmount();
  });

  it("asks for an engine's own estimate as a consent row, never a saved switch", async () => {
    const states: Readonly<{ accepted: boolean }>[] = [];
    const screen = await renderScreen(
      <Harness
        cost={{ id: 'deepsec', engine: 'DeepSec', estimate: '$4.80', title: 'Accept DeepSec’s $4.80 estimate' }}
        onChange={(state) => states.push(state)}
      />,
    );
    expect(screen.getTextContent()).toContain(
      'Narrator, keys and accounts, cost estimate',
    );
    expect(screen.getTextContent()).toContain(
      'Accept DeepSec’s $4.80 estimate',
    );
    // The row's host announces the consent as a checkbox state.
    const checked = () => {
      const host = screen.findHostByTestId('review-start-cost-consent');
      return host?.props.accessibilityState?.checked ?? host?.props['aria-checked'];
    };
    expect(checked()).toBe(false);
    await screen.pressByTestIdAsync('review-start-cost-consent');
    expect(states.at(-1)).toMatchObject({ accepted: true });
    expect(checked()).toBe(true);
    await screen.unmount();
  });
});
