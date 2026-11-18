import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import {
  SelectionList,
  type SelectionListOption,
} from '@/components/ui/selectionList';
import {
  ContextualStartComposerBody,
  useContextualStartComposer,
  type ContextualStartAdmissibleSet,
  type ContextualStartSource,
} from './ContextualStartComposer';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);

const ADMISSIBLE: ContextualStartAdmissibleSet = {
  who: ['newAgent', 'session', 'bot', 'person'],
  machine: 'fixed',
  folder: 'fixed',
};

function options(prefix: string, count: number): SelectionListOption[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}:${index}`,
    label: `${prefix} ${index}`,
    onSelect: () => undefined,
  }));
}

function source(
  input: Readonly<{
    models: number;
    sessions: number;
    bots: number;
    selected?: readonly string[];
  }>,
): ContextualStartSource {
  return {
    enabled: true,
    sections: [
      {
        category: 'person',
        section: { kind: 'static', id: 'people', title: 'People', options: [] },
      },
      {
        category: 'newAgent',
        section: {
          kind: 'static',
          id: 'agents-models',
          options: options('model', input.models),
        },
      },
      {
        category: 'session',
        section: {
          kind: 'static',
          id: 'agents-sessions',
          options: options('session', input.sessions),
        },
      },
      {
        category: 'bot',
        section: { kind: 'static', id: 'agents-bots', options: options('bot', input.bots) },
      },
    ],
    selectedIds: new Set(input.selected ?? []),
    where: null,
  };
}

function Composer(props: Readonly<{ source: ContextualStartSource }>) {
  const model = useContextualStartComposer(props.source, ADMISSIBLE);
  return <ContextualStartComposerBody model={model} />;
}

function shownIds(screen: Awaited<ReturnType<typeof renderScreen>>): string[] {
  const list = screen
    .findAllByType(SelectionList)
    .find((node) => node.props.testID === 'contextual-start-who')!;
  return (
    list.props.rootStep.sections as Array<{
      id: string;
      options?: SelectionListOption[];
    }>
  ).flatMap((section) =>
    section.id === 'people'
      ? ['people']
      : (section.options ?? []).map((option) => option.id),
  );
}

describe('ContextualStartComposerBody Who list (lab flows `ask`)', () => {
  it('keeps selected dynamic people editable beside a selected Session', async () => {
    function MixedWho() {
      const [aliceSelected, setAliceSelected] = React.useState(true);
      const base = source({ models: 0, sessions: 1, bots: 0,
        selected: ['session:0', ...(aliceSelected ? ['account:alice'] : [])] });
      const current: ContextualStartSource = { ...base, sections: [{ category: 'person', section: { kind: 'dynamic', id: 'people',
        resolverKey: 'home-people', resolve: async () => ({ options: [
          { id: 'account:alice', testID: 'chosen-person-alice', label: 'Alice', onSelect: () => setAliceSelected(false) },
          { id: 'account:bob', label: 'Bob', onSelect: () => undefined },
        ] }) } }, ...base.sections.slice(1)] };
      return <Composer source={current} />;
    }
    const screen = await renderScreen(<MixedWho />);
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('Alice'));
    expect(screen.getTextContent()).toContain('session 0');
    expect(screen.getTextContent()).not.toContain('Bob');
    await screen.pressByTestIdAsync('chosen-person-alice');
    await vi.waitFor(() => expect(screen.getTextContent()).not.toContain('Alice'));
    expect(screen.getTextContent()).toContain('session 0');
    await screen.unmount();
  });

  it('keeps chosen agents collapsed above the question until Change is pressed', async () => {
    const screen = await renderScreen(<Composer source={source({ models: 3, sessions: 1, bots: 0, selected: ['model:1'] })} />);
    expect(screen.getTextContent()).toContain('model 1');
    expect(screen.getTextContent()).not.toContain('model 0');
    expect(screen.getTextContent()).not.toContain('model 2');
    await screen.pressByTestIdAsync('contextual-start-change-who');
    expect(screen.getTextContent()).toContain('model 0');
    expect(screen.getTextContent()).toContain('model 2');
    await screen.pressByTestIdAsync('contextual-start-done-who');
    expect(screen.getTextContent()).not.toContain('model 0');
    expect(screen.getTextContent()).not.toContain('model 2');
    await screen.unmount();
  });
  it('folds a long list to mixed top picks with what is chosen first, then opens everything and people on Show all', async () => {
    const screen = await renderScreen(
      <Composer
        source={source({
          models: 3,
          sessions: 6,
          bots: 2,
          selected: ['session:4'],
        })}
      />,
    );
    await screen.pressByTestIdAsync('contextual-start-change-who');
    expect(shownIds(screen)).toEqual([
      'session:4',
      'model:0',
      'model:1',
      'bot:0',
      'who:show-all',
    ]);
    await screen.pressByTestIdAsync('second-opinion.reviewers-more');
    expect(shownIds(screen)).toEqual([
      'model:0',
      'model:1',
      'model:2',
      ...options('session', 6).map((option) => option.id),
      'bot:0',
      'bot:1',
      'people',
    ]);
    await screen.unmount();
  });

  it('fills an absent kind from the next candidates and shows a short list whole with people after it', async () => {
    const long = await renderScreen(
      <Composer source={source({ models: 1, sessions: 6, bots: 0 })} />,
    );
    expect(shownIds(long)).toEqual([
      'model:0',
      'session:0',
      'session:1',
      'session:2',
      'who:show-all',
    ]);
    await long.unmount();
    const short = await renderScreen(
      <Composer source={source({ models: 2, sessions: 1, bots: 1 })} />,
    );
    expect(shownIds(short)).toEqual([
      'model:0',
      'model:1',
      'session:0',
      'bot:0',
      'people',
    ]);
    await short.unmount();
  });

  it('narrows to one kind from its filter chip, whole, and All brings the mixed list back (lab dpRev)', async () => {
    // The chips sit beneath the Who search, which the host supplies.
    const searchable = { ...source({ models: 3, sessions: 6, bots: 2 }), search: { value: '', onChange: () => undefined } };
    const screen = await renderScreen(<Composer source={searchable} />);
    await screen.pressByTestIdAsync('contextual-start-who-filter:bot');
    expect(shownIds(screen)).toEqual(['bot:0', 'bot:1']);
    await screen.pressByTestIdAsync('contextual-start-who-filter:session');
    expect(shownIds(screen)).toEqual(options('session', 6).map((option) => option.id));
    await screen.pressByTestIdAsync('contextual-start-who-filter:all');
    expect(shownIds(screen)).toContain('who:show-all');
    await screen.unmount();
  });

  it('searches every row instead of the folded picks', async () => {
    const searched = { ...source({ models: 3, sessions: 6, bots: 2 }), search: { value: 'session 5', onChange: () => undefined } };
    const screen = await renderScreen(<Composer source={searched} />);
    expect(shownIds(screen)).toContain('session:5');
    expect(shownIds(screen)).not.toContain('who:show-all');
    await screen.unmount();
  });
});
