import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  create as createRenderer,
  type ReactTestRenderer,
} from 'react-test-renderer';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock();
});

import type { SelectionListDynamicSection } from '@/components/ui/selectionList';
import { createDefaultDynamicSectionCache } from '@/components/ui/selectionList/selectionListDynamicSectionCache';
import {
  synthesizeSelectionListRenderPlan,
  type SectionRenderPlan,
} from '@/components/ui/selectionList/SelectionListRenderPlan';
import { useSelectionListDynamicSections } from '@/components/ui/selectionList/useSelectionListDynamicSections';

import {
  buildUniversalSearchSections,
  type BuildUniversalSearchSectionsInput,
} from './buildUniversalSearchSections';

/**
 * The palette's typed-query presentation, exercised through the real descriptors, the
 * dynamic-sections owner and the render plan. Every committed render is one plan state.
 */

const APPEARANCE = {
  id: 'appearance',
  route: '/settings/appearance',
  title: 'Appearance',
};
const THEMES = { id: 'themes', route: '/settings/themes', title: 'Themes' };

function searchSettings(query: string) {
  if (query.startsWith('ap')) return [APPEARANCE];
  if (query.startsWith('th')) return [THEMES];
  return [];
}

type PlanCommit = Readonly<{
  query: string;
  plan: ReadonlyArray<SectionRenderPlan>;
}>;

type HostProps = Readonly<{
  query: string;
  settingsSearchRevision?: number;
  searchSettingsPages?: BuildUniversalSearchSectionsInput['searchSettingsPages'];
  transcript?: BuildUniversalSearchSectionsInput['transcript'];
  onCommit: (commit: PlanCommit) => void;
}>;

let cache = createDefaultDynamicSectionCache();

function Host(props: HostProps): null {
  const sections = React.useMemo(
    () =>
      buildUniversalSearchSections({
        query: props.query,
        commands: [],
        sessions: [],
        projects: [],
        searchSettingsPages: props.searchSettingsPages ?? searchSettings,
        settingsSearchRevision: props.settingsSearchRevision,
        transcript: props.transcript ?? { status: 'absent' },
        files: { status: 'absent' },
        commits: { status: 'absent' },
        pluginSections: [],
        onCommitResult: () => {},
      }),
    [
      props.query,
      props.settingsSearchRevision,
      props.searchSettingsPages,
      props.transcript,
    ],
  );
  const dynamic = sections.filter(
    (
      section,
    ): section is Extract<typeof section, { kind: 'dynamic' }> &
      SelectionListDynamicSection => section.kind === 'dynamic',
  );
  const states = useSelectionListDynamicSections({
    dynamicSections: dynamic,
    inputValue: props.query,
    cache,
  });
  const plan = synthesizeSelectionListRenderPlan({
    sections,
    inputValue: props.query,
    filterQuery: props.query,
    dynamicSectionStates: states,
  });
  React.useEffect(() => {
    props.onCommit({ query: props.query, plan });
  });
  return null;
}

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = null;
});

async function typeQueries(
  queries: readonly string[],
  extra: Omit<HostProps, 'query' | 'onCommit'> = {},
): Promise<PlanCommit[]> {
  const commits: PlanCommit[] = [];
  const onCommit = (commit: PlanCommit) => {
    commits.push(commit);
  };
  for (const query of queries) {
    await act(async () => {
      if (renderer)
        renderer.update(<Host query={query} onCommit={onCommit} {...extra} />);
      else
        renderer = createRenderer(
          <Host query={query} onCommit={onCommit} {...extra} />,
        );
    });
  }
  return commits;
}

const settingsOf = (commit: PlanCommit) =>
  commit.plan.find((section) => section.id === 'settings');
const optionIds = (commit: PlanCommit) =>
  settingsOf(commit)?.options.map((option) => option.id.split('::').pop()) ?? [];
const isEmptyGroup = (section: SectionRenderPlan | undefined) =>
  section !== undefined &&
  section.options.length === 0 &&
  !section.hint &&
  !section.resultHint;

