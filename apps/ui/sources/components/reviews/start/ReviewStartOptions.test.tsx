import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { resolveReviewWalkthroughPlan } from '@/sync/domains/reviews/reviewWalkthroughPlan';
import { reviewReviewersForEngineIdsV1 } from '@happier-dev/protocol/reviews/reviewStart';

import {
  ReviewStartOptions,
  type ReviewStartCostConsent,
} from './ReviewStartOptions';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
// The narrator menu's portal is a platform boundary; the field and its choices stay real.
vi.mock('@/components/ui/popover', async (importOriginal) => {
  const { createInlinePopoverModuleMock } = await import('@/dev/testkit/mocks/popover');
  return createInlinePopoverModuleMock(importOriginal, { maxHeight: 640, maxWidth: 280, placement: 'bottom' });
});

const ENGINES = [
  { engineId: 'claude', label: 'Claude Code', enabled: true, structuredNarration: true },
  { engineId: 'codex', label: 'Codex', enabled: true, structuredNarration: true },
];

function Harness(
  props: Readonly<{
    narration?: boolean;
    onNarrator?: (engineId: string) => void;
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
  const [narratorEngineId, setNarratorEngineId] = React.useState<string | null>(null);
  React.useEffect(() => {
    props.onChange?.({ then, walkthrough, accepted });
  }, [accepted, props, then, walkthrough]);
  // The host's one narrator policy: one Codex reviewer, which writes its own walkthrough unless changed.
  const plan = resolveReviewWalkthroughPlan({ engines: ENGINES, reviewers: reviewReviewersForEngineIdsV1(['codex']),
    walkthrough, narratorEngineId });
  return (
    <ReviewStartOptions
      narrator={props.narration ? { plan,
        onSelect: (engineId) => { setNarratorEngineId(engineId); props.onNarrator?.(engineId); } } : null}
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

  it('offers the narrator in Advanced whenever Walk me through it is on, for any roster', async () => {
    const chosen: string[] = [];
    const screen = await renderScreen(<Harness narration onNarrator={(engineId) => chosen.push(engineId)} />);
    await screen.pressByTestIdAsync('review-start-advanced:header');
    expect(screen.findByTestId('review-start-narrator.trigger')).toBeNull();
    await screen.pressByTestIdAsync('review-start-walkthrough');
    expect(screen.findByTestId('review-start-narrator.trigger')).not.toBeNull();
    expect(screen.getTextContent()).toContain('Codex');
    await screen.pressByTestIdAsync('review-start-narrator.trigger');
    await vi.waitFor(() => expect(screen.findAllHostsByTestId('review-start-narrator:claude').length).toBeGreaterThan(0));
    await screen.pressByTestIdAsync('review-start-narrator:claude');
    await vi.waitFor(() => expect(chosen).toEqual(['claude']));
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('Claude Code'));
    await screen.unmount();
  });
});
