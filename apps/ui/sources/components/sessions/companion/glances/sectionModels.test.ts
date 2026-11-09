import { describe, expect, it } from 'vitest';

import type { SessionScmSummary } from '@/components/sessions/sourceControl/status/statusSummary';

import {
  resolveEnvironmentSectionRows,
  resolveLinksSectionRow,
  resolveRunningSectionRows,
  GLANCE_LIST_ROWS,
  type RunningSectionAgentInput,
} from './glanceModels';

const scm = (
  overrides: Partial<SessionScmSummary> = {},
): SessionScmSummary => ({
  branch: 'relay-retry',
  upstream: 'origin/relay-retry',
  ahead: 0,
  behind: 0,
  changedFiles: 6,
  linesAdded: 312,
  linesRemoved: 87,
  hasLineChanges: true,
  hasAnyChanges: true,
  ...overrides,
});
const agent = (
  id: string,
  phase: RunningSectionAgentInput['phase'],
): RunningSectionAgentInput => ({
  id,
  title: `Agent ${id}`,
  agentId: 'claude',
  phase,
  startedAtMs: 1_000,
});
describe('Companion sections (crows B)', () => {
  it('Environment says what changed, where, on which branch, and offers Commit only while there is something to commit', () => {
    expect(
      resolveEnvironmentSectionRows({
        scm: scm(),
        machineName: 'MacBook Pro',
        folder: '~/src/happier',
      }).map((row) => row.kind),
    ).toEqual(['changes', 'place', 'branch', 'commit']);
    expect(
      resolveEnvironmentSectionRows({
        scm: scm({
          changedFiles: 0,
          linesAdded: 0,
          linesRemoved: 0,
          hasLineChanges: false,
          hasAnyChanges: false,
        }),
        machineName: 'MacBook Pro',
        folder: '~/src/happier',
      }).map((row) => row.kind),
    ).toEqual(['changes', 'place', 'branch']);
    // A folder that is not a repository has no Changes, branch or Commit rows; the place stays.
    expect(
      resolveEnvironmentSectionRows({
        scm: null,
        machineName: 'MacBook Pro',
        folder: '~/notes',
      }).map((row) => row.kind),
    ).toEqual(['place']);
    expect(
      resolveEnvironmentSectionRows({
        scm: null,
        machineName: null,
        folder: null,
      }),
    ).toEqual([]);
  });

  it('Running lists live or attention agents up to a glance\'s rows, then one "n more" for the rest', () => {
    const rows = resolveRunningSectionRows({
      agents: [agent('a', 'live'), agent('b', 'finished'), agent('c', 'attention'), agent('d', 'idle')],
    });
    // Finished and idle agents are neither rows nor overflow.
    expect(rows.agents.map((row) => row.id)).toEqual(['a', 'c']);
    expect(rows.moreAgents).toBe(0);
    // Many live agents: the glance's rows first, the remaining running items as overflow.
    const busy = resolveRunningSectionRows({
      agents: ['1', '2', '3', '4', '5'].map((id) => agent(id, 'live')),
    });
    expect(busy.agents).toHaveLength(GLANCE_LIST_ROWS);
    expect(busy.moreAgents).toBe(5 - GLANCE_LIST_ROWS);
    expect(resolveRunningSectionRows({ agents: [] })).toEqual({ agents: [], moreAgents: 0 });
  });

  it('Links offers the repository page from origin first, and nothing for a remote it cannot browse', () => {
    expect(
      resolveLinksSectionRow([
        { name: 'fork', fetchUrl: 'git@github.com:someone/happier.git' },
        { name: 'origin', fetchUrl: 'git@github.com:happier-dev/happier.git' },
      ]),
    ).toEqual({
      url: 'https://github.com/happier-dev/happier',
      path: 'happier-dev/happier',
    });
    expect(
      resolveLinksSectionRow([
        { name: 'origin', fetchUrl: '/srv/git/happier.git' },
      ]),
    ).toBeNull();
    expect(resolveLinksSectionRow([])).toBeNull();
  });
});
