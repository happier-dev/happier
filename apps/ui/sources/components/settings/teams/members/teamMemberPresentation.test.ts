import { describe, expect, it } from 'vitest';

import { teamMembershipFixture } from '@/dev/testkit/fixtures/teamFixtures';

import {
  resolveTeamMemberManagementChoices,
  teamMemberRemovalLines,
} from './teamMemberPresentation';

describe('teamMemberRemovalLines', () => {
  it('names the Groups the person leaves, and says nothing about Groups when there are none', () => {
    const withGroups = teamMemberRemovalLines({
      groupNames: ['Engineering', 'Platform on-call'],
      moreGroups: false,
    });
    const withoutGroups = teamMemberRemovalLines({
      groupNames: [],
      moreGroups: false,
    });
    expect(withGroups).toHaveLength(withoutGroups.length + 1);
    expect(withGroups.join('\n')).toContain('Engineering');
    expect(withGroups.join('\n')).toContain('Platform on-call');
    // What ends comes first and what is kept comes last, with or without Groups.
    expect(withGroups[0]).toBe(withoutGroups[0]);
    expect(withGroups.at(-1)).toBe(withoutGroups.at(-1));
  });

  it('does not present a partly read Group list as the whole of it', () => {
    const partial = teamMemberRemovalLines({
      groupNames: ['Engineering'],
      moreGroups: true,
    });
    const whole = teamMemberRemovalLines({
      groupNames: ['Engineering'],
      moreGroups: false,
    });
    expect(partial.join('\n')).toContain('Engineering');
    expect(partial).not.toEqual(whole);
  });
});

describe('resolveTeamMemberManagementChoices', () => {
  const sources = [
    { id: 'source-a', displayName: 'Acme directory' },
    { id: 'source-b', displayName: 'Contractors' },
  ];

  it('offers the source that manages the member first, then the others, then Happier', () => {
    const choices = resolveTeamMemberManagementChoices(
      teamMembershipFixture({
        management: {
          kind: 'directory_source',
          directorySourceId: 'source-b',
          label: 'Contractors',
        },
      }),
      sources,
    );
    expect(choices.selectedId).toBe('source-b');
    expect(choices.options.map((option) => option.id)).toEqual([
      'source-b',
      'source-a',
      'native',
    ]);
  });

  it('keeps the managing source as a choice even when the sources could not be read', () => {
    const choices = resolveTeamMemberManagementChoices(
      teamMembershipFixture({
        management: {
          kind: 'directory_source',
          directorySourceId: 'source-b',
          label: 'Contractors',
        },
      }),
      [],
    );
    expect(choices.selectedId).toBe('source-b');
    expect(choices.options.map((option) => option.id)).toEqual([
      'source-b',
      'native',
    ]);
    expect(choices.options[0]?.label).toBe('Contractors');
  });

  it('selects Happier for a member the Team manages itself', () => {
    const choices = resolveTeamMemberManagementChoices(
      teamMembershipFixture(),
      sources,
    );
    expect(choices.selectedId).toBe('native');
    expect(choices.options.map((option) => option.id)).toEqual([
      'source-a',
      'source-b',
      'native',
    ]);
  });
});
