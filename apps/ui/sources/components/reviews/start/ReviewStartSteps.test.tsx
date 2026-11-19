import * as React from 'react';
import { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { describe, expect, it, vi } from 'vitest';
import type {
  ReviewReviewerSelectionV1,
  ReviewStepV1,
} from '@happier-dev/protocol/reviews/reviewStart';

import { renderScreen } from '@/dev/testkit';

import {
  ReviewStartSteps,
  type ReviewStartReviewerPresentation,
} from './ReviewStartSteps';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);

const engine = (engineId: string): ReviewReviewerSelectionV1 => ({
  kind: 'engine',
  engineId,
});
const session = (sessionId: string): ReviewReviewerSelectionV1 => ({
  kind: 'session',
  session: { serverId: 'home', sessionId },
});

const NAMES: Readonly<Record<string, string>> = {
  coderabbit: 'CodeRabbit',
  deepsec: 'DeepSec',
  claude: 'Claude',
  codex: 'Codex',
  s1: 'Fix settings session',
};

function present(
  reviewer: ReviewReviewerSelectionV1,
): ReviewStartReviewerPresentation {
  const id =
    reviewer.kind === 'engine'
      ? reviewer.engineId
      : reviewer.kind === 'session'
        ? reviewer.session.sessionId
        : 'person';
  return {
    name: NAMES[id] ?? id,
    mark: null,
    warning: id === 'coderabbit' ? 'CodeRabbit needs an API key' : null,
  };
}

function Harness(
  props: Readonly<{
    initial: readonly ReviewStepV1[];
    transcriptAvailable?: boolean;
    onSteps?: (steps: readonly ReviewStepV1[]) => void;
  }>,
) {
  const [steps, setSteps] = React.useState<readonly ReviewStepV1[]>(
    props.initial,
  );
  return (
    <ReviewStartSteps
      steps={steps}
      onStepsChange={(next) => {
        setSteps(next);
        props.onSteps?.(next);
      }}
      presentReviewer={present}
      renderWho={(stepIndex) => (
        <Text testID={`who:${stepIndex}`}>{`who list ${stepIndex + 1}`}</Text>
      )}
      transcriptAvailable={props.transcriptAvailable ?? false}
    />
  );
}

const TWO_STEPS: readonly ReviewStepV1[] = [
  {
    kind: 'review',
    reviewers: [engine('coderabbit'), engine('deepsec')],
    instructions: '',
  },
  {
    kind: 'verify',
    reviewers: [engine('claude'), engine('codex'), session('s1')],
    instructions: '',
  },
];

