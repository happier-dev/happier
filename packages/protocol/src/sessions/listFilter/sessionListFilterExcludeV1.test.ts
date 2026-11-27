import { describe, expect, it } from 'vitest';
import { matchSessionListFilterV1, normalizeSessionListFilterV1, SessionListFilterStoredReadV1Schema, SessionListFilterV1Schema } from './sessionListFilterV1.js';
import { projectSessionListFilterHomeQueriesV1 } from './sessionListFilterQueryV1.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';

describe('Session filter shared set selections', () => {
    it('projects exclusions onto their Home without dropping other Homes from paging', () => {
        const filter = normalizeSessionListFilterV1({ scope: 'all_accessible', tagIds: { include: [], exclude: [{ serverId: 'a', tagId: 'x' }] }, audiences: { include: [], exclude: [{ serverId: 'b', kind: 'outside_teams' }] } });
        const queries = projectSessionListFilterHomeQueriesV1(filter, { storage: 'active', includeInactive: true, mountedHomeServerIds: ['a', 'b'] });
        expect(queries.map(value => value.serverId)).toEqual(['a', 'b']);
        expect(queries[0].query.tagIds).toEqual({ include: [], exclude: ['x'] });
        expect(queries[1].query.tagIds).toEqual({ include: [], exclude: [] });
        expect(queries[1].query.audiences).toEqual({ include: [], exclude: [{ kind: 'outside_teams' }] });
    });
    it('excludes qualified tags only on their Home and preserves unknown facts', () => {
        const filter = normalizeSessionListFilterV1({ scope: 'all_accessible', tagIds: { include: [], exclude: [{ serverId: 'a', tagId: 'x' }] } });
        const facts = { serverId: 'a', kind: 'session' as const, startedBy: 'you' as const };
        expect(matchSessionListFilterV1(filter, { ...facts, tagIds: ['x'] })).toBe('miss');
        expect(matchSessionListFilterV1(filter, { ...facts, tagIds: [] })).toBe('match');
        expect(matchSessionListFilterV1(filter, facts)).toBe('unavailable');
        expect(matchSessionListFilterV1(filter, { ...facts, serverId: 'b' })).toBe('match');
    });
    it('upgrades stored arrays and folds the former status exclusion while refusing legacy writes', () => {
        const legacy = { ...normalizeSessionListFilterV1(), tagIds: [{ serverId: 'a', tagId: 'x' }], audiences: [], statuses: ['running'], excludedStatuses: ['failed'] };
        const read = SessionListFilterStoredReadV1Schema.parse(legacy);
        expect(read.tagIds).toEqual({ include: legacy.tagIds, exclude: [] });
        expect(read.statuses).toEqual({ include: ['running'], exclude: ['failed'] });
        expect(read).not.toHaveProperty('excludedStatuses');
        expect(SessionListFilterV1Schema.safeParse(legacy).success).toBe(false);
        expect(SessionListFilterStoredReadV1Schema.safeParse({ ...legacy, statuses: 'invalid' }).success).toBe(false);
        expect(SessionListFilterStoredReadV1Schema.parse(read)).toEqual(read);
        expect(createStoredReadSchema(SessionListFilterV1Schema).parse(legacy)).toEqual(read);
        const qualified = SessionListFilterStoredReadV1Schema.parse({ ...legacy, tagIds: [{ serverId: ' a ', tagId: ' x ' }] });
        expect(qualified.tagIds.include).toEqual([{ serverId: 'a', tagId: 'x' }]);
    });
    it('excludes audiences and statuses through the same tri-state matcher', () => {
        const base = { serverId: 'a', kind: 'session' as const, startedBy: 'you' as const };
        const filter = normalizeSessionListFilterV1({ scope: 'all_accessible', audiences: { include: [], exclude: [{ serverId: 'a', kind: 'team', teamId: 't' }] }, statuses: { include: [], exclude: ['failed'] } });
        expect(matchSessionListFilterV1(filter, { ...base, status: 'running', audiences: [{ kind: 'team', teamId: 't' }] })).toBe('miss');
        expect(matchSessionListFilterV1(filter, { ...base, status: 'failed', audiences: [] })).toBe('miss');
        expect(matchSessionListFilterV1(filter, { ...base, status: 'running', audiences: [] })).toBe('match');
    });
});
