import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  act,
  create as createRenderer,
  type ReactTestRenderer,
} from 'react-test-renderer';

import { createDefaultDynamicSectionCache } from '../selectionListDynamicSectionCache';
import { useSelectionListDynamicSections } from '../useSelectionListDynamicSections';
import type {
  SelectionListDynamicSection,
  SelectionListOption,
} from '../_types';

type Result = {
  options: ReadonlyArray<SelectionListOption>;
  emptyHint?: string;
};
type Pending = {
  seed: string;
  resolve: (result: Result) => void;
  reject: (error: Error) => void;
};

const rows = (...ids: string[]): ReadonlyArray<SelectionListOption> =>
  ids.map((id) => ({ id, label: id }));

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = null;
});

/** A section whose resolver stays pending until the test settles that seed. */
function harness(sectionPatch: Partial<SelectionListDynamicSection> = {}) {
  const pending: Pending[] = [];
  const section: SelectionListDynamicSection = {
    id: 'results',
    debounceMs: 0,
    resultTransition: 'none',
    resolve: (seed) =>
      new Promise<Result>((resolve, reject) => {
        pending.push({ seed, resolve, reject });
      }),
    ...sectionPatch,
  };
  const cache = createDefaultDynamicSectionCache();
  const seen: Array<ReturnType<typeof useSelectionListDynamicSections>> = [];
  function Host(props: {
    query: string;
    section?: SelectionListDynamicSection;
  }): null {
    const states = useSelectionListDynamicSections({
      dynamicSections: [props.section ?? section],
      inputValue: props.query,
      cache,
    });
    React.useEffect(() => {
      seen.push(states);
    });
    return null;
  }
  const type = async (
    query: string,
    nextSection?: SelectionListDynamicSection,
  ) =>
    act(async () => {
      const element = <Host query={query} section={nextSection} />;
      if (renderer) renderer.update(element);
      else renderer = createRenderer(element);
    });
  const settle = async (seed: string, result: Result) =>
    act(async () => {
      pending.find((request) => request.seed === seed)!.resolve(result);
    });
  const shown = () => {
    const state = seen[seen.length - 1]!.get('results')!;
    const visible =
      state.status === 'loading'
        ? (state.lastSuccessOptions ?? [])
        : state.options;
    return {
      status: state.status,
      ids: visible.map((option) => option.id),
      emptyHint: state.emptyHint,
    };
  };
  return { type, settle, shown, pending, section };
}

describe('useSelectionListDynamicSections - refining a settled query', () => {
  it('keeps the settled rows while a refinement resolves, then replaces them', async () => {
    const h = harness();
    await h.type('ap');
    await h.settle('ap', { options: rows('a1', 'a2') });
    await h.type('app');
    expect(h.shown().ids).toEqual(['a1', 'a2']);
    await h.type('appe');
    expect(h.shown().ids).toEqual(['a1', 'a2']);
    await h.settle('appe', { options: rows('b1') });
    expect(h.shown()).toMatchObject({ status: 'success', ids: ['b1'] });
  });

  it('keeps the settled status line across a refinement when the result had no rows', async () => {
    const h = harness();
    await h.type('ap');
    await h.settle('ap', { options: [], emptyHint: 'Still indexing' });
    await h.type('app');
    expect(h.shown()).toMatchObject({ ids: [], emptyHint: 'Still indexing' });
  });

  it('also keeps them when the query is shortened', async () => {
    const h = harness();
    await h.type('app');
    await h.settle('app', { options: rows('a1') });
    await h.type('ap');
    expect(h.shown().ids).toEqual(['a1']);
  });

  it('shows no prior rows for an unrelated query', async () => {
    const h = harness();
    await h.type('appear');
    await h.settle('appear', { options: rows('a1') });
    await h.type('theme');
    expect(h.shown()).toMatchObject({ status: 'loading', ids: [] });
  });

  it('drops the prior rows when a refinement settles empty', async () => {
    const h = harness();
    await h.type('ap');
    await h.settle('ap', { options: rows('a1') });
    await h.type('apz');
    await h.settle('apz', { options: [] });
    expect(h.shown()).toMatchObject({ status: 'success', ids: [] });
  });

  it('does not carry the prior rows under a failed refinement', async () => {
    const h = harness();
    await h.type('ap');
    await h.settle('ap', { options: rows('a1') });
    await h.type('app');
    await act(async () => {
      h.pending
        .find((request) => request.seed === 'app')!
        .reject(new Error('down'));
    });
    expect(h.shown()).toMatchObject({ status: 'error', ids: [] });
  });

  it("drops a superseded refinement's late answer and shows nothing from the older query", async () => {
    const h = harness();
    await h.type('ap');
    await h.settle('ap', { options: rows('a1') });
    await h.type('app');
    await h.type('zzz');
    await h.settle('app', { options: rows('late') });
    expect(h.shown()).toMatchObject({ status: 'loading', ids: [] });
  });

  it("shows no prior rows once the section's target changes, even for the same query", async () => {
    const h = harness({ resolverKey: 'catalog-1' });
    await h.type('ap');
    await h.settle('ap', { options: rows('a1') });
    await h.type('ap', { ...h.section, resolverKey: 'catalog-2' });
    expect(h.shown().ids).toEqual([]);
  });

  it('keeps the default behaviour for sections that drill: prior-seed rows are never shown', async () => {
    const h = harness({ resultTransition: undefined });
    await h.type('/a');
    await h.settle('/a', { options: rows('a1') });
    await h.type('/a/b');
    expect(h.shown()).toMatchObject({ status: 'loading', ids: [] });
  });
});
