import { describe, expect, it } from 'vitest';
import type { SelectionListOption, SelectionListSectionDescriptor } from '@/components/ui/selectionList';
import { foldOfflineWorkers } from './foldOfflineWorkers';
import { rankOptionsByQuery } from '@/components/ui/selectionList/SelectionListRenderPlan';

const option = (id: string, disabled = false): SelectionListOption => ({ id, label: id, disabled, onSelect: () => {} });
const section = (options: SelectionListOption[]): SelectionListSectionDescriptor => ({ kind: 'static', id: 'workers', title: 'Workers', options });
const copy = (open = false) => () => ({ label: (count: number) => `${count} offline`, detail: 'Not reachable right now', open, onToggle: () => {}, icon: null, accessory: null });
const offline = (...ids: string[]) => (candidate: SelectionListOption) => ids.includes(candidate.id) && candidate.disabled === true;

const optionsOf = (result: SelectionListSectionDescriptor[]) =>
  result.flatMap((s) => (s.kind === 'static' ? s.options : []));

describe('foldOfflineWorkers', () => {
  it('keeps a folded group discoverable by the names the SelectionList search hides', () => {
    const input = [section([option('studio', true), option('server', true)])];
    expect(rankOptionsByQuery(optionsOf(foldOfflineWorkers(input, offline('studio', 'server'), copy())), 'studio')
      .map(row => row.id)).toEqual(['offline:workers']);
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
