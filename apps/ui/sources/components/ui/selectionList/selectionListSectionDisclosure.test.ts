import { describe, expect, it, vi } from 'vitest';

import { synthesizeSelectionListRenderPlan } from './SelectionListRenderPlan';
import { resolveSelectionListSectionColumnCount } from './selectionListGridGeometry';
import { isSelectionListSingleColumnSection } from './selectionListSectionDisclosure';
import type {
  SelectionListOption,
  SelectionListSectionDescriptor,
} from './_types';

const option = (id: string, label: string): SelectionListOption => ({
  id,
  label,
});
const sections: ReadonlyArray<SelectionListSectionDescriptor> = [
  { kind: 'static', id: 'models', options: [option('a', 'Model A')] },
  {
    kind: 'static',
    id: 'unavailable',
    title: 'Unavailable (2)',
    collapsible: true,
    options: [option('x', 'Muse'), option('y', 'Sonnet pool')],
  },
];

function plan(open: boolean, query = '') {
  const onToggle = vi.fn();
  const result = synthesizeSelectionListRenderPlan({
    sections,
    inputValue: query,
    filterQuery: query,
    dynamicSectionStates: new Map(),
    sectionDisclosures: () => ({ open, onToggle }),
  });
  const unavailable = result.find((section) => section.id === 'unavailable');
  return { unavailable, onToggle };
}

describe('collapsible SelectionList sections (owner 11-16)', () => {
  it('reads as one closed disclosure row until pressed', () => {
    const { unavailable, onToggle } = plan(false);
    const rows =
      unavailable && 'options' in unavailable ? unavailable.options : [];
    expect(rows.map((row) => row.label)).toEqual(['Unavailable (2)']);
    expect(rows[0]).toMatchObject({ disclosure: true });
    rows[0]?.onSelect?.();
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(unavailable?.title).toBeUndefined();
  });

  it('lists its rows under the open disclosure in one column', () => {
    const { unavailable } = plan(true);
    const rows =
      unavailable && 'options' in unavailable ? unavailable.options : [];
    expect(rows.map((row) => row.label)).toEqual([
      'Unavailable (2)',
      'Muse',
      'Sonnet pool',
    ]);
    expect(isSelectionListSingleColumnSection(rows)).toBe(true);
    expect(
      resolveSelectionListSectionColumnCount(
        rows.length,
        2,
        isSelectionListSingleColumnSection(rows),
      ),
    ).toBe(1);
    expect(resolveSelectionListSectionColumnCount(3, 2)).toBe(2);
  });

  it('shows matches whether open or not while searching', () => {
    const { unavailable } = plan(false, 'muse');
    const rows =
      unavailable && 'options' in unavailable ? unavailable.options : [];
    expect(rows.map((row) => row.label)).toEqual(['Muse']);
  });
});
