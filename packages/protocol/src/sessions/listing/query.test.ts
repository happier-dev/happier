import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { encodeV2SessionListCursorV1, encodeV2SessionListCursorV2 } from '../control/contract.js';
import { SessionListQueryV1Schema, SessionListUnavailableQueryV1Schema } from '../../index.js';
import { buildSessionListServerQueryV1 } from './query.js';

const query = {
  v: 1,
  storage: 'active',
  includeInactive: false,
  scope: 'my_work',
  attention: 'any',
  audiences: [],
  tagIds: [],
} as const;

describe('SessionListQueryV1', () => {
  it('sends Bot-filter candidate queries without the client-only facet to supported older strict servers', () => {
    expect(buildSessionListServerQueryV1({ ...query, bot: 'bot' })).toEqual(query);
    expect(buildSessionListServerQueryV1(query)).toBe(query);
  });
  it('admits an optional client-projected Bot facet and keeps unset queries unchanged', () => {
    expect(SessionListQueryV1Schema.parse(query)).not.toHaveProperty('bot');
    expect(SessionListQueryV1Schema.parse({ ...query, bot: 'bot' }).bot).toBe('bot');
    expect(SessionListQueryV1Schema.parse({ ...query, bot: 'ordinary' }).bot).toBe('ordinary');
    expect(SessionListQueryV1Schema.safeParse({ ...query, bot: 'pinned' }).success).toBe(false);
  });
  it('initializes from its direct entrypoint before the Action catalog', () => {
    // A fresh Node graph catches cycles that a previously initialized root barrel hides.
    execFileSync(process.execPath, [
      '--import', 'tsx', '--input-type=module', '--eval',
      `const { SessionListQueryV1Schema } = await import('./query.ts');
       const parsed = SessionListQueryV1Schema.parse(${JSON.stringify(query)});
       if (parsed.scope !== 'my_work') throw new Error('Query entrypoint did not initialize');`,
    ], { cwd: fileURLToPath(new URL('.', import.meta.url)), stdio: 'pipe' });
  }, 30_000);

  it('requires explicit inactive visibility and rejects unrecognized query or audience fields', () => {
    const { includeInactive: _includeInactive, ...missingInactive } = query;
    expect(SessionListQueryV1Schema.safeParse(missingInactive).success).toBe(false);
    for (const field of ['searchQuery', 'titleQuery', 'text', 'serverId']) {
      expect(SessionListQueryV1Schema.safeParse({ ...query, [field]: 'private' }).success).toBe(false);
    }
    expect(SessionListQueryV1Schema.safeParse({
      ...query, audiences: [{ kind: 'team', teamId: 't', role: 'admin' }],
    }).success).toBe(false);
  });

  it('normalizes IDs and removes redundant child Groups without losing other selections', () => {
    expect(SessionListQueryV1Schema.parse({
      ...query,
      audiences: [
        { kind: 'group', teamId: ' t ', groupId: 'g' },
        { kind: 'team', teamId: 't' },
        { kind: 'group', teamId: 'other', groupId: ' g ' },
        { kind: 'outside_teams' },
      ],
      tagIds: [' tag '],
    })).toMatchObject({
      audiences: expect.arrayContaining([
        { kind: 'team', teamId: 't' },
        { kind: 'group', teamId: 'other', groupId: 'g' },
        { kind: 'outside_teams' },
      ]),
      tagIds: ['tag'],
    });
    expect(SessionListQueryV1Schema.parse({
      ...query, audiences: [{ kind: 'group', teamId: 't', groupId: 'g' }, { kind: 'team', teamId: 't' }],
    }).audiences).toEqual([{ kind: 'team', teamId: 't' }]);
  });

  it('rejects empty IDs and duplicate normalized selectors', () => {
    for (const patch of [
      { tagIds: [' '] },
      { tagIds: ['a', ' a '] },
      { folderIds: [' '] },
      { folderIds: ['a', ' a '] },
      { audiences: [{ kind: 'team', teamId: '' }] },
      { audiences: [{ kind: 'group', teamId: 't', groupId: ' ' }] },
      { audiences: [{ kind: 'outside_teams' }, { kind: 'outside_teams' }] },
      { audiences: [{ kind: 'team', teamId: 't' }, { kind: 'team', teamId: ' t ' }] },
    ]) {
      expect(SessionListQueryV1Schema.safeParse({ ...query, ...patch }).success).toBe(false);
    }
  });

  it('normalizes exact folder selectors while keeping omission and empty selection unfiltered', () => {
    expect(SessionListQueryV1Schema.parse({ ...query, folderIds: [' z ', 'a'] })).toMatchObject({ folderIds: ['a', 'z'] });
    expect(SessionListQueryV1Schema.parse({ ...query, folderIds: [] })).toMatchObject({ folderIds: [] });
    expect(SessionListQueryV1Schema.parse(query)).not.toHaveProperty('folderIds');
  });

  it('accepts complete canonical cursor bytes for either family and rejects combined or malformed cursors', () => {
    const cursors = [
      encodeV2SessionListCursorV1('session'),
      encodeV2SessionListCursorV2({ sessionId: 's'.repeat(600), meaningfulActivityAt: 123 }),
    ];
    for (const cursor of cursors) {
      expect(SessionListQueryV1Schema.parse({ ...query, cursor }).cursor).toBe(cursor);
      expect(SessionListQueryV1Schema.parse({ ...query, attentionCursor: cursor }).attentionCursor).toBe(cursor);
    }
    expect(SessionListQueryV1Schema.safeParse({ ...query, cursor: cursors[0], attentionCursor: cursors[1] }).success).toBe(false);
    for (const cursor of ['', 'garbage', 'cursor_v1_', 'cursor_v2_bad']) {
      expect(SessionListQueryV1Schema.safeParse({ ...query, cursor }).success).toBe(false);
    }
  });

  it('uses the V2 page range without inventing selector caps or coercing input', () => {
    const many = Array.from({ length: 120 }, (_, i) => String(i));
    const mixedAudiences = [
      ...many.slice(0, 60).map((teamId) => ({ kind: 'team' as const, teamId })),
      ...many.slice(60).map((groupId) => ({ kind: 'group' as const, teamId: `group-only-${groupId}`, groupId })),
      { kind: 'outside_teams' as const },
    ];
    const parsed = SessionListQueryV1Schema.parse({
      ...query, limit: 200, tagIds: many, audiences: mixedAudiences,
    });
    expect(parsed.tagIds).toHaveLength(120);
    expect(parsed.audiences).toHaveLength(121);
    for (const limit of [0, 201, 1.5, '50']) {
      expect(SessionListQueryV1Schema.safeParse({ ...query, limit }).success).toBe(false);
    }
    expect(SessionListQueryV1Schema.safeParse({ ...query, includeInactive: 'false' }).success).toBe(false);
  });

  it('owns the strict field-unavailable response shape', () => {
    expect(SessionListUnavailableQueryV1Schema.parse({
      error: 'not_found',
      code: 'filtered_session_listing_unavailable',
      reason: 'following',
    })).toEqual({
      error: 'not_found',
      code: 'filtered_session_listing_unavailable',
      reason: 'following',
    });
    expect(SessionListUnavailableQueryV1Schema.safeParse({ error: 'not_found' }).success).toBe(false);
    expect(SessionListUnavailableQueryV1Schema.safeParse({
      error: 'not_found',
      code: 'filtered_session_listing_unavailable',
      reason: 'feature',
    }).success).toBe(false);
  });
});
