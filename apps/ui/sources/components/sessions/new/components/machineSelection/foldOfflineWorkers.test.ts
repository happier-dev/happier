import { describe, expect, it } from 'vitest';
import type { SelectionListOption, SelectionListSectionDescriptor } from '@/components/ui/selectionList';
import { foldOfflineWorkers } from './foldOfflineWorkers';
import { synthesizeSelectionListRenderPlan } from '@/components/ui/selectionList/SelectionListRenderPlan';

const option = (id: string, disabled = false): SelectionListOption => ({ id, label: id, disabled, onSelect: () => {} });
const section = (options: SelectionListOption[]): SelectionListSectionDescriptor => ({ kind: 'static', id: 'workers', title: 'Workers', options });
const copy = (open = false) => () => ({ label: (count: number) => `${count} offline`, detail: 'Not reachable right now', open, onToggle: () => {}, icon: null, accessory: null });
const offline = (...ids: string[]) => (candidate: SelectionListOption) => ids.includes(candidate.id) && candidate.disabled === true;

const optionsOf = (result: SelectionListSectionDescriptor[]) =>
  result.flatMap((s) => (s.kind === 'static' ? s.options : []));

describe('foldOfflineWorkers', () => {
  it.each([false, true])('shows matching offline rows beneath their own fold in each section while open=%s', open => {
    const input = [section([option('studio', true), option('server', true)]), {
      ...section([option('shared studio', true), option('shared server', true)]), id: 'shared', title: 'Shared',
    }];
    const folded = foldOfflineWorkers(input, offline('studio', 'server', 'shared studio', 'shared server'), copy(open));
    const search = (query: string) => synthesizeSelectionListRenderPlan({ sections: folded,
      inputValue: query, filterQuery: query, dynamicSectionStates: new Map() });
    expect(search('studio').map(row => ({ id: row.id, options: row.options.map(option => option.id) })))
      .toEqual([{ id: 'workers', options: ['offline:workers', 'studio'] },
        { id: 'shared', options: ['offline:shared', 'shared studio'] }]);
    expect(search('no match')).toEqual([]);
    expect(search('').flatMap(row => row.options.map(option => option.id)))
      .toEqual(open ? ['offline:workers', 'studio', 'server', 'offline:shared', 'shared studio', 'shared server']
        : ['offline:workers', 'offline:shared']);
  });
  it('folds several offline workers into one row that lists them in place when open, keeping reachable workers in place', () => {
    const input = [section([option('a', true), option('free'), option('b', true), option('c', true)])];
    const closed = optionsOf(foldOfflineWorkers(input, offline('a', 'b', 'c'), copy()));
    expect(closed.map((row) => row.id)).toEqual(['free', 'offline:workers']);
    expect(closed[1]!.label).toBe('3 offline');
    expect(optionsOf(foldOfflineWorkers(input, offline('a', 'b', 'c'), copy(true))).map((row) => row.id))
      .toEqual(['free', 'offline:workers', 'a', 'b', 'c']);
  });

  it('leaves a lone offline worker as its own named row', () => {
    const input = [section([option('free'), option('studio', true)])];
    expect(optionsOf(foldOfflineWorkers(input, offline('studio'), copy())).map((row) => row.id)).toEqual(['free', 'studio']);
  });

  it('does not fold a worker that is disabled for another reason', () => {
    const input = [section([option('small', true), option('a', true), option('b', true)])];
    expect(optionsOf(foldOfflineWorkers(input, offline('a', 'b'), copy())).map((row) => row.id)).toEqual(['small', 'offline:workers']);
  });
});