describe('ReviewStartSteps', () => {
  it('opens the first step and folds later ones to their reviewers, instruction and chevron', async () => {
    const screen = await renderScreen(<Harness initial={TWO_STEPS} />);
    expect(screen.findByTestId('who:0')).not.toBeNull();
    expect(screen.findByTestId('who:1')).toBeNull();
    const text = screen.getTextContent();
    expect(text).toContain('Step 2 · Double-check');
    expect(text).toContain('Checks the findings from step 1');
    expect(text).toContain('Claude, Codex, Fix settings session');
    await screen.unmount();
  });

  it("opens a folded step without folding its peers, and says a folded step's warning", async () => {
    const screen = await renderScreen(
      <Harness
        initial={[
          { ...TWO_STEPS[1]!, kind: 'review' },
          { ...TWO_STEPS[0]!, kind: 'verify' },
        ]}
      />,
    );
    expect(screen.getTextContent()).toContain('CodeRabbit needs an API key');
    await screen.pressByTestIdAsync('review-start-step:1:header');
    expect(screen.findByTestId('who:0')).not.toBeNull();
    expect(screen.findByTestId('who:1')).not.toBeNull();
    await screen.pressByTestIdAsync('review-start-step:0:header');
    // The body folds away over the disclosure's motion; the header says the state at once.
    expect(screen.findByTestId('review-start-step:0:header')?.props.accessibilityState).toEqual({ expanded: false });
    expect(screen.findByTestId('review-start-step:1:header')?.props.accessibilityState).toEqual({ expanded: true });
    await screen.unmount();
  });

  it('adds a step that checks the previous findings and opens it, leaving open steps open', async () => {
    const seen: (readonly ReviewStepV1[])[] = [];
    const screen = await renderScreen(
      <Harness initial={TWO_STEPS} onSteps={(steps) => seen.push(steps)} />,
    );
    expect(screen.getTextContent()).toContain(
      'Runs after step 2, on its findings or the same changes',
    );
    await screen.pressByTestIdAsync('review-start-add-step');
    expect(seen.at(-1)).toEqual([
      ...TWO_STEPS,
      { kind: 'verify', reviewers: [], instructions: '' },
    ]);
    expect(screen.findByTestId('who:0')).not.toBeNull();
    expect(screen.findByTestId('who:2')).not.toBeNull();
    expect(screen.getTextContent()).toContain(
      'Runs after step 3, on its findings or the same changes',
    );
    await screen.unmount();
  });

  it('writes the Focus into its own step only', async () => {
    const seen: (readonly ReviewStepV1[])[] = [];
    const screen = await renderScreen(
      <Harness initial={TWO_STEPS} onSteps={(steps) => seen.push(steps)} />,
    );
    screen.changeTextByTestId('review-start-step:0:focus', 'The modal remount');
    expect(seen.at(-1)?.map((step) => step.instructions)).toEqual([
      'The modal remount',
      '',
    ]);
    await screen.unmount();
  });

  it("offers the transcript to a Session subject and binds it to every reviewer in the step that takes input", async () => {
    const person: ReviewReviewerSelectionV1 = { kind: 'person', principal: { kind: 'account', accountId: 'mika' }, required: true };
    const mixed: readonly ReviewStepV1[] = [
      {
        kind: 'review',
        reviewers: [engine('coderabbit'), session('s1'), person],
        instructions: '',
      },
    ];
    const without = await renderScreen(<Harness initial={mixed} />);
    expect(without.findByTestId('review-start-step:0:transcript')).toBeNull();
    await without.unmount();

    // People read the Review, not a prompt: a step of only people has nothing to pass the transcript to.
    const peopleOnly = await renderScreen(
      <Harness initial={[{ kind: 'review', reviewers: [person], instructions: '' }]} transcriptAvailable />,
    );
    expect(peopleOnly.findByTestId('review-start-step:0:transcript')).toBeNull();
    await peopleOnly.unmount();

    const seen: (readonly ReviewStepV1[])[] = [];
    const screen = await renderScreen(
      <Harness
        initial={mixed}
        transcriptAvailable
        onSteps={(steps) => seen.push(steps)}
      />,
    );
    expect(screen.getTextContent()).toContain(
      'Include the session’s transcript',
    );
    await screen.pressByTestIdAsync('review-start-step:0:transcript');
    expect(seen.at(-1)?.[0]?.reviewers).toEqual([
      { kind: 'engine', engineId: 'coderabbit', includeSessionTranscript: true },
      { ...session('s1'), includeSessionTranscript: true },
      person,
    ]);
    await screen.pressByTestIdAsync('review-start-step:0:transcript');
    expect(seen.at(-1)?.[0]?.reviewers).toEqual([
      { kind: 'engine', engineId: 'coderabbit' },
      session('s1'),
      person,
    ]);
    await screen.unmount();
  });

  it("removes a later step from its menu and keeps the first step's kind fixed", async () => {
    const seen: (readonly ReviewStepV1[])[] = [];
    const screen = await renderScreen(
      <Harness initial={TWO_STEPS} onSteps={(steps) => seen.push(steps)} />,
    );
    expect(screen.findByTestId('review-start-step:0:menu')).toBeNull();
    await screen.pressByTestIdAsync('review-start-step:1:header');
    const menu = screen.findByProps({ testID: 'review-start-step:1:menu:list' });
    const items = menu.props.items as readonly Readonly<{ id: string }>[];
    expect(items.map((item) => item.id)).toEqual(['verify', 'review', 'remove']);
    await act(async () => {
      (menu.props.onSelect as (id: string) => void)('remove');
    });
    expect(seen.at(-1)).toEqual([TWO_STEPS[0]]);
    await screen.unmount();
  });
});
