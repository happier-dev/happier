import { describe, expect, it } from 'vitest';

import { getActionSpec } from './actionSpecs.js';

describe('session.list CLI projection', () => {
  it('projects the friendly Bot facet into the ordinary canonical query', () => {
    const spec = getActionSpec('session.list');
    const caller = spec.cli?.inputSchema?.parse({ bot: 'bot', includeInactive: true });
    expect(spec.cli?.bindInput?.(caller, { actionId: spec.id, invocationId: 'bot-list' })).toMatchObject({
      query: { bot: 'bot', scope: 'my_work', includeInactive: true, audiences: [], tagIds: [] },
    });
    expect(spec.cli?.inputSchema?.safeParse({ bot: 'pinned' }).success).toBe(false);
  });
  it('owns the nested and first-class spellings plus their CLI-only transport behavior', () => {
    const cli = getActionSpec('session.list').cli;

    expect(cli?.commands).toEqual([
      { path: ['session', 'list'], visibility: 'canonical' },
      { path: ['list'], visibility: 'alias' },
      { path: ['ls'], visibility: 'alias' },
    ]);
    expect(cli?.acceptsServerId).toBe(true);
    expect(cli?.requestTimeout).toBe('session_control');
  });

  it('projects the established scalar filters into the one canonical query', () => {
    const spec = getActionSpec('session.list');
    const caller = spec.cli?.inputSchema?.parse({
      scope: 'assigned_to_me',
      team: ['team-b', 'team-a'],
      group: ['team-c/group-b', 'team-c/group-a'],
      outsideTeams: true,
      tag: ['tag-b', 'tag-a'],
      attention: true,
      includeInactive: true,
      archivedOnly: true,
      limit: 10,
      cursor: 'cursor_v1_session-1',
      awareness: true,
    });

    expect(spec.cli?.bindInput?.(caller, { actionId: spec.id, invocationId: 'list-1' })).toEqual({
      query: {
        v: 1,
        storage: 'archived',
        includeInactive: true,
        scope: 'assigned_to_me',
        attention: 'needs_my_attention',
        audiences: [
          { kind: 'group', teamId: 'team-c', groupId: 'group-a' },
          { kind: 'group', teamId: 'team-c', groupId: 'group-b' },
          { kind: 'outside_teams' },
          { kind: 'team', teamId: 'team-a' },
          { kind: 'team', teamId: 'team-b' },
        ],
        tagIds: ['tag-a', 'tag-b'],
        cursor: 'cursor_v1_session-1',
        limit: 10,
      },
      view: 'awareness',
    });
  });

  it('retains the legacy listing fields when no canonical query selector is used', () => {
    const spec = getActionSpec('session.list');
    const caller = spec.cli?.inputSchema?.parse({
      activeOnly: true,
      includeSystem: true,
      resumableOnly: true,
      limit: 999,
      cursor: 'cursor-1',
      includeLastMessagePreview: true,
    });

    expect(spec.cli?.bindInput?.(caller, { actionId: spec.id, invocationId: 'list-2' })).toEqual({
      activeOnly: true,
      includeSystem: true,
      resumableOnly: true,
      limit: 200,
      cursor: 'cursor-1',
      includeLastMessagePreview: true,
    });
  });

  it('rejects contradictory filters and malformed group selectors before execution', () => {
    const schema = getActionSpec('session.list').cli?.inputSchema;
    expect(schema?.safeParse({ activeOnly: true, archivedOnly: true }).success).toBe(false);
    expect(schema?.safeParse({ scope: 'my_work', resumableOnly: true }).success).toBe(false);
    expect(schema?.safeParse({ cursor: 'cursor-a', attentionCursor: 'cursor-b' }).success).toBe(false);
    expect(schema?.safeParse({ team: ['team-a'], query: {
      v: 1,
      storage: 'active',
      includeInactive: false,
      scope: 'my_work',
      attention: 'any',
      audiences: [],
      tagIds: [],
    } }).success).toBe(false);
    expect(schema?.safeParse({ limit: 5, query: {
      v: 1,
      storage: 'active',
      includeInactive: false,
      scope: 'my_work',
      attention: 'any',
      audiences: [],
      tagIds: [],
    } }).success).toBe(false);
    expect(schema?.safeParse({ group: ['missing-separator'] }).success).toBe(false);
  });

});
