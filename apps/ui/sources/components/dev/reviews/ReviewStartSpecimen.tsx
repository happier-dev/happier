import * as React from 'react';
import { ScrollView, View, useWindowDimensions } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type {
  ReviewReviewerSelectionV1,
  ReviewStepV1,
} from '@happier-dev/protocol/reviews/reviewStart';

import { ReviewStartOptions } from '@/components/reviews/start/ReviewStartOptions';
import {
  ReviewStartSteps,
  type ReviewStartReviewerPresentation,
} from '@/components/reviews/start/ReviewStartSteps';
import {
  ContextualStartComposerBody,
  useContextualStartComposer,
  type ContextualStartAdmissibleSet,
  type ContextualStartSource,
} from '@/components/sessions/authoring/ContextualStartComposer';
import { SessionAgentCatalogIdentityIcon } from '@/components/sessions/presentation/SessionAgentCatalogIdentityIcon';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import type { SelectionListOption } from '@/components/ui/selectionList';
import { t } from '@/text';

/**
 * Dev-only specimen of the Reviews start sheet's steps and once-per-review options (Reviews lab rounds 8–12:
 * `start-sheet`, `start-rounds`, `start-deep`), rendered through the real step, option and shared Who-list
 * owners with fixture reviewers. `?scene=rounds` opens three steps, `?scene=deep` adds DeepSec's estimate.
 * Fixture names are the lab's illustration, not product copy; nothing is started.
 */
type Fixture = Readonly<{
  id: string;
  category: 'session' | 'bot' | 'person' | 'engine';
  name: string;
  line: string;
  reviewer: ReviewReviewerSelectionV1;
  mark: () => React.ReactNode;
  avatar?: boolean;
  warning?: string;
}>;

const engineMark = (name: 'shield' | 'bug') => () => (
  <Icon name={name} size={ICON_SIZE.sm} />
);
const agentMark = (agentId: string) => () => (
  <SessionAgentCatalogIdentityIcon
    agentId={agentId}
    machineId={null}
    serverId={null}
    size={ICON_SIZE.sm}
  />
);
const session = (sessionId: string): ReviewReviewerSelectionV1 => ({
  kind: 'session',
  session: { serverId: 'specimen', sessionId },
});

const FIXTURES: readonly Fixture[] = [
  {
    id: 'claude',
    category: 'session',
    name: 'Claude',
    line: 'Session · Claude on MacBook Pro · 12 m ago',
    reviewer: session('claude-review'),
    mark: agentMark('claude'),
  },
  {
    id: 'codex',
    category: 'session',
    name: 'Codex',
    line: 'Session · Codex on MacBook Pro · 40 m ago',
    reviewer: session('codex-review'),
    mark: agentMark('codex'),
  },
  {
    id: 'remount',
    category: 'session',
    name: 'Fix settings modal remount',
    line: 'Session · Claude on MacBook Pro · 2 m ago',
    reviewer: session('remount'),
    mark: agentMark('claude'),
  },
  {
    id: 'desk',
    category: 'bot',
    name: 'Release desk',
    line: 'Bot · Happier Core · runs with Happier Core’s setup',
    reviewer: session('release-desk'),
    mark: () => <Icon name="sparkle" size={ICON_SIZE.sm} />,
  },
  {
    id: 'mika',
    category: 'person',
    name: 'Mika Tanaka',
    line: 'Teammate · Happier Core',
    avatar: true,
    reviewer: {
      kind: 'person',
      principal: { kind: 'account', accountId: 'mika' },
      required: true,
    },
    mark: () => <Icon name="user" size={ICON_SIZE.sm} />,
  },
  {
    id: 'coderabbit',
    category: 'engine',
    name: 'CodeRabbit',
    line: 'Review engine · needs an API key',
    warning: 'CodeRabbit needs an API key',
    reviewer: { kind: 'engine', engineId: 'coderabbit' },
    mark: engineMark('bug'),
  },
  {
    id: 'deepsec',
    category: 'engine',
    name: 'DeepSec',
    line: 'Review engine · ready on build-01',
    reviewer: { kind: 'engine', engineId: 'deepsec' },
    mark: engineMark('shield'),
  },
];

function fixtureFor(reviewer: ReviewReviewerSelectionV1): Fixture | undefined {
  return FIXTURES.find(
    (fixture) =>
      JSON.stringify(fixture.reviewer) ===
      JSON.stringify(withoutTranscript(reviewer)),
  );
}

function withoutTranscript(
  reviewer: ReviewReviewerSelectionV1,
): ReviewReviewerSelectionV1 {
  if (reviewer.kind !== 'engine') return reviewer;
  const { includeSessionTranscript: _drop, ...rest } = reviewer;
  return rest;
}

const pick = (...ids: string[]) =>
  ids.map((id) => FIXTURES.find((fixture) => fixture.id === id)!.reviewer);
const SCENES: Readonly<Record<string, readonly ReviewStepV1[]>> = {
  sheet: [
    { kind: 'review', reviewers: pick('claude', 'codex'), instructions: '' },
    {
      kind: 'verify',
      reviewers: pick('claude', 'codex', 'remount'),
      instructions: '',
    },
  ],
  rounds: [
    {
      kind: 'review',
      reviewers: pick('coderabbit', 'deepsec', 'desk', 'codex', 'claude'),
      instructions: '',
    },
    {
      kind: 'verify',
      reviewers: pick('claude', 'codex', 'remount'),
      instructions: '',
    },
    { kind: 'review', reviewers: pick('mika'), instructions: '' },
  ],
  deep: [
    { kind: 'review', reviewers: pick('claude', 'deepsec'), instructions: '' },
    {
      kind: 'verify',
      reviewers: pick('claude', 'codex', 'remount'),
      instructions: '',
    },
  ],
};

