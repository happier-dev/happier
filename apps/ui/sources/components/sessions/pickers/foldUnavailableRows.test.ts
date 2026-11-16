import { describe, expect, it } from 'vitest';

import { foldUnavailableRows } from './foldUnavailableRows';
import { filterSelectionListSections } from '@/components/ui/selectionList/filterSelectionListSections';
import type { SelectionListOption, SelectionListSectionDescriptor } from '@/components/ui/selectionList/_types';
type SelectionListStaticSection = Extract<SelectionListSectionDescriptor, { kind: 'static' }>;

type Row = Readonly<{ id: string; unavailable?: boolean }>;
type Section = Readonly<{
  id: string;
  title?: string;
  options: readonly Row[];
}>;

describe('foldUnavailableRows', () => {
  // A reason several rows share ("Broker offline") is their group's heading, said once, not on each row.
  it('heads rows that share one reason with that reason and keeps the rest in the counted group', () => {
    type ReasonRow = Readonly<{ id: string; reason?: string; shared?: boolean }>;
    const folded = foldUnavailableRows<ReasonRow, Readonly<{ id: string; title?: string; options: readonly ReasonRow[] }>>({
      sections: [{ id: 'team', options: [
        { id: 'a', reason: 'Broker offline' }, { id: 'ok' }, { id: 'b', reason: 'Broker offline' }, { id: 'c', reason: 'Source removed' },
      ] }],
      isUnavailable: row => row.reason !== undefined,
      reason: row => row.reason,
      group: (options, title) => ({ id: `unavailable:${title}`, title, options }),
      title: 'Unavailable',
      present: (row, _section, shared) => ({ ...row, shared }),
    });
    expect(folded.map(section => section.title ?? section.id)).toEqual(['team', 'Broker offline (2)', 'Unavailable (1)']);
    expect(folded[1]!.options).toEqual([{ id: 'a', reason: 'Broker offline', shared: true }, { id: 'b', reason: 'Broker offline', shared: true }]);
    expect(folded[2]!.options).toEqual([{ id: 'c', reason: 'Source removed', shared: false }]);
  });
  it('preserves a selected unavailable search match across sections after a cold inventory arrives', () => {
    const selected = { id: 'selected', label: 'Shared model', disabled: true } satisfies SelectionListOption;
    const fold = (sections: readonly SelectionListStaticSection[]) => foldUnavailableRows<SelectionListOption, SelectionListStaticSection>({
      sections, isUnavailable: row => row.disabled === true,
      group: (options, title) => ({ kind: 'static', id: 'unavailable', title, options }), title: 'Unavailable',
    });
    expect(fold([])).toEqual([]); // This pure owner has no loading/ready authority.
    const settled = fold([
      { kind: 'static', id: 'own', options: [{ id: 'own', label: 'Own model' }, { id: 'other', label: 'Other', disabled: true }] },
      { kind: 'static', id: 'team', options: [selected] },
      { kind: 'static', id: 'native', options: [{ id: 'native', label: 'Native model' }] },
    ]);
    expect(settled.map(section => section.id)).toEqual(['own', 'native', 'unavailable']);
    const matches = filterSelectionListSections(settled, 'SHARED');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ id: 'unavailable', options: [selected] });
    const group = settled.at(-1)!;
    expect(group.options.find(row => row.id === selected.id)).toBe(selected);
    expect(filterSelectionListSections(settled, '')).toBe(settled);
  });
  it('moves every unusable row into one trailing counted group and drops sections it empties', () => {
    const sections: Section[] = [
      {
        id: 'team-a',
        title: 'Team A',
        options: [{ id: 'a1', unavailable: true }],
      },
      {
        id: 'native',
        title: 'Built-in',
        options: [{ id: 'n1' }, { id: 'n2', unavailable: true }],
      },
      {
        id: 'team-b',
        title: 'Team B',
        options: [{ id: 'b1', unavailable: true }],
      },
    ];

    const folded = foldUnavailableRows<Row, Section>({
      sections,
      isUnavailable: (row) => row.unavailable === true,
      group: (options, title) => ({ id: 'unavailable', title, options }),
      title: 'Unavailable',
      present: (row, section) => ({ ...row, id: `${section.id}:${row.id}` }),
    });

    expect(
      folded.map((section) => [
        section.id,
        section.title,
        section.options.map((row) => row.id),
      ]),
    ).toEqual([
      ['native', 'Built-in', ['n1']],
      [
        'unavailable',
        'Unavailable (3)',
        ['team-a:a1', 'native:n2', 'team-b:b1'],
      ],
    ]);
  });

  it('returns the sections themselves when every row is usable', () => {
    const sections: Section[] = [{ id: 'native', options: [{ id: 'n1' }] }];
    const folded = foldUnavailableRows<Row, Section>({
      sections,
      isUnavailable: () => false,
      group: (options, title) => ({ id: 'x', title, options }),
      title: 'Unavailable',
    });
    expect(folded[0]).toBe(sections[0]);
    expect(folded).toHaveLength(1);
  });
});
