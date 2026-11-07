import { describe, expect, it } from 'vitest';

import { foldUnavailableRows } from './foldUnavailableRows';

type Row = Readonly<{ id: string; unavailable?: boolean }>;
type Section = Readonly<{
  id: string;
  title?: string;
  options: readonly Row[];
}>;

describe('foldUnavailableRows', () => {
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