const ADMISSIBLE: ContextualStartAdmissibleSet = {
  who: ['session', 'bot', 'person', 'engine'],
  machine: 'fixed',
  folder: 'fixed',
};

function present(
  reviewer: ReviewReviewerSelectionV1,
): ReviewStartReviewerPresentation {
  const fixture = fixtureFor(reviewer);
  return {
    name: fixture?.name ?? reviewer.kind,
    mark: fixture?.mark() ?? null,
    avatar: fixture?.avatar === true,
    warning: fixture?.warning ?? null,
  };
}

/** One step's Who list: the shared composer over fixture rows, its checks bound to the step's reviewers. */
function SpecimenWho(
  props: Readonly<{
    step: ReviewStepV1;
    onToggle: (reviewer: ReviewReviewerSelectionV1) => void;
  }>,
) {
  const [query, setQuery] = React.useState('');
  const { step, onToggle } = props;
  const source = React.useMemo<ContextualStartSource>(() => {
    const selected = new Set(
      step.reviewers
        .map((reviewer) => fixtureFor(reviewer)?.id)
        .filter((id): id is string => id !== undefined),
    );
    const option = (fixture: Fixture): SelectionListOption => ({
      id: fixture.id,
      label: fixture.name,
      subtitle: fixture.line,
      icon: fixture.mark(),
      onSelect: () => onToggle(fixture.reviewer),
    });
    const section = (category: Fixture['category']) => ({
      category,
      section: {
        kind: 'static' as const,
        id: `specimen-${category}`,
        options: FIXTURES.filter(
          (fixture) =>
            fixture.category === category &&
            (!query ||
              fixture.name.toLowerCase().includes(query.toLowerCase())),
        ).map(option),
      },
    });
    return {
      enabled: true,
      sections: [
        section('session'),
        section('bot'),
        section('person'),
        section('engine'),
      ],
      selectedIds: selected,
      search: { value: query, onChange: setQuery },
      where: null,
    };
  }, [onToggle, query, step.reviewers]);
  const model = useContextualStartComposer(source, ADMISSIBLE);
  return (
    <ContextualStartComposerBody
      model={model}
      whoLabel={t('reviewWalkthrough.start.whoReviews')}
      question={null}
    />
  );
}

export function ReviewStartSpecimen(props: Readonly<{ scene: string | null }>) {
  const { width } = useWindowDimensions();
  const phone = width < 600;
  const scene = props.scene && SCENES[props.scene] ? props.scene : 'sheet';
  const [steps, setSteps] = React.useState<readonly ReviewStepV1[]>(
    SCENES[scene]!,
  );
  const [then, setThen] = React.useState<'report' | 'fix'>('report');
  const [walkthrough, setWalkthrough] = React.useState(false);
  const [accepted, setAccepted] = React.useState(false);
  const latest = React.useRef(steps);
  latest.current = steps;
  const toggleReviewer = React.useCallback(
    (stepIndex: number, reviewer: ReviewReviewerSelectionV1) => {
      setSteps(
        latest.current.map((step, index) => {
          if (index !== stepIndex) return step;
          const key = JSON.stringify(reviewer);
          const has = step.reviewers.some(
            (entry) => JSON.stringify(withoutTranscript(entry)) === key,
          );
          return {
            ...step,
            reviewers: has
              ? step.reviewers.filter(
                  (entry) => JSON.stringify(withoutTranscript(entry)) !== key,
                )
              : [...step.reviewers, reviewer],
          };
        }),
      );
    },
    [],
  );
  const renderWho = React.useCallback(
    (stepIndex: number) => (
      <SpecimenWho
        step={latest.current[stepIndex]!}
        onToggle={(reviewer) => toggleReviewer(stepIndex, reviewer)}
      />
    ),
    [toggleReviewer],
  );
  const hasDeepSec = steps.some((step) =>
    step.reviewers.some(
      (reviewer) =>
        reviewer.kind === 'engine' && reviewer.engineId === 'deepsec',
    ),
  );

  return (
    <ScrollView
      testID="review-start-specimen"
      style={styles.root}
      contentContainerStyle={phone ? styles.contentPhone : styles.content}
    >
      <View style={[styles.sheet, phone ? styles.sheetPhone : null]}>
        <ReviewStartSteps
          steps={steps}
          onStepsChange={setSteps}
          presentReviewer={present}
          renderWho={renderWho}
          transcriptAvailable
        />
        <ReviewStartOptions
          then={then}
          onThenChange={setThen}
          walkthrough={walkthrough}
          onWalkthroughChange={setWalkthrough}
          cost={
            scene === 'deep' && hasDeepSec
              ? {
                  engine: 'DeepSec',
                  estimate: '$4.80',
                  accepted,
                  onAcceptedChange: setAccepted,
                }
              : null
          }
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.surface.inset },
  content: { padding: theme.space.s24, alignItems: 'center' },
  contentPhone: { padding: 0 },
  sheet: {
    width: 600,
    maxWidth: '100%',
    borderRadius: theme.parts.codeBlock.radius,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.default,
    backgroundColor: theme.colors.surface.base,
    paddingHorizontal: theme.space.s20,
    paddingVertical: theme.space.s12,
  },
  sheetPhone: { width: '100%', borderRadius: 0, borderWidth: 0 },
}));