describe('Universal Search typed-query continuity', () => {
  it('keeps the Settings rows on screen while a refined matching query resolves', async () => {
    const commits = await typeQueries(['ap', 'app', 'appe', 'appea', 'appear']);

    const firstSettled = commits.findIndex((commit) =>
      optionIds(commit).includes('appearance'),
    );
    expect(firstSettled).toBeGreaterThanOrEqual(0);
    const afterwards = commits.slice(firstSettled);
    expect(
      afterwards.filter((commit) => settingsOf(commit) === undefined),
    ).toHaveLength(0);
    expect(
      afterwards.filter((commit) => isEmptyGroup(settingsOf(commit))),
    ).toHaveLength(0);
    expect(optionIds(commits[commits.length - 1]!)).toEqual(['appearance']);
  });

  it('shows no Settings rows for an unrelated query while it resolves', async () => {
    const commits = await typeQueries(['appear', 'theme']);

    const themeCommits = commits.filter((commit) => commit.query === 'theme');
    expect(themeCommits.length).toBeGreaterThan(0);
    for (const commit of themeCommits)
      expect(optionIds(commit)).not.toContain('appearance');
    expect(optionIds(themeCommits[themeCommits.length - 1]!)).toEqual([
      'themes',
    ]);
  });

  it('drops the rows when the refined query settles with no match, with no empty header', async () => {
    const commits = await typeQueries(['appear', 'appearzz'], {
      searchSettingsPages: (query) => (query === 'appear' ? [APPEARANCE] : []),
    });

    const last = commits[commits.length - 1]!;
    expect(settingsOf(last)).toBeUndefined();
    expect(
      commits.filter((commit) => isEmptyGroup(settingsOf(commit))),
    ).toHaveLength(0);
  });

  it('never shows a Settings group for a query with no match', async () => {
    const commits = await typeQueries(['z', 'zz', 'zzq']);

    expect(
      commits.filter(
        (commit) => commit.query !== 'z' && settingsOf(commit) !== undefined,
      ),
    ).toHaveLength(0);
  });

  it('shows no rows after the query is cleared and retyped before the catalog answers', async () => {
    const commits = await typeQueries(['appear', '', 'app']);

    const cleared = commits.filter((commit) => commit.query === '');
    expect(cleared.every((commit) => settingsOf(commit) === undefined)).toBe(
      true,
    );
    const firstRetyped = commits.findIndex(
      (commit, index) =>
        index > 0 &&
        commits[index - 1]!.query === '' &&
        commit.query === 'app',
    );
    expect(firstRetyped).toBeGreaterThan(0);
    expect(settingsOf(commits[firstRetyped]!)).toBeUndefined();
  });

  it('removes a row the catalog withdrew in the commit that carries the new catalog revision', async () => {
    const commits: PlanCommit[] = [];
    const onCommit = (commit: PlanCommit) => {
      commits.push(commit);
    };
    const catalog: { pages: ReturnType<typeof searchSettings> } = {
      pages: [APPEARANCE],
    };
    const searchSettingsPages = () => catalog.pages;
    await act(async () => {
      renderer = createRenderer(
        <Host
          query="appear"
          settingsSearchRevision={1}
          searchSettingsPages={searchSettingsPages}
          onCommit={onCommit}
        />,
      );
    });
    expect(optionIds(commits[commits.length - 1]!)).toEqual(['appearance']);

    catalog.pages = [];
    const before = commits.length;
    await act(async () => {
      renderer!.update(
        <Host
          query="appear"
          settingsSearchRevision={2}
          searchSettingsPages={searchSettingsPages}
          onCommit={onCommit}
        />,
      );
    });
    const after = commits.slice(before);
    expect(after.length).toBeGreaterThan(0);
    for (const commit of after) expect(optionIds(commit)).toEqual([]);
  });

  it("keeps a source's availability line across refined queries instead of an empty group", async () => {
    const transcript = {
      status: 'unavailable' as const,
      resolverKey: 'home-a|indexing',
      hint: 'Still indexing',
    };
    const commits = await typeQueries(
      ['ap', 'app', 'appe', 'appea', 'appear'],
      { transcript },
    );

    const hasLine = (commit: PlanCommit) =>
      commit.plan.find((section) => section.id === 'transcript')?.hint ===
      'Still indexing';
    const firstLine = commits.findIndex(hasLine);
    expect(firstLine).toBeGreaterThanOrEqual(0);
    const afterwards = commits.slice(firstLine);
    expect(afterwards.filter((commit) => !hasLine(commit))).toHaveLength(0);
  });
});
